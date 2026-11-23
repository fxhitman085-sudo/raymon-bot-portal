const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {isIP}=require('node:net');
const sharp=require('sharp');
const {Store,PortalError,OWNER_EMAIL,BAN_MESSAGE}=require('./store');
const {startWorker}=require('./worker');
const derive=promisify(scrypt);
const kdf={N:32768,r:8,p:3,maxmem:40*1024*1024};
const dummySalt=randomBytes(16).toString('hex');

const random=()=>randomBytes(32).toString('base64url');
const staticFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/portal-v3-ui.js',['portal-v3-ui.js','text/javascript; charset=utf-8']],['/vip-ui.js',['vip-ui.js','text/javascript; charset=utf-8']],['/cc4.js',['cc4.js','text/javascript; charset=utf-8']],['/community-v5-ui.js',['community-v5-ui.js','text/javascript; charset=utf-8']],['/vip-silver.svg',['vip-silver.svg','image/svg+xml']],['/vip-gold.svg',['vip-gold.svg','image/svg+xml']],['/vip-diamond.svg',['vip-diamond.svg','image/svg+xml']],['/style.css',['style.css','text/css; charset=utf-8']],['/raymon-brand.jpg',['bot-runtime/assets/announcements.jpg','image/jpeg']]]);
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
      const {id,phone,paid_until:paidUntil,email,rate}=notice;
      try{
        await sendMail({to:email,subject:'RAYMON BOT needs coins before renewal',id:'renewal/'+id+'/'+paidUntil,
          text:'Your bot for '+phone+' needs '+rate+' coins to renew. Its current time ends at '+new Date(paidUntil).toUTCString()+
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
async function readBody(req,limit){
  const parts=[];let size=0;
  for await(const part of req){
    size+=part.length;
    if(size>limit)throw new PortalError(413,'Request too large.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function body(req,limit=32768){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new PortalError(415,'Expected JSON.');
  const raw=await readBody(req,limit);
  try{return JSON.parse(raw);}catch{throw new PortalError(400,'Invalid JSON.');}
}
async function avatarJpeg(bytes){
  try{
    const image=sharp(bytes,{limitInputPixels:20_000_000});
    const {format,pages}=await image.metadata();
    if(!['jpeg','png','webp'].includes(format)||pages>1)throw Error('Unsupported image');
    return await image.autoOrient().resize(256,256,{fit:'cover'}).flatten({background:'#ffffff'}).jpeg({quality:84}).toBuffer();
  }catch{throw new PortalError(400,'Choose a valid JPG, PNG, or WebP photo under 3 MB.');}
}

async function menuJpeg(bytes){
 try{
  const image=sharp(bytes,{limitInputPixels:12_000_000});
  const {format,pages}=await image.metadata();
  if(!['jpeg','png','webp'].includes(format)||pages>1)throw Error('Unsupported media');
  const jpeg=await image.autoOrient().resize({width:1200,height:675,fit:'inside',withoutEnlargement:true})
    .flatten({background:'#101727'}).jpeg({quality:80,mozjpeg:true}).toBuffer();
  if(jpeg.length>1024*1024)throw Error('Too large');
  return jpeg;
 }catch{throw new PortalError(400,'Choose a valid JPG, PNG or WebP image under 3 MB.');}
}
async function ticketScreenshot(value){
  if(value===undefined)return null;
  if(typeof value!=='string'||value.length>4*1024*1024|| !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new PortalError(400,'Choose a JPG, PNG, or WebP screenshot under 3 MB.');
  try{
    const image=sharp(Buffer.from(value,'base64'),{limitInputPixels:20_000_000});
    const {format,pages}=await image.metadata();
    if(!['jpeg','png','webp'].includes(format)||pages>1)throw Error('Unsupported image');
    const bytes=await image.autoOrient().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
      .flatten({background:'#ffffff'}).jpeg({quality:82}).toBuffer();
    if(bytes.length>1024*1024)throw Error('Image too large');
    return bytes;
  }catch{throw new PortalError(400,'Choose a valid JPG, PNG, or WebP screenshot under 3 MB.');}
}

async function v3Route({store,req,res,url,user,fresh,rateLimit}){
  const v3=store.v3,id=user.id,route=url.pathname.slice('/api/v3/'.length),method=req.method;
  const query=key=>url.searchParams.get(key);
  const staff=query('staff')==='1', period=query('period')||'daily', previous=Number(query('previous')||0);
  if(method==='GET'){
    if(route==='payments'){
      const review=query('review')==='1';
      if(query('attachment')){
        const payment=v3.payment(id,query('attachment'),review);
        res.writeHead(200,{'Content-Type':'image/jpeg'});
        res.end(payment.screenshot);
      }else json(res,200,v3.paymentRows(id,review,query('before')));
    }
    else if(route==='packages')json(res,200,{packages:v3.packages(id,query('manage')==='1')});
    else if(route==='staff')json(res,200,v3.staff(id));
    else if(route==='staff-search')json(res,200,{accounts:v3.staffSearch(id,query('search'))});
    else if(route==='overview')json(res,200,v3.overview(id));
    else if(route==='rankings')json(res,200,v3.rankings(id,period,previous));
    else if(route==='referrals')json(res,200,v3.referralAdmin(id,period,previous));
    else if(route==='promos'){
      const cursor=Number(query('claimBefore'));
      json(res,200,v3.promos(id,query('promo'),query('before'),cursor>0&&Number.isSafeInteger(cursor)?cursor:null));
    }
    else if(route==='tickets'){
      const stamp=Number(query('stamp')), before=query('before');
      const rank=Number(query('rank')||0);
      const items=v3.ticketInbox(id,staff,before&&Number.isSafeInteger(stamp)?{stamp,id:before,rank:Number.isInteger(rank)&&rank>=0&&rank<=3?rank:0}:null);
      json(res,200,{items:items.slice(0,50),more:items.length>50});
    }else if(route==='ticket'){
      const ticket=query('id')||'';
      if(query('attachment')){
        const screenshot=v3.ticketAttachment(id,ticket,query('attachment'),staff);
        res.writeHead(200,{'Content-Type':'image/jpeg'});
        res.end(screenshot);
      }else json(res,200,v3.ticketView(id,ticket,staff));
    }else return false;
    return true;
  }
  if(method!=='POST'||!['staff','permissions','promos','redeem','onboarding','referrals','tickets','payments','packages'].includes(route))return false;
  if(route==='payments')rateLimit(req,id,'payment-request');
  if(route==='redeem'||route==='tickets'&&!staff)rateLimit(req,id,route==='redeem'?'promo-claim':'support-ticket');
  if(route==='tickets'&&staff)v3.permit(id,'tickets.view');
  const data=await body(req,['tickets','payments'].includes(route)?4*1024*1024+16_384:undefined);
  if(!data||typeof data!=='object'||Array.isArray(data))throw new PortalError(400,'Invalid request.');
  fresh();
  if(route==='payments'){
    if(data.action==='review'){
      return json(res,200,v3.reviewPayment(id,data)),true;
    }
    if(data.action!=='submit')throw new PortalError(400,'Choose a payment action.');
    if(data.screenshot===undefined)throw new PortalError(400,'Upload your payment screenshot.');
    const screenshot=await ticketScreenshot(data.screenshot);
    fresh();
    return json(res,200,v3.submitPayment(id,data,screenshot)),true;
  }
  if(route==='tickets'){
    if(staff&&data.action==='reply')v3.permit(id,'tickets.reply');
    if(data.action==='reply')v3.ticket(id,typeof data.ticketId==='string'?data.ticketId:'',staff);
    const screenshot=['create','reply'].includes(data.action)?await ticketScreenshot(data.screenshot):null;
    fresh();
    return json(res,200,v3.ticketAction(id,staff,data,screenshot)),true;
  }
  let result;
  if(route==='packages')result=v3.savePackage(id,data);
  else if(route==='staff')v3.setStaff(id,data);
  else if(route==='permissions')v3.setPermissions(id,data);
  else if(route==='promos')v3.promoSave(id,data);
  else if(route==='redeem')result=v3.redeem(id,data.code);
  else if(route==='onboarding')v3.saveOnboarding(id,data.step);
  else v3.referralAction(id,data);
  json(res,200,result||{ok:true});
  return true;
}

function createServer({store,origin,workerToken,railwayProxy=false,sendMail=null,links={}}){
  const base=new URL(origin), secure=base.protocol==='https:';
  if(!secure&&!['localhost','127.0.0.1'].includes(base.hostname))throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  if(base.origin!==origin)throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
  if(!workerToken||workerToken.length<32)throw new Error('Set WORKER_TOKEN to a strong shared secret of at least 32 characters.');
  const sessionName=secure?'__Host-raymon':'raymon';
  const recoveryName=secure?'__Host-raymon-recovery':'raymon-recovery';
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
    if(user.banned)throw new PortalError(403,BAN_MESSAGE);
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
      if(method==='GET'&&route.startsWith('/internal/menu/')){
        if(!equal(req.headers.authorization,'Bearer '+workerToken))throw new PortalError(403,'Worker access required.');
        const botId=route.slice('/internal/menu/'.length);
        if(!/^[a-f0-9-]{36}$/.test(botId))throw new PortalError(404,'Bot not found.');
        const menu=store.upgrade5.workerMenu(botId);
        const images=menu.enabled?menu.images.map(id=>(()=>{const bytes=store.get('SELECT jpeg FROM v5_menu_images WHERE id=?',id)?.jpeg;return bytes?Buffer.from(bytes).toString('base64'):null;})()).filter(Boolean):[];
        return json(res,200,{...menu,images});
      }
      if(!route.startsWith('/api/'))throw new PortalError(404,'Page not found.');
      const session=cookieValue(req,sessionName);
      const user=store.session(session);
      if(method==='GET'&&route==='/api/me')return json(res,200,user?store.dashboard(user):{user:null,recoveryAvailable:true});
      if(method==='GET'&&route==='/api/community')return json(res,200,{
        announcements:store.announcements(),community:publicUrl(links.community),support:'https://wa.me/message/264FM6MC5QN3G1'});
      if(method==='POST'&&req.headers.origin!==origin)throw new PortalError(403,'Request origin not allowed.');
      if(method==='POST'&&route==='/api/auth/forgot-password'){
        const data=await body(req), email=emailAddress(data?.email);
        if(!email)throw new PortalError(400,'Enter a valid email address.');
        rateLimit(req,email,'forgot-password');
        const secret=random(), result=store.recovery.request(email,secret);
        res.setHeader('Set-Cookie',cookie(recoveryName,secret,86400));
        return json(res,202,{ok:true,requestId:result.id,expires:result.expires});
      }
      if(method==='GET'&&route==='/api/auth/recovery-status'){
        const result=store.recovery.status(url.searchParams.get('requestId'),cookieValue(req,recoveryName));
        return json(res,200,result);
      }
      if(method==='POST'&&route==='/api/auth/reset-password'){
        const data=await body(req);
        rateLimit(req,String(data?.requestId||'').slice(0,30),'reset-password');
        const password=newPassword(data?.password);
        if(data?.confirmation!==password)throw new PortalError(400,'Passwords do not match.');
        const encoded=await passwordWork(password);
        store.recovery.consume(data?.requestId,cookieValue(req,recoveryName),data?.code,encoded);
        res.setHeader('Set-Cookie',[cookie(sessionName,'',0),cookie(recoveryName,'',0)]);
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
          if(email===OWNER_EMAIL)throw new PortalError(403,'Use the existing Founder sign-in.');
          const username=optionalUsername(data.username);
          const referral=typeof data.referral==='string'&&/^[a-f0-9]{16}$/.test(data.referral)?data.referral:null;
          if(data.confirmation!==undefined&&data.confirmation!==data.password)throw new PortalError(400,'Passwords do not match.');
          const encoded=await passwordWork(newPassword(data.password));
          return finishAuth(res,session,store.register({email,name,digest:encoded,username,referral}),201);
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
      if(route.startsWith('/api/v5/')){
        const api=store.upgrade5;
        if(method==='GET'&&route==='/api/v5/chat'){
          return json(res,200,api.messages(user.id,Number(url.searchParams.get('after')||0)));
        }
        if(method==='GET'&&route==='/api/v5/reports')return json(res,200,{reports:api.reports(user.id)});
        if(method==='POST'&&route==='/api/v5/chat'){
          const d=await body(req);
          return json(res,201,api.send(user.id,d?.text,d?.replyTo||null));
        }
        if(method==='POST'&&route==='/api/v5/chat-action'){
          rateLimit(req,user.id,'v5-action');
          return json(res,200,api.messageAction(user.id,await body(req)));
        }
        if(method==='POST'&&route==='/api/v5/moderate'){
          rateLimit(req,user.id,'v5-moderate');
          const d=await body(req);
          return json(res,200,api.moderate(user.id,d?.action,d?.messageId,d?.targetId,d?.reason,d?.minutes));
        }
        if(method==='GET'&&route==='/api/v5/releases')return json(res,200,{releases:api.releases(user.id)});
        if(method==='POST'&&route==='/api/v5/releases'){
          rateLimit(req,user.id,'v5-release');
          const d=await body(req),action=d?.action;
          if(action==='create')return json(res,201,api.createRelease(user.id,d));
          if(action==='audience')return json(res,200,api.audience(user.id,d));
          if(action==='transition')return json(res,200,api.transition(user.id,d.releaseId,d.state,d.confirmation));
          throw new PortalError(400,'Invalid release action.');
        }
        if(method==='GET'&&route==='/api/v5/my-betas')return json(res,200,{betas:api.myBetas(user.id)});
        if(method==='GET'&&route==='/api/v5/feedback'){
          return json(res,200,{feedback:api.feedbackList(user.id,url.searchParams.get('releaseId'))});
        }
        if(method==='POST'&&route==='/api/v5/feedback'){
          rateLimit(req,user.id,'v5-feedback');
          const d=await body(req);return json(res,201,api.feedback(user.id,d?.releaseId,d?.text));
        }
        if(method==='GET'&&route==='/api/v5/feature-access')
          return json(res,200,{community_chat:api.hasAccess(user.id,'community_chat'),
            vip_menu_gallery:api.hasAccess(user.id,'vip_menu_gallery')});
        if(method==='GET'&&route==='/api/v5/menu'){
          return json(res,200,api.menu(user.id,url.searchParams.get('bot')));
        }
        if(method==='GET'&&route==='/api/v5/menu-image'){
          const jpeg=api.image(user.id,url.searchParams.get('bot'),url.searchParams.get('image'));
          res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(jpeg);
        }
        if(method==='POST'&&route==='/api/v5/menu-upload'){
          rateLimit(req,user.id,'v5-menu-upload');
          const bot=url.searchParams.get('bot');
          const image=await menuJpeg(await readBody(req,3*1024*1024));
          return json(res,201,api.addImage(user.id,bot,image));
        }
        if(method==='POST'&&route==='/api/v5/menu'){
          rateLimit(req,user.id,'v5-menu');
          const d=await body(req);
          if(d?.action==='configure')return json(res,200,api.menuConfigure(user.id,d.bot,d));
          if(d?.action==='remove')return json(res,200,api.removeImage(user.id,d.bot,d.image));
          throw new PortalError(400,'Unknown menu action.');
        }
      }
      if(method==='GET'&&route==='/api/vip')return json(res,200,store.vip.status(user.id));
      if(method==='GET'&&route==='/api/vip/backups')return json(res,200,{backups:store.vip.backups(user.id)});
      if(method==='GET'&&route==='/api/vip/analytics')return json(res,200,store.vip.analytics(user.id,url.searchParams.get('botId')));
      if(method==='GET'&&route==='/api/vip/profile'){
        store.v3.permit(user.id,'vip.grant');
        const membership=store.vip.membership(url.searchParams.get('user'));
        return json(res,200,{tier:membership?.tier||null});
      }
      if(method==='GET'&&route==='/api/vip/members')return json(res,200,{members:store.vip.members(user.id),plans:store.vip.plans()});
      if(method==='GET'&&route==='/api/diagnostics')return json(res,200,store.diagnostics.report(user.id,url.searchParams.get('botId')));
      if(method==='GET'&&route==='/api/owner/diagnostics')return json(res,200,store.diagnostics.fleet(user.id));
      if(method==='POST'&&route==='/api/vip'){
        const data=await body(req);rateLimit(req,user.id,'vip-'+String(data?.action||'').slice(0,20));
        const action=data?.action;let result;
        if(action==='buy')result=store.vip.buy(user.id,data);
        else if(action==='renewal')result=store.vip.setRenewal(user.id,data.enabled);
        else if(action==='claim')result=store.vip.claim(user.id);
        else if(action==='branding')result=store.vip.branding(user.id,data.title);
        else if(action==='backup')result=store.vip.backup(user.id,data.deploymentId);
        else if(action==='restore')result=store.vip.restore(user.id,data.backupId);
        else if(action==='configure')result=store.vip.configure(user.id,data);
        else if(action==='grant')result=store.vip.grant(user.id,data);
        else if(action==='revoke')result=store.vip.revoke(user.id,data.userId);
        else throw new PortalError(400,'Unknown VIP action.');
        return json(res,200,result);
      }
      if(method==='GET'&&route==='/api/owner/recovery')return json(res,200,{items:store.recovery.inbox(user.id)});
      if(method==='POST'&&route==='/api/owner/recovery'){
        const data=await body(req);
        rateLimit(req,user.id,'review-recovery');
        return json(res,200,store.recovery.review(user.id,data?.requestId,data?.action,data?.phone));
      }
      if(route.startsWith('/api/v3/')){
        const fresh=()=>{if(store.session(session)?.id!==user.id)throw new PortalError(401,'Sign in to continue.');};
        if(await v3Route({store,req,res,url,user,fresh,rateLimit}))return;
      }
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
          (data?.theme!==undefined&&!store.vip.themeAllowed(user.id,data.theme)))throw new PortalError(400,'Check your profile fields.');
        return json(res,200,store.dashboard(store.updateProfile(user.id,{username,name,theme:data?.theme})));
      }
      if(route==='/api/profile/avatar'){
        if(method==='GET'){
          const photo=store.avatar(user.id);
          if(!photo)throw new PortalError(404,'No profile photo.');
          res.writeHead(200,{'Content-Type':'image/jpeg'});
          return res.end(photo.jpeg);
        }
        if(method==='POST'){
          rateLimit(req,user.id,'profile-avatar');
          const type=req.headers['content-type'];
          const jpeg=type==='application/json'
            ?((await body(req))?.remove===true?null:undefined)
            :await avatarJpeg(await readBody(req,3*1024*1024));
          if(jpeg===undefined)throw new PortalError(400,'Choose a photo or remove the current one.');
          store.setAvatar(user.id,jpeg);
          return json(res,200,store.dashboard(store.user(user.id)));
        }
      }
      if(method==='POST'&&route==='/api/rewards/daily'){
        const amount=store.claimDaily(user.id);
        return json(res,200,{...store.dashboard(store.user(user.id)),claimedAmount:amount});
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
        return json(res,200,store.staffAccountData(user.id,url.searchParams.get('search')||'',url.searchParams.get('user')||undefined));
      }
      if(route==='/api/owner/rewards'&&method==='POST'){
        if(!user.is_owner)throw new PortalError(403,'Owner access required.');
        store.updateRewardConfig(user.id,await body(req));
        return json(res,200,{ok:true});
      }
      if(route==='/api/owner'&&method==='POST'){
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

function clearRetiredSessions(root, database) {
  if (!fs.existsSync(root) || !fs.existsSync(database)) return;
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(database, {readOnly: true});
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let removed = 0;
  try {
    const rows = db.prepare('SELECT id, generation, state FROM deployments').all();
    for (const {id, generation, state} of rows) {
      if (!uuid.test(id) || !uuid.test(generation)) continue;
      const dir = path.join(root, id);
      if (!fs.lstatSync(dir, {throwIfNoEntry: false})?.isDirectory()) continue;
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (!entry.isDirectory() || !entry.name.startsWith('auth-')) continue;
        const old = entry.name.slice(5).replace(/\.pre-v7$/, '');
        if (!uuid.test(old) || (old === generation && state !== 'cancelled')) continue;
        fs.rmSync(path.join(dir, entry.name), {recursive: true, force: true});
        removed++;
      }
    }
    const disk = fs.statfsSync(root);
    console.log('Retired session directories removed:', removed, 'Free MiB:', Math.floor(disk.bavail * disk.bsize / 1048576));
  } finally {
    db.close();
  }
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
  if (workerPersistent) {
    try { clearRetiredSessions(worker, path.join(dir, 'portal.sqlite')); }
    catch (error) { console.warn('Retired session cleanup failed:', error.code || error.name); }
  }
  const store=new Store(path.join(dir,'portal.sqlite'),Date.now,Math.max(1,Math.min(30,Number(process.env.MAX_BOTS)||8)));
  const origin=process.env.PUBLIC_ORIGIN||'http://localhost:3000';
  const sendMail=createMailer(process.env.RESEND_API_KEY,process.env.PORTAL_EMAIL_FROM);
  const server=createServer({store,origin,sendMail,
    workerToken:process.env.WORKER_TOKEN,railwayProxy:!!process.env.RAILWAY_SERVICE_ID,
    links:{community:process.env.PORTAL_COMMUNITY_URL,support:process.env.PORTAL_SUPPORT_URL}});
  const runWorker=process.env.PORTAL_RUN_WORKER==='1'||
    (!!process.env.RAILWAY_SERVICE_ID&&process.env.PORTAL_RUN_WORKER!=='0');
  if(runWorker&&process.env.RAILWAY_SERVICE_ID&&!workerPersistent)
    console.error('Worker sessions are outside a Railway volume. WhatsApp accounts may need to link again after redeploy.');
  const stopNotices=sendMail&&startRenewalNotices(store,sendMail,origin);
  const settlePrizes=()=>{
    try{store.v3.settleAutomatic();}catch(error){console.error('Could not process leaderboard prizes:',error.message);}
    try{store.vip.tick();}catch(error){console.error('VIP renewals failed:',error.message);}
  };
  const prizeTimer=setInterval(settlePrizes,60_000);
  prizeTimer.unref();
  settlePrizes();
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
    clearInterval(prizeTimer);
    await serverClosed;
    store.db.close();
  }
  process.once('SIGTERM',()=>void stop());
  process.once('SIGINT',()=>void stop());
}
module.exports={createServer,portalPaths,startRenewalNotices};
