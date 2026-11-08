const fs=require('node:fs/promises');
const path=require('node:path');

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
  }
  async tick(){
    const reports=[...this.entries.values()].map(e=>({
      id:e.task.id,generation:e.task.generation,
      status:e.failure||(e.verified&&e.bot?.connected?'online':e.code?'code':'connecting'),
      ...(e.code?{code:e.code}:{})
    }));
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
        if(!task||task.generation!==entry.task.generation||entry.failure)await this.stopEntry(id,entry);
      }
      for(const task of tasks.values()){
        if(this.closed)return;
        const entry=this.entries.get(task.id);
        if(entry){
          entry.task=task;
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
  async startEntry(task){
    const dir=path.join(this.root,task.id);
    const authDir=path.join(dir,'auth-'+task.generation);
    const entry={task,verified:false,code:null};
    this.entries.set(task.id,entry);
    try{
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      if(task.intent==='pair'){
        // Only this portal deployment's superseded auth attempts are cleaned up.
        const files=await fs.readdir(dir);
        for(const name of files)if(/^auth-[0-9a-f-]{36}$/.test(name)&&name!=='auth-'+task.generation)
          await fs.rm(path.join(dir,name),{recursive:true,force:true});
      }else{
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
      bot.onPairCode=async code=>{
        if(entry.task.intent==='pair'&&entry.task.pairUntil>this.clock())entry.code=String(code);
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
    try{entry.close?.();}catch{console.warn('Could not close a portal bot database normally.');}
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
  const db=await new Database(path.join(dir,'raymon.sqlite')).init();
  // The web deployment begins in private mode and never receives host-wide commands.
  if(!db.get('release.public-status-v1',false))db.set('release.public-status-v1',true);
  const bot=new RaymonBot({...config,ownerNumber:phone.slice(1),pairingNumber:phone.slice(1),
    dataDir:dir,authDir,tempDir:path.join(dir,'tmp'),sessionLabel:'portal-'+id.slice(0,8),maxMediaBytes:16*1024*1024},db);
  return {bot,close:()=>db.close()};
}

if(require.main===module){
  process.umask(0o077);
  const token=process.env.WORKER_TOKEN;
  if(!token||token.length<32||!process.env.PORTAL_INTERNAL_URL)throw new Error('Set WORKER_TOKEN and PORTAL_INTERNAL_URL.');
  const worker=new Worker({root:path.resolve(process.env.WORKER_DATA_DIR||'./data/worker'),
    url:process.env.PORTAL_INTERNAL_URL,token,createBot:createRuntimeBot});
  let timer,running,stopping=false,lastWarning=0;
  function schedule(){
    if(stopping)return;
    running=worker.tick().catch(()=>{
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
  process.once('SIGTERM',()=>void stop());
  process.once('SIGINT',()=>void stop());
  schedule();
}
module.exports={Worker,samePhone};
