const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {isIP}=require('node:net');
const {Store,PortalError,OWNER_EMAIL}=require('./store');
const {startWorker}=require('./worker');
const derive=promisify(scrypt);
const kdf={N:32768,r:8,p:3,maxmem:40*1024*1024};
const dummySalt=randomBytes(16).toString('hex');

const random=()=>randomBytes(32).toString('base64url');
const staticFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],['/raymon-brand.jpg',['bot-runtime/assets/announcements.jpg','image/jpeg']]]);
const equal=(left,right)=>typeof left==='string'&&typeof right==='string'&&Buffer.byteLength(left)===Buffer.byteLength(right)&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
const cookieValue=(req,name)=>req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1);
const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
function emailAddress(value){
  if(typeof value!=='string'||value.length>254)return null;
  const email=value.trim().toLowerCase();
  if(!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email))return null;
  const [local,host]=email.split('@');
  if(local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..'))return null;
  if(!['gmail.com','googlemail.com'].includes(host))return email;
  const mailbox=local.split('+')[0].replace(/\./g,'');
  return /^[a-z0-9]+$/.test(mailbox)?mailbox+'@gmail.com':null;
}
function optionalUsername(value){
  if(value===undefined)return undefined;
  const username=typeof value==='string'?value.trim().toLowerCase():'';
  if(!/^[a-z0-9_]{3,24}$/.test(username))throw new PortalError(400,'Use 3–24 letters, numbers, or underscores for your username.');
  return username;
}
function publicUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}
function createMailer(apiKey,from){
  if(!apiKey||!from)return null;
  return async({to,subject,text,id})=>{
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',signal:AbortSignal.timeout(10_000),
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json',...(id?{'Idempotency-Key':id}:{})},
      body:JSON.stringify({from,to:[to],subject,text})
    });
    if(!response.ok)throw new Error('Email provider rejected delivery.');
  };
}
function startRenewalNotices(store,sendMail,origin){
  let active,stopping=false;
  async function deliver(){
    for(const notice of store.pendingRenewalNotices()){
      if(stopping)break;
      const {id,phone,paid_until:paidUntil,email}=notice;
      try{
        await sendMail({to:email,subject:'RAYMON BOT needs coins before renewal',id:'renewal/'+id+'/'+paidUntil,
          text:'Your bot for '+phone+' needs 10 coins to renew. Its current time ends at '+new Date(paidUntil).toUTCString()+
            '. Each bot renews from your shared balance. View your balance and local renewal times at '+origin+'/'});
        store.markRenewalNotice(id,paidUntil);
      }catch{console.error('Could not send a low-balance email. Will retry.');}
    }
  }
  function tick(){
    if(!active)active=deliver().catch(()=>console.error('Could not check renewal notices.')).finally(()=>{active=null;});
  }
  const timer=setInterval(tick,60_000);
  timer.unref();
  tick();
  return async()=>{stopping=true;clearInterval(timer);await active;};
}
function newPassword(value){
  if(typeof value!=='string'||value.length<12||value.length>128)
    throw new PortalError(400,'Choose a password with 12 to 128 characters.');
  return value;
}
async function digest(password,salt=randomBytes(16).toString('hex')){
  const key=await derive(password,Buffer.from(salt,'hex'),64,kdf);
  return salt+':'+key.toString('hex');
}
async function body(req,limit=32768){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new PortalError(415,'Expected JSON.');
  const parts=[];let size=0;
  for await(const part of req){
    size+=part.length;
    if(size>limit)throw new PortalError(413,'Request too large.');
    parts.push(part);
  }
  try{return JSON.parse(Buffer.concat(parts));}catch{throw new PortalError(400,'Invalid JSON.');}
}

