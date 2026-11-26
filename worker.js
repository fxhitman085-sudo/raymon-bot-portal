const {Community}=require('./community');
const fs=require('node:fs/promises');
const path=require('node:path');
const settings=require('./bot-settings');
const galleryByDb=new WeakMap();
const {randomInt}=require('node:crypto');

const PAIR_CODE_WAIT=75_000;
const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function samePhone(jid,phone){
  return typeof jid==='string'&&jid.split('@')[1]==='s.whatsapp.net'&&jid.split('@')[0].split(':')[0]===phone.slice(1);
}
class Worker {
  constructor({root,fetcher=fetch,url,token,createBot,clock=Date.now}){
    this.root=root;
    this.fetcher=fetcher;
    this.url=new URL('/internal/sync',url);
    this.token=token;
    this.createBot=createBot;
    this.clock=clock;
    this.entries=new Map();
    this.authorizedUntil=0;
    this.community=new Community({root,clock});
  }
  async tick(){
    const now=this.clock();
    const reports=[...this.entries.values()].map(e=>{
      const code=e.task.intent==='pair'&&e.task.pairUntil>now&&e.bot?.sock===e.codeSocket&&
        !e.bot?.socketClosed?e.code:null;
      const noCode=e.task.intent==='pair'&&!e.codeIssued&&!e.verified&&now-e.started>=PAIR_CODE_WAIT;
      return {id:e.task.id,generation:e.task.generation,restart:e.task.restart,
        status:e.failure||(noCode?'pair_no_code':e.verified&&e.bot?.connected?'online':code?'code':'connecting'),
        ...(e.communityResult?{community:e.communityResult}:{}),
        ...(code?{code}:{}),...(e.groupResult?{groups:e.groupResult}:{}),...(e.bot?.portalUpdates&&!e.failure?{settings:{
          appliedRevision:e.bot.db.get('portal.settingsRevision'),values:settings.read(e.bot)
        }}:{})};
    });
    try{
      const response=await this.fetcher(this.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},
        body:JSON.stringify({reports}),signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw new Error('Control plane unavailable');
      const {deployments}=await response.json();
      if(!Array.isArray(deployments)||deployments.length>30)throw new Error('Invalid control response');
      const tasks=new Map();
      for(const d of deployments){
        if(!validId(d?.id)||!validId(d.generation)||!/^\+[1-9][0-9]{7,14}$/.test(d.phone)||
          !['pair','run'].includes(d.intent)||!Number.isFinite(d.permitUntil)||!Number.isFinite(d.pairUntil))throw new Error('Invalid deployment');
        tasks.set(d.id,d);
      }
      this.authorizedUntil=this.clock()+12_000;
      if(this.closed)return;
      for(const [id,entry] of this.entries){
        const task=tasks.get(id);
        if(!task||task.generation!==entry.task.generation||task.restart!==entry.task.restart||entry.failure)await this.stopEntry(id,entry);
      }
      for(const task of tasks.values()){
        if(this.closed)return;
        const entry=this.entries.get(task.id);
        if(entry){
          if(entry.bot?.portalUpdates&&task.settings)settings.apply(entry.bot,task.settings);
          if(entry.menuRevision!==task.menuRevision&&!entry.menuLoading)this.loadMenu(entry,task.menuRevision??null);
          entry.task=task;
          if(task.recruitment&&!entry.recruiting&&entry.bot?.connected&&entry.bot.canProcessMessages?.())
            entry.recruiting=this.recruitNotice(entry,task).catch(()=>console.warn('Recruitment notification pending')).finally(()=>{entry.recruiting=null;});
          if(task.summons?.length&&!entry.mailing&&entry.bot?.connected&&entry.bot.canProcessMessages?.()){
            entry.mailing=this.deliverSummons(entry).catch(()=>console.warn('Support delivery pending')).finally(()=>{entry.mailing=null;});
          }
          this.community.run(entry,()=>!this.closed&&this.entries.get(task.id)===entry&&
            entry.verified&&!entry.failure&&entry.bot?.connected&&!entry.bot.socketClosed&&
            this.clock()<Math.min(entry.task.permitUntil,this.authorizedUntil));
          if(task.groups)this.groupSettings(entry,task.groups);
          else entry.groupResult=null;
          if(task.intent==='run')entry.code=null;
        }else await this.startEntry(task);
      }
    }catch{
      if(this.authorizedUntil<=this.clock()){
        for(const [id,entry] of this.entries)await this.stopEntry(id,entry);
      }
      throw new Error('Portal control connection unavailable');
    }
  }
  async recruitNotice(entry,task){
    const {id,round}=task.recruitment;
    const receipt=async state=>{
      const res=await this.fetcher(new URL('/internal/recruitment',this.url),{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({deployment:task.id,generation:task.generation,id,state}),signal:AbortSignal.timeout(5000)});
      if(!res.ok)throw Error('Recruitment acknowledgment unavailable');
      return (await res.json()).ok;
    };
    const bot=entry.bot;
    if(!bot.portalUpdates?.preference())return receipt('Opted out');
    if(!await receipt('claim'))return;
    let image;
    try{image=await fs.readFile(path.join(__dirname,'bot-runtime/assets/announcements.jpg'));}catch{return receipt('Failed');}
    if(!bot.canProcessMessages()||!bot.connected)return receipt('Failed');
    if(!bot.portalUpdates.preference())return receipt('Opted out');
    try{
      await bot.sock.sendMessage(task.phone.slice(1)+'@s.whatsapp.net',{image,caption:'RAYMON BOT admin recruitment is open. Apply for round '+round+' through Community → Apply for Admin. '+task.applicationUrl},{messageId:id.replaceAll('-','').toUpperCase()});
    }catch(error){return receipt(error?.output?.statusCode===429?'Failed':'Unconfirmed');}
    await receipt('Sent');
  }
  async supportEvent(entry,event){
    const response=await this.fetcher(new URL('/internal/summons',this.url),{
      method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
      body:JSON.stringify({deployment:entry.task.id,generation:entry.task.generation,...event}),signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw Error('Support request could not be processed.');
  }
  async deliverSummons(entry){
    for(const job of entry.task.summons){
      if(!entry.bot.canProcessMessages()||!entry.bot.connected)return;
      const jid=job.recipient.slice(1)+'@s.whatsapp.net';
      await entry.bot.sock.sendMessage(jid,{text:job.body},{messageId:job.id});
      await this.supportEvent(entry,{ack:job.id});
    }
  }
  async supportMessage(entry,m,sock){
    const jid=m.key?.remoteJid,own=entry.task.phone;
    if(!jid||!m.key.id||!/@(s\.whatsapp\.net|lid)$/.test(jid))return false;
    const norm=j=>String(j||'').replace(/:\d+@/,'@');
    const self=m.key.fromMe&&[sock.user?.id,sock.user?.lid,own.slice(1)+'@s.whatsapp.net'].some(j=>norm(j)===norm(jid));
    if(!self&&(own!==require('./community').ADMIN||m.key.fromMe))return false;
    const msg=m.message||{},content=msg.extendedTextMessage||msg.imageMessage;
    const quote=content?.contextInfo?.stanzaId;
    const text=msg.conversation||content?.text||content?.caption||(msg.imageMessage?'Screenshot':'');
    if(!(self&&/^\.admin\s+help(?:\s|$)/i.test(text))&&!/^52A1[A-F0-9]{24}$/.test(quote||''))return false;
    let peer=own;
    if(!self){
      let pn=[jid,m.key.remoteJidAlt].find(j=>j?.endsWith('@s.whatsapp.net'));
      if(!pn)pn=await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if(!pn?.endsWith('@s.whatsapp.net'))return false;
      peer='+'+norm(pn).split('@')[0];
    }
    let image;
    if(msg.imageMessage){
      const chunks=[];let size=0;
      const stream=await require('@whiskeysockets/baileys').downloadContentFromMessage(msg.imageMessage,'image');
      for await(const chunk of stream){
        size+=chunk.length;
        if(size>3*1024*1024)throw Error('Screenshot exceeds 3 MB.');
        chunks.push(chunk);
      }
      image=Buffer.concat(chunks).toString('base64');
    }
    await this.supportEvent(entry,{mid:m.key.id,quote,text,peer,image});
    return true;
  }
  groupSettings(entry,task){
    if(entry.groupRunning||entry.groupResult?.token===task.token||!validId(task.token))return;
    const bot=entry.bot,sock=bot?.sock;
    const active=()=>bot?.canProcessMessages?.()&&bot.connected&&sock===bot.sock&&!bot.socketClosed&&this.clock()<task.expires;
    if(!active())return;
    entry.groupRunning=(async()=>{
      let timer;
      const fetchGroup=promise=>Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('WhatsApp group request timed out')),6000);
      })]);
      const normalize=require('@whiskeysockets/baileys').jidNormalizedUser;
      const aliases=new Set([sock.user?.id,sock.user?.lid,bot.authState?.creds?.me?.lid].filter(Boolean).map(normalize));
      const admin=group=>group?.participants?.some(p=>['admin','superadmin'].includes(p.admin)&&
        [p.id,p.lid,p.phoneNumber,p.jid].filter(Boolean).some(id=>aliases.has(normalize(id))));
      try{
        if(task.action==='list'){
          const all=await fetchGroup(sock.groupFetchAllParticipating());
          if(!active())throw Error('Bot disconnected');
          const groups=Object.values(all).filter(group=>settings.groupId(group.id)&&admin(group)).slice(0,60).map(group=>{
            const saved=bot.db.group(group.id);
            return {id:group.id,name:String(group.subject||group.id).slice(0,120),
              welcome:!!saved.welcome,goodbye:!!saved.goodbye,rules:String(saved.rules||'').slice(0,1500)};
          });
          entry.groupResult={token:task.token,groups};
        }else if(task.action==='save'&&settings.groupId(task.group)){
          const group=await fetchGroup(sock.groupMetadata(task.group));
          if(!active()||!admin(group))throw Error('Group administrator access required');
          bot.db.setGroup(task.group,{...bot.db.group(task.group),...settings.groupOptions(task.values)});
          entry.groupResult={token:task.token};
        }else throw Error('Invalid group settings request');
      }catch{
        entry.groupResult={token:task.token,error:true};
      }finally{clearTimeout(timer);}
    })().catch(()=>{entry.groupResult={token:task.token,error:true};}).finally(()=>{entry.groupRunning=null;});
  }
  loadMenu(entry,revision){
    entry.menuLoading=(async()=>{
      if(!revision){
        if(entry.bot?.db)galleryByDb.delete(entry.bot.db);
        entry.menuRevision=null;return;
      }
      const url=new URL('/internal/menu/'+entry.task.id,this.url);
      const response=await this.fetcher(url,{
        method:'GET',headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(9000)
      });
      if(!response.ok)throw Error('Menu settings unavailable');
      const menu=await response.json();
      if(this.entries.get(entry.task.id)!==entry||!entry.bot?.db)return;
      if(!menu.enabled||!Array.isArray(menu.images)||!menu.images.length){
        galleryByDb.delete(entry.bot.db);
      }else{
        const images=menu.images.slice(0,10).filter(b64=>typeof b64==='string'&&b64.length<=1_500_000)
          .map(b64=>Buffer.from(b64,'base64')).filter(bytes=>bytes.length&&bytes.length<=1024*1024);
        if(images.length)galleryByDb.set(entry.bot.db,{mode:menu.mode,images,index:0});
        else galleryByDb.delete(entry.bot.db);
      }
      entry.menuRevision=revision;
    })().catch(()=>{console.warn('Could not refresh menu gallery; previous menu remains available.');})
      .finally(()=>{entry.menuLoading=null;});
  }
  async startEntry(task){
    const dir=path.join(this.root,task.id);
    const authDir=path.join(dir,'auth-'+task.generation);
    const entry={task,verified:false,code:null,codeIssued:false,started:this.clock()};
    this.entries.set(task.id,entry);
    try{
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      if(task.intent==='run'){
        const creds=JSON.parse(await fs.readFile(path.join(authDir,'creds.json'),'utf8'));
        if(!creds.registered||!samePhone(creds.me?.id,task.phone)){
          entry.failure='needs_pairing';
          return;
        }
      }
      const {bot,close}=await this.createBot({dir,authDir,phone:task.phone,id:task.id});
      bot.sessions??={};
      bot.sessions.onlineAdmins=async()=>{
        const response=await this.fetcher(new URL('/internal/online-admins',this.url),{
          headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(4000)
        });
        if(!response.ok)throw Error('Staff directory unavailable');
        return (await response.json()).admins;
      };
      entry.bot=bot;
      entry.close=close;
      const allowed=()=>!this.closed&&this.entries.get(task.id)===entry&&entry.verified&&!entry.failure&&
        this.clock()<Math.min(entry.task.permitUntil,this.authorizedUntil);
      bot.canProcessMessages=allowed;
      for(const name of ['onMessages','onParticipants','handleStatus']){
        if(typeof bot[name]!=='function')continue;
        const handle=bot[name].bind(bot);
        bot[name]=async(...args)=>allowed()?handle(...args):undefined;
      }
      if(typeof bot.onMessages==='function'){
        const handle=bot.onMessages.bind(bot);
        bot.onMessages=async(batch,sock)=>{
          if(batch?.type!=='notify'||!allowed())return handle(batch,sock);
          const remaining=[];
          for(const m of batch.messages){
            try{if(!await this.supportMessage(entry,m,sock))remaining.push(m);}
            catch{console.warn('Support event failed');await sock.sendMessage(m.key.remoteJid,{text:'Support could not receive that message. Please retry or open your case in the portal.'}).catch(()=>{});}
          }
          if(remaining.length)return handle({...batch,messages:remaining},sock);
        };
      }
      if(bot.portalUpdates&&task.settings)settings.apply(bot,task.settings);
      bot.onPairCode=async code=>{
        if(entry.task.intent==='pair'&&entry.task.pairUntil>this.clock()&&bot.sock&&!bot.socketClosed){
          const normalized=String(code);
          if(!/^[a-z0-9]{8}$/i.test(normalized)){entry.failure='pair_failed';return;}
          entry.code=normalized;
          entry.codeIssued=true;
          entry.codeSocket=bot.sock;
        }
      };
      bot.onConnected=async()=>{
        const own=bot.authState?.creds?.me?.id||bot.sock?.user?.id;
        entry.verified=samePhone(own,task.phone);
        entry.code=null;
        if(!entry.verified)entry.failure=entry.task.intent==='pair'?'pair_failed':'needs_pairing';
      };
      bot.onLoggedOut=async()=>{entry.failure='needs_pairing';entry.code=null;};
      bot.onPairError=async()=>{entry.failure='pair_failed';entry.code=null;};
      await bot.start();
      if(bot.loggedOut)entry.failure='needs_pairing';
    }catch{
      entry.failure=task.intent==='pair'?'pair_failed':'needs_pairing';
    }
  }
  async stopEntry(id,entry){
    this.entries.delete(id);
    try{await entry.bot?.stop();}catch{console.warn('Could not close a portal bot normally.');}
    if(entry.bot?.db)galleryByDb.delete(entry.bot.db);
    try{await entry.close?.();}catch{console.warn('Could not close a portal bot database normally.');}
  }
  async stop(){
    this.closed=true;
    for(const [id,entry] of this.entries)await this.stopEntry(id,entry);
  }
}

