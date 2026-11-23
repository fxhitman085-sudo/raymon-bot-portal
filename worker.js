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
        await ctx.sock.sendMessage(jid,{image,caption});
        return {ok:true,sent:true};
      }catch{
        return currentMenu.execute(ctx,args);
      }
    }});
  }
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