function createServer({store,origin,workerToken,ownerSignupToken,railwayProxy=false,sendMail=null,links={}}){
  const base=new URL(origin), secure=base.protocol==='https:';
  if(!secure&&!['localhost','127.0.0.1'].includes(base.hostname))throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  if(base.origin!==origin)throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
  if(!workerToken||workerToken.length<32)throw new Error('Set WORKER_TOKEN to a strong shared secret of at least 32 characters.');
  const sessionName=secure?'__Host-raymon':'raymon';
  const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const attempts=new Map();
  let running=0,nextSweep=0;
  function rateLimit(req,email,action){
    const now=Date.now();
    if(now>=nextSweep){
      for(const [key,entry] of attempts)if(entry.until<=now)attempts.delete(key);
      nextSweep=now+60_000;
    }
    const forwarded=String(req.headers['x-real-ip']||'').trim();
    const ip=railwayProxy&&isIP(forwarded)?forwarded:req.socket.remoteAddress;
    for(const [key,limit] of [['ip:'+ip,30],[action+':'+email,action==='forgot-password'?4:8]]){
      let entry=attempts.get(key);
      if(!entry||entry.until<=now){
        if(attempts.size>=10_000)throw new PortalError(429,'Too many requests. Try again later.');
        entry={count:0,until:now+15*60_000};attempts.set(key,entry);
      }
      if(entry.count>=limit)throw new PortalError(429,'Too many attempts. Try again in a few minutes.');
      entry.count++;
    }
  }
  async function passwordWork(password,salt){
    if(running>=2)throw new PortalError(429,'Sign-in is busy. Try again shortly.');
    running++;
    try{return await digest(password,salt);}finally{running--;}
  }
  function finishAuth(res,session,user,status,remember=true){
    const token=random();
    store.logout(session);
    store.putSession(user.id,token);
    res.setHeader('Set-Cookie',remember?cookie(sessionName,token,604800):cookie(sessionName,token,604800).replace('; Max-Age=604800',''));
    return json(res,status,store.dashboard(user));
  }
  async function reauthenticate(req,user,password,kind){
    rateLimit(req,user.id,kind);
    const email=emailAddress(user.email),saved=email&&store.password(email);
    if(typeof password!=='string'||password.length>128)throw new PortalError(401,'Current password is incorrect.');
    const encoded=await passwordWork(password,saved?.digest.split(':')[0]||dummySalt);
    if(saved?.user_id!==user.id||!equal(encoded,saved.digest))throw new PortalError(401,'Current password is incorrect.');
    return {email,digest:saved.digest};
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,origin);
      const method=req.method, route=url.pathname;
      if(method==='GET'&&staticFiles.has(route)){
        const [file,type]=staticFiles.get(route);
        if(file.endsWith('.jpg'))res.setHeader('Cache-Control','public, max-age=86400');
        res.writeHead(200,{'Content-Type':type});
        res.end(fs.readFileSync(path.join(__dirname,file)));
        return;
      }
      if(method==='GET'&&route==='/health')return json(res,200,{ok:true});
      if(method==='GET'&&route==='/version'){
        const {repository,commit}=require('./bot-runtime-version.json');
        return json(res,200,{repository,commit});
      }
      if(method==='POST'&&route==='/internal/sync'){
        if(!equal(req.headers.authorization,'Bearer '+workerToken))throw new PortalError(403,'Worker access required.');
        const data=await body(req,5*1024*1024);
        if(!Array.isArray(data?.reports)||data.reports.length>store.maxBots)throw new PortalError(400,'Invalid worker reports.');
        return json(res,200,{deployments:store.sync(data.reports)});
      }
      if(!route.startsWith('/api/'))throw new PortalError(404,'Page not found.');
      const session=cookieValue(req,sessionName);
      const user=store.session(session);
      if(method==='GET'&&route==='/api/me')return json(res,200,user?store.dashboard(user):{user:null,recoveryAvailable:!!sendMail});
      if(method==='GET'&&route==='/api/community')return json(res,200,{
        announcements:store.announcements(),community:publicUrl(links.community),support:publicUrl(links.support)});
      if(method==='POST'&&req.headers.origin!==origin)throw new PortalError(403,'Request origin not allowed.');
      if(method==='POST'&&route==='/api/auth/forgot-password'){
        if(!sendMail)throw new PortalError(503,'Password recovery email is not configured. Contact the portal owner.');
        const data=await body(req), email=emailAddress(data?.email);
        if(!email)throw new PortalError(400,'Enter a valid email address.');
        rateLimit(req,email,'forgot-password');
        const token=random();
        if(store.issuePasswordReset(email,token)){
          const link=new URL('/',origin);
          link.hash='reset='+token;
          void Promise.resolve().then(()=>sendMail({to:email,subject:'Reset your RAYMON BOT password',
            text:'Open this link within 30 minutes to choose a new password. If you did not request this, ignore this email.\n\n'+link.href
          })).catch(()=>console.error('Could not send a password recovery email.'));
        }
        return json(res,202,{ok:true});
      }
      if(method==='POST'&&route==='/api/auth/reset-password'){
        const data=await body(req);
        const reset=store.passwordReset(data?.token);
        rateLimit(req,reset?.email||'', 'reset-password');
        if(!reset)throw new PortalError(400,'This reset link is invalid or expired. Request a new one.');
        store.resetPassword(data.token,await passwordWork(newPassword(data.password)));
        res.setHeader('Set-Cookie',cookie(sessionName,'',0));
        return json(res,200,{ok:true});
      }
      if(method==='POST'&&['/api/auth/register','/api/auth/login'].includes(route)){
        const data=await body(req);
        const registering=route.endsWith('/register');
        const identifier=typeof data?.email==='string'?data.email.trim().toLowerCase():'';
        const email=emailAddress(identifier)||(!registering&&/^[a-z0-9_]{3,24}$/.test(identifier)?store.loginEmail(identifier):null);
        if(!email&&(registering||!identifier||identifier.length>254))throw new PortalError(400,'Enter a valid email address.');
        rateLimit(req,email||identifier,registering?'register':'login');
        if(registering){
          const name=typeof data.name==='string'?data.name.trim().slice(0,90):'';
          if(!name)throw new PortalError(400,'Enter your name.');
          const ownerAuthorized=typeof ownerSignupToken==='string'&&ownerSignupToken.length>=32&&equal(data.ownerToken,ownerSignupToken);
          if(email===OWNER_EMAIL&&!ownerAuthorized)throw new PortalError(403,'Enter the owner setup token to create this account.');
          const username=optionalUsername(data.username);
          const referral=typeof data.referral==='string'&&/^[a-f0-9]{16}$/.test(data.referral)?data.referral:null;
          if(data.confirmation!==undefined&&data.confirmation!==data.password)throw new PortalError(400,'Passwords do not match.');
          const encoded=await passwordWork(newPassword(data.password));
          return finishAuth(res,session,store.register({email,name,digest:encoded,ownerAuthorized,username,referral}),201);
        }
        const password=data?.password;
        if(typeof password!=='string'||password.length>128)throw new PortalError(401,'Email or password is incorrect.');
        const saved=email&&store.password(email);
        const encoded=await passwordWork(password,saved?.digest.split(':')[0]||dummySalt);
        if(!saved||!equal(encoded,saved.digest)||store.password(email)?.digest!==saved.digest)
          throw new PortalError(401,'Email or password is incorrect.');
        const member=store.user(saved.user_id);
        if(!member||member.closed_at)throw new PortalError(401,'Email or password is incorrect.');
        return finishAuth(res,session,member,200,data.remember!==false);
      }
      if(!user)throw new PortalError(401,'Sign in to continue.');
      if(method==='POST'&&route==='/api/auth/set-password'){
        const data=await body(req), email=emailAddress(user.email);
        if(!email)throw new PortalError(409,'This account email cannot be used for password sign-in.');
        rateLimit(req,email,'set-password');
        const encoded=await passwordWork(newPassword(data?.password));
        return finishAuth(res,session,store.setPasswordForSession(user.id,email,encoded),200);
      }
      if(method==='POST'&&route==='/api/logout'){
        store.logout(session);
        res.setHeader('Set-Cookie',cookie(sessionName,'',0));
        return json(res,200,{ok:true});
      }
      if(method==='POST'&&route==='/api/pair'){
        const data=await body(req);
        if(data?.deploymentId!==undefined&&typeof data.deploymentId!=='string')throw new PortalError(400,'Select a bot.');
        store.pair(user.id,typeof data?.phone==='string'?data.phone.trim().replace(/[ ()-]/g,''):null,
          {add:data?.add===true,id:data?.deploymentId,settings:data?.settings});
        return json(res,202,{ok:true});
      }
      if(method==='POST'&&route==='/api/bot-settings'){
        const data=await body(req);
        store.saveSettings(user.id,data?.deploymentId,data?.settings);
        return json(res,200,{ok:true});
      }
      if(route==='/api/group-settings'&&method==='POST'){
        const data=await body(req);
        const token=store.groupSettings(user.id,data?.deploymentId,data);
        return json(res,202,{token});
      }
      if(route==='/api/group-settings'&&method==='GET'){
        return json(res,200,store.groupResult(user.id,url.searchParams.get('bot'),url.searchParams.get('token')));
      }
      if(method==='POST'&&route==='/api/profile'){
        const data=await body(req), username=optionalUsername(data?.username);
        const name=typeof data?.name==='string'?data.name.trim():undefined;
        if((data?.name!==undefined&&(name===undefined||!name||name.length>90))||
          (data?.theme!==undefined&&!['dark','light'].includes(data.theme)))throw new PortalError(400,'Check your profile fields.');
        return json(res,200,store.dashboard(store.updateProfile(user.id,{username,name,theme:data?.theme})));
      }
      if(method==='POST'&&route==='/api/auth/change-password'){
        const data=await body(req);
        const password=newPassword(data?.password);
        if(data.confirmation!==password)throw new PortalError(400,'Passwords do not match.');
        const saved=await reauthenticate(req,user,data.currentPassword,'change-password');
        store.changePassword(user.id,saved.email,saved.digest,await passwordWork(password));
        return finishAuth(res,session,store.user(user.id),200);
      }
      if(method==='POST'&&route==='/api/auth/close-account'){
        const data=await body(req);
        if(data?.confirmation!=='DELETE')throw new PortalError(400,'Type DELETE to confirm.');
        const saved=await reauthenticate(req,user,data.password,'close-account');
        store.closeAccount(user.id,saved.email,saved.digest);
        res.setHeader('Set-Cookie',cookie(sessionName,'',0));
        return json(res,200,{ok:true});
      }
      if(method==='GET'&&route==='/api/notifications')return json(res,200,{notices:store.notices(user)});
      if(method==='POST'&&route==='/api/notifications'){
        const data=await body(req);
        store.updateNotice(user,data?.id,data?.action);
        return json(res,200,{notices:store.notices(user)});
      }
      if(method==='GET'&&route==='/api/bot-events'){
        const id=url.searchParams.get('deploymentId');
        if(!id)throw new PortalError(400,'Select a bot.');
        return json(res,200,{events:store.eventLogs(user.id,id)});
      }
      if(method==='POST'&&route==='/api/owner/announcements'){
        if(!user.is_owner||user.banned)throw new PortalError(403,'Owner access required.');
        const data=await body(req);
        const title=typeof data?.title==='string'?data.title.trim():'';
        const description=typeof data?.description==='string'?data.description.trim():'';
        if(!title||title.length>90||!description||description.length>1600)throw new PortalError(400,'Enter a title and announcement.');
        store.publishAnnouncement(user.id,title,description);
        return json(res,201,{ok:true});
      }
      if(method==='POST'&&route==='/api/control'){
        const data=await body(req);
        if(data?.deploymentId!==undefined&&typeof data.deploymentId!=='string')throw new PortalError(400,'Select a bot.');
        store.control(user.id,data?.action,data?.deploymentId);
        return json(res,200,{ok:true});
      }
      if(method==='POST'&&route==='/api/transfers'){
        const data=await body(req), email=emailAddress(data?.email);
        if(!email)throw new PortalError(400,'Enter the recipient’s portal email address.');
        rateLimit(req,user.id,'transfer');
        store.transfer(user.id,email,data.amount,data.requestId);
        return json(res,200,{ok:true});
      }
      if(route==='/api/owner'&&method==='GET'){
        if(!user.is_owner||user.banned)throw new PortalError(403,'Owner access required.');
        return json(res,200,store.ownerData(url.searchParams.get('search')||'',url.searchParams.get('user')||undefined));
      }
      if(route==='/api/owner'&&method==='POST'){
        if(!user.is_owner||user.banned)throw new PortalError(403,'Owner access required.');
        const data=await body(req);
        if(!data||typeof data.userId!=='string')throw new PortalError(400,'Select a user.');
        store.admin(user.id,data.userId,data);
        return json(res,200,{ok:true});
      }
      throw new PortalError(404,'Page not found.');
    }catch(error){
      if(!(error instanceof PortalError))console.error('Portal request failed.');
      if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'Something went wrong. Try again.'});
      else res.end();
    }
  });
  server.requestTimeout=20_000;
  return server;
}