async function createRuntimeBot({dir,authDir,phone,id}){
  const config=require('./bot-runtime/config');
  const {RaymonBot}=require('./bot-runtime/lib/bot');
  const {Database}=require('./bot-runtime/lib/database');
  const {UpdateAlerts}=require('./bot-runtime/lib/updates');
  const {commandMap}=require('./bot-runtime/lib/commands');
  const pilotNumber=process.env.SOUNDSTICKER_PILOT_NUMBER;
  if(pilotNumber&&/^\d{8,15}$/.test(pilotNumber)){
    const {createSoundSticker}=require('./soundsticker');
    commandMap.set('soundsticker',createSoundSticker(require('./bot-runtime/commands/media').mediaHelpers,pilotNumber));
  }
  const currentMenu=commandMap.get('menu');
  if(currentMenu?.execute&&!currentMenu.__portalV5Gallery){
    commandMap.set('menu',{...currentMenu,__portalV5Gallery:true,async execute(ctx,args){
      const gallery=ctx.db&&galleryByDb.get(ctx.db);
      if(!gallery?.images?.length||!ctx.sock?.sendMessage)return currentMenu.execute(ctx,args);
      const jid=(typeof ctx.chat==='string'&&ctx.chat)||(ctx.msg||ctx.message)?.key?.remoteJid;
      if(typeof jid!=='string'||!jid)return currentMenu.execute(ctx,args);
      const image=gallery.mode==='random'?gallery.images[randomInt(gallery.images.length)]:
        gallery.images[gallery.mode==='fixed'?0:gallery.index++%gallery.images.length];
      const {helpText}=require('./bot-runtime/lib/commands');
      const prefix=ctx.prefix||ctx.config?.prefix||'.';
      const caption=[
        '*RAYMON BOT — COMMAND MENU*',
        helpText('',{...ctx,prefix}),
        'Use '+prefix+'help <command> for details.'
      ].join('\\n\\n');
      try{
        if(caption.length<=950){
          await ctx.sock.sendMessage(jid,{image,caption});
        }else{
          await ctx.sock.sendMessage(jid,{image,caption:'RAYMON BOT — COMMAND MENU'});
          for(let i=0;i<caption.length;i+=3500)
            await ctx.sock.sendMessage(jid,{text:caption.slice(i,i+3500)});
        }
        return {ok:true,sent:true};
      }catch{
        return currentMenu.execute(ctx,args);
      }
    }});
  }
  commandMap.set('admin',{name:'admin',category:'General',description:'List online portal administrators',usage:'.admin',allowPrivate:true,
    async execute(ctx){
      try{
        const members=await ctx.sessions.onlineAdmins();
        const lines=members.map(({name,rank,phone},i)=>{
          const role=rank===8?'Founder':'[Level '+rank+'] '+(rank===7?'Chief Admin':rank>=5?'Senior Admin':'Admin');
          return (i+1)+'. '+name.replace(/[\r\n]+/g,' ')+' → '+role+(phone?' · '+phone:'');
        });
        return {ok:true,message:lines.length?'⚡ RAYMON BOT · Online Admins\n\n'+lines.join('\n'):'No admins are online right now.'};
      }catch{return {ok:false,message:'The staff directory is unavailable. Please try again shortly.'};}
    }
  });
  const announce=commandMap.get('announce');
  if(announce?.mainOwnerOnly)commandMap.set('announce',{
    ...announce,
    mainOwnerOnly:false,
    execute:()=>({ok:false,message:'Use .announce on the main RAYMON BOT hosted on Bot-Hosting.net. Website-deployed bots manage their own WhatsApp account.'})
  });
  for(const command of [...require('./bot-runtime/commands/account'),...require('./bot-runtime/commands/away')]){
    if(!commandMap.has(command.name))commandMap.set(command.name,command);
  }
  if(!commandMap.has('prefix'))commandMap.set('prefix',{
    name:'prefix',description:'Change your command prefix',usage:'.prefix !',category:'Owner controls',ownerOnly:true,
    async execute(ctx,args){
      if(!args.length)return {ok:true,message:'Current prefix: '+ctx.config.prefix};
      try{
        if(args.length!==1)throw Error();
        const {prefix}=settings.validate({prefix:args[0]});
        ctx.db.set('prefix',prefix);
        return {ok:true,message:'Command prefix set to '+prefix};
      }catch{return {ok:false,message:'Use 1–4 punctuation characters for the prefix.'};}
    }
  });
  const {forwardAvailableMedia,remember,diag}=require('./vv');
  const vvCmd=commandMap.get('vv');
  commandMap.set('vv',{...(vvCmd||{name:'vv',description:'Save quoted media to your DM',usage:'.vv',category:'Tools'}),name:'vv',execute:(ctx,args)=>forwardAvailableMedia(ctx,args)});
  const db=await new Database(path.join(dir,'raymon.sqlite')).init();
  // The web deployment begins in private mode and never receives host-wide commands.
  if(!db.get('release.public-status-v1',false))db.set('release.public-status-v1',true);
  const bot=new RaymonBot({...config,ownerNumber:phone.slice(1),pairingNumber:phone.slice(1),
    get prefix(){return db.get('prefix',config.prefix);},
    dataDir:dir,authDir,tempDir:path.join(dir,'tmp'),sessionLabel:'portal-'+id.slice(0,8),maxMediaBytes:16*1024*1024},db);
  const hook=()=>{
    const sock=bot.sock;
    if(sock?.ev&&!sock.__vvHooked){
      sock.__vvHooked=true;
      sock.ev.on('messages.upsert',({messages})=>{for(const m of messages)remember(m,bot);});
    }
  };
  hook();
  const vvTimer=setInterval(hook,1000);
  const sessions={primary:bot,sessions:new Map(),handlesSender:()=>false};
  const updates=new UpdateAlerts(sessions,db);
  const route=updates.route.bind(updates);
  updates.route=account=>bot.canProcessMessages?.()?route(account):null;
  const owner=phone.slice(1)+'@s.whatsapp.net';
  const ownerRecord=()=>updates.store.users().find(user=>user.aliases.includes(owner));
  function registerOwner(){
    return updates.store.register([owner,bot.sock?.user?.lid,bot.authState?.creds?.me?.lid],authDir);
  }
  bot.portalUpdates={
    preference:()=>ownerRecord()?.enabled??true,
    setPreference(enabled){
      const user=registerOwner();
      updates.store.preference(user.jid,enabled);
      updates.wake();
    }
  };
  sessions.updates={
    connected(){
      if(!samePhone(bot.authState?.creds?.me?.id||bot.sock?.user?.id,phone))return;
      registerOwner();
      updates.wake();
    },
    settings(ctx,enabled){
      if(!ctx.isOwner)throw Error('Only the linked owner can change this preference.');
      if(typeof enabled==='boolean')bot.portalUpdates.setPreference(enabled);
      return {enabled:bot.portalUpdates.preference()};
    }
  };
  bot.sessions=sessions;
  return {bot,close:async()=>{clearInterval(vvTimer);await updates.stop();db.close();}};
}

