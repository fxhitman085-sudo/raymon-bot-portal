const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const {Store,PortalError}=require('./store');

const random=()=>randomBytes(32).toString('base64url');
const staticFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
const equal=(left,right)=>typeof left==='string'&&typeof right==='string'&&Buffer.byteLength(left)===Buffer.byteLength(right)&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
const cookieValue=(req,name)=>req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1);
const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
const redirect=(res,to)=>{res.writeHead(303,{Location:to});res.end();};
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

function createServer({store,origin,googleId,googleSecret,workerToken,fetcher=fetch}){
  const base=new URL(origin), secure=base.protocol==='https:';
  if(!secure&&!['localhost','127.0.0.1'].includes(base.hostname))throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  if(base.origin!==origin)throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
  if(!workerToken||workerToken.length<32)throw new Error('Set WORKER_TOKEN to a strong shared secret of at least 32 characters.');
  const sessionName=secure?'__Host-raymon':'raymon', oauthName=secure?'__Host-raymon-oauth':'raymon-oauth';
  const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const callback=origin+'/auth/callback';
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
      if(method==='GET'&&route==='/auth/google'){
        if(!googleId||!googleSecret)return redirect(res,'/?error=setup');
        const state=random(),verifier=random();
        store.putOAuth(state,verifier);
        res.setHeader('Set-Cookie',cookie(oauthName,state,600));
        const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search=new URLSearchParams({client_id:googleId,redirect_uri:callback,response_type:'code',scope:'openid email profile',
          state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'});
        return redirect(res,auth.href);
      }
      if(method==='GET'&&route==='/auth/callback'){
        res.setHeader('Set-Cookie',cookie(oauthName,'',0));
        try{
          const state=url.searchParams.get('state'),code=url.searchParams.get('code');
          if(!state||!code||!equal(state,cookieValue(req,oauthName)))return redirect(res,'/?error=signin');
          const verifier=store.takeOAuth(state);
          if(!verifier)return redirect(res,'/?error=signin');
          const token=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(10_000),
            body:new URLSearchParams({client_id:googleId,client_secret:googleSecret,code,code_verifier:verifier,redirect_uri:callback,grant_type:'authorization_code'})});
          if(!token.ok)throw new Error('Token exchange failed');
          const {access_token}=await token.json();
          if(!access_token)throw new Error('Token missing');
          const info=await fetcher('https://openidconnect.googleapis.com/v1/userinfo',{signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+access_token}});
          if(!info.ok)throw new Error('Identity fetch failed');
          const user=store.signIn(await info.json());
          const session=random();
          store.logout(cookieValue(req,sessionName));
          store.putSession(user.id,session);
          res.setHeader('Set-Cookie',[cookie(oauthName,'',0),cookie(sessionName,session,604800)]);
          return redirect(res,'/');
        }catch{return redirect(res,'/?error=signin');}
      }
      if(!route.startsWith('/api/'))throw new PortalError(404,'Page not found.');
      const session=cookieValue(req,sessionName);
      const user=store.session(session);
      if(method==='GET'&&route==='/api/me')return json(res,200,user?store.dashboard(user):{user:null,signInReady:!!(googleId&&googleSecret)});
      if(!user)throw new PortalError(401,'Sign in to continue.');
      if(method==='POST'&&req.headers.origin!==origin)throw new PortalError(403,'Request origin not allowed.');
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
  const server=createServer({store,origin:process.env.PUBLIC_ORIGIN||'http://localhost:3000',googleId:process.env.GOOGLE_CLIENT_ID,
    googleSecret:process.env.GOOGLE_CLIENT_SECRET,workerToken:process.env.WORKER_TOKEN});
  server.listen(port,'::',()=>console.log('Raymon portal listening on port '+port));
  process.once('SIGTERM',()=>server.close(()=>store.db.close()));
}
module.exports={createServer};