function portalPaths(env,cwd=process.cwd()){
  const legacy=path.resolve(cwd,'data/portal');
  const mount=env.RAILWAY_VOLUME_MOUNT_PATH&&path.resolve(cwd,env.RAILWAY_VOLUME_MOUNT_PATH);
  const withinMount=target=>mount&&(target===mount||target.startsWith(mount.endsWith(path.sep)?mount:mount+path.sep));
  const dir=env.PORTAL_DATA_DIR?path.resolve(cwd,env.PORTAL_DATA_DIR):(!mount||withinMount(legacy)?legacy:mount);
  const worker=env.WORKER_DATA_DIR?path.resolve(cwd,env.WORKER_DATA_DIR):path.join(dir,'worker');
  return {dir,worker,legacy,portalPersistent:!!withinMount(dir),workerPersistent:!!withinMount(worker)};
}

if(require.main===module){
  const {dir,worker,legacy,portalPersistent,workerPersistent}=portalPaths(process.env);
  if(!process.env.PORTAL_DATA_DIR&&dir!==legacy&&fs.existsSync(path.join(legacy,'portal.sqlite')))
    throw new Error('An existing portal database was found outside the selected volume. Back it up and migrate it before switching paths.');
  if(process.env.RAILWAY_SERVICE_ID&&!portalPersistent)
    console.error('Portal data is outside a Railway volume. Accounts and coin balances may be lost on redeploy.');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  process.umask(0o077);
  const port=Number(process.env.PORT||3000);
  const store=new Store(path.join(dir,'portal.sqlite'),Date.now,Math.max(1,Math.min(30,Number(process.env.MAX_BOTS)||8)));
  const origin=process.env.PUBLIC_ORIGIN||'http://localhost:3000';
  const sendMail=createMailer(process.env.RESEND_API_KEY,process.env.PORTAL_EMAIL_FROM);
  const server=createServer({store,origin,sendMail,
    ownerSignupToken:process.env.OWNER_SIGNUP_TOKEN,workerToken:process.env.WORKER_TOKEN,railwayProxy:!!process.env.RAILWAY_SERVICE_ID,
    links:{community:process.env.PORTAL_COMMUNITY_URL,support:process.env.PORTAL_SUPPORT_URL}});
  const runWorker=process.env.PORTAL_RUN_WORKER==='1'||
    (!!process.env.RAILWAY_SERVICE_ID&&process.env.PORTAL_RUN_WORKER!=='0');
  if(runWorker&&process.env.RAILWAY_SERVICE_ID&&!workerPersistent)
    console.error('Worker sessions are outside a Railway volume. WhatsApp accounts may need to link again after redeploy.');
  const stopNotices=sendMail&&startRenewalNotices(store,sendMail,origin);
  let stopWorker,closing=false;
  server.listen(port,'::',()=>{
    const actualPort=server.address().port;
    console.log('Raymon portal listening on port '+actualPort);
    if(runWorker)stopWorker=startWorker({
      root:worker,
      url:'http://127.0.0.1:'+actualPort,token:process.env.WORKER_TOKEN
    });
  });
  async function stop(){
    if(closing)return;
    closing=true;
    const serverClosed=new Promise(resolve=>server.close(resolve));
    await stopWorker?.();
    await stopNotices?.();
    await serverClosed;
    store.db.close();
  }
  process.once('SIGTERM',()=>void stop());
  process.once('SIGINT',()=>void stop());
}
module.exports={createServer,portalPaths,startRenewalNotices};