function startWorker({root,url,token}){
  if(!token||token.length<32||!url)throw new Error('Set WORKER_TOKEN and PORTAL_INTERNAL_URL.');
  const worker=new Worker({root,url,token,createBot:createRuntimeBot});
  let timer,running,stopping=false,lastWarning=0,ready=false;
  function schedule(){
    if(stopping)return;
    running=worker.tick().then(()=>{
      if(!ready){ready=true;console.log('Portal pairing worker connected to the portal.');}
    }).catch(()=>{
      ready=false;
      if(Date.now()-lastWarning>30_000){lastWarning=Date.now();console.warn('Portal worker is retrying the control connection.');}
    }).finally(()=>{if(!stopping)timer=setTimeout(schedule,2000);});
  }
  async function stop(){
    if(stopping)return;
    stopping=true;
    clearTimeout(timer);
    worker.closed=true;
    await running;
    await worker.stop();
  }
  schedule();
  return stop;
}

if(require.main===module){
  process.umask(0o077);
  const stop=startWorker({root:path.resolve(process.env.WORKER_DATA_DIR||'./data/worker'),
    url:process.env.PORTAL_INTERNAL_URL,token:process.env.WORKER_TOKEN});
  process.once('SIGTERM',()=>void stop());
  process.once('SIGINT',()=>void stop());
}
module.exports={Worker,samePhone,startWorker,createRuntimeBot};

