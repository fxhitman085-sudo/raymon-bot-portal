const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {isIP}=require('node:net');
const {Store,PortalError,OWNER_EMAIL}=require('./store');
const derive=promisify(scrypt);
const kdf={N:32768,r:8,p:3,maxmem:40*1024*1024};
const dummySalt=randomBytes(16).toString('hex');

const random=()=>randomBytes(32).toString('base64url');
const staticFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
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
function newPassword(value){
  if(typeof value!=='string'||value.length<12||value.length>128)
    throw new PortalError(400,'Choose a password with 12 to 128 characters.');
  return value;
}
async function digest(password,salt=randomBytes(16).toString('hex')){
  const key=await derive(password,Buffer.from(salt,'hex'),64,kdf);
  return salt+':'+key.toString('hex');
}
async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new PortalError(415,'Expected JSON.');
  const parts=[];let size=0;
  for await(const part of req){
    size+=part.length;
    if(size>32768)throw new PortalError(413,'Request too large.');
    parts.push(part);
  }
  try{return JSON.parse(Buffer.concat(parts));}catch{throw new PortalError(400,'Invalid JSON.');}
}

function createServer({store,origin,workerToken,ownerSignupToken,railwayProxy=false}){
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
    for(const [key,limit] of [['ip:'+ip,30],[action+':'+email,8]]){
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
  function finishAuth(res,session,user,status){
    const token=random();
    store.logout(session);
    store.putSession(user.id,token);
    res.setHeader('Set-Cookie',cookie(sessionName,token,604800));
    return json(res,status,store.dashboard(user));
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
        res.writeHead(200,{'Content-Type':type});
        res.end(fs.readFileSync(path.join(__dirname,file)));
        return;
      }
      if(method==='GET'&&route==='/health')return json(res,200,{ok:true});
      if(method==='POST'&&route==='/internal/sync'){
        if(!equal(req.headers.authorization,'Bearer '+workerToken))throw new PortalError(403,'Worker access required.');
        const data=await body(req);
        if(!Array.isArray(data?.reports)||data.reports.length>store.maxBots)throw new PortalError(400,'Invalid worker reports.');
        return json(res,200,{deployments:store.sync(data.reports)});
      }
      if(!route.startsWith('/api/'))throw new PortalError(404,'Page not found.');
      const session=cookieValue(req,sessionName);
      const user=store.session(session);
      if(method==='GET'&&route==='/api/me')return json(res,200,user?store.dashboard(user):{user:null});
      if(method==='POST'&&req.headers.origin!==origin)throw new PortalError(403,'Request origin not allowed.');
      if(method==='POST'&&['/api/auth/register','/api/auth/login'].includes(route)){
        const data=await body(req), email=emailAddress(data?.email);
        const registering=route.endsWith('/register');
        if(!email)throw new PortalError(400,'Enter a valid email address.');
        rateLimit(req,email,registering?'register':'login');
        if(registering){
          const name=typeof data.name==='string'?data.name.trim().slice(0,90):'';
          if(!name)throw new PortalError(400,'Enter your name.');
          const ownerAuthorized=typeof ownerSignupToken==='string'&&ownerSignupToken.length>=32&&equal(data.ownerToken,ownerSignupToken);
          if(email===OWNER_EMAIL&&!ownerAuthorized)throw new PortalError(403,'Enter the owner setup token to create this account.');
          const encoded=await passwordWork(newPassword(data.password));
          return finishAuth(res,session,store.register({email,name,digest:encoded,ownerAuthorized}),201);
        }
        const password=data?.password;
        if(typeof password!=='string'||password.length>128)throw new PortalError(401,'Email or password is incorrect.');
        const saved=store.password(email);
        const encoded=await passwordWork(password,saved?.digest.split(':')[0]||dummySalt);
        if(!saved||!equal(encoded,saved.digest))throw new PortalError(401,'Email or password is incorrect.');
        return finishAuth(res,session,store.user(saved.user_id),200);
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
        store.pair(user.id,typeof data?.phone==='string'?data.phone.trim().replace(/[ ()-]/g,''):null);
        return json(res,202,{ok:true});
      }
      if(method==='POST'&&route==='/api/control'){
        const data=await body(req);
        store.control(user.id,data?.action);
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

if(require.main===module){
  const dir=path.resolve(process.env.PORTAL_DATA_DIR||'./data/portal');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  process.umask(0o077);
  const port=Number(process.env.PORT||3000);
  const store=new Store(path.join(dir,'portal.sqlite'),Date.now,Math.max(1,Math.min(30,Number(process.env.MAX_BOTS)||8)));
  const server=createServer({store,origin:process.env.PUBLIC_ORIGIN||'http://localhost:3000',
    ownerSignupToken:process.env.OWNER_SIGNUP_TOKEN,workerToken:process.env.WORKER_TOKEN,railwayProxy:!!process.env.RAILWAY_SERVICE_ID});
  server.listen(port,'::',()=>console.log('Raymon portal listening on port '+port));
  process.once('SIGTERM',()=>server.close(()=>store.db.close()));
}
module.exports={createServer};
