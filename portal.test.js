const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Store,DAY,OWNER_EMAIL}=require('./store');
const {createServer,portalPaths,startRenewalNotices}=require('./server');
const {Worker}=require('./worker');

const memberEmail='member@gmail.com';
const password='a long test-only password';
function fixture(t){
  let now=Date.now();
  const store=new Store(':memory:',()=>now,2);
  t.after(()=>store.db.close());
  const owner=store.register({email:OWNER_EMAIL,name:'Owner',digest:'test',ownerAuthorized:true}).id;
  const member=store.register({email:memberEmail,name:'Member',digest:'test'}).id;
  return {store,owner,member,clock:()=>now,advance:ms=>now+=ms};
}
const phone='+2348012345678',phone2='+2348098765432';
const report=(d,status,extra={})=>({id:d.id,generation:d.generation,status,...extra});

test('starter coins are granted once and an existing owner cannot be replaced',t=>{
  const {store,owner,member}=fixture(t);
  assert.equal(store.user(member).coins,10);
  assert.equal(store.history(member).length,1);
  assert.throws(()=>store.register({email:memberEmail,name:'Duplicate',digest:'other'}),{status:409});
  assert.throws(()=>store.register({email:OWNER_EMAIL,name:'Imposter',digest:'other',ownerAuthorized:true}),{status:409});
  assert.equal(store.password(OWNER_EMAIL).user_id,owner);
  assert.equal(store.user(owner).is_owner,1);
});

test('pairing charges only when online, renews once, and pauses when coins run out',t=>{
  const {store,advance,clock,owner,member}=fixture(t);
  store.pair(member,phone);
  const d=store.deployment(member);
  store.sync([report(d,'code',{code:'ABCD1234'})]);
  assert.equal(store.user(member).coins,10);
  assert.equal(store.dashboard(store.user(member)).deployment.code,'ABCD1234');
  assert.equal(store.dashboard(store.user(owner)).deployment,null);
  assert.ok(!JSON.stringify(store.ownerData('', member)).includes('ABCD1234'));
  store.sync([report(d,'online'),report(d,'online')]);
  assert.equal(store.deployment(member).paid_until,clock()+DAY);
  assert.equal(store.user(member).coins,0);
  store.admin(owner,member,{action:'grant',amount:15,reason:'Demo adjustment'});
  advance(DAY);
  store.sync([report(d,'online'),report(d,'online')]);
  assert.equal(store.user(member).coins,5);
  advance(DAY);
  assert.deepEqual(store.sync([report(d,'online')]),[]);
  assert.equal(store.dashboard(store.user(member)).deployment.state,'low_balance');
  assert.equal(store.history(member).filter(x=>x.kind==='uptime').length,2);
});

test('expired pairing attempts cannot charge or permanently reserve a number',t=>{
  const {store,advance,owner,member}=fixture(t);
  store.pair(member,phone);
  const original=store.deployment(member);
  assert.throws(()=>store.pair(owner,phone),{status:409});
  advance(180_001);
  assert.deepEqual(store.sync([report(original,'online')]),[]);
  assert.equal(store.user(member).coins,10);
  store.pair(owner,phone);
  const fresh=store.deployment(owner);
  store.sync([report(fresh,'online')]);
  assert.throws(()=>store.pair(member,phone),{status:409});
  store.pair(member,phone2);
  assert.equal(store.deployment(member).phone,phone2);
});

test('coin adjustments are owner-only and bans cancel active work',t=>{
  const {store,owner,member}=fixture(t);
  assert.throws(()=>store.admin(member,member,{action:'grant',amount:10,reason:'unauthorized'}),{status:403});
  assert.throws(()=>store.admin(owner,member,{action:'remove',amount:11,reason:'too many'}),{status:409});
  store.pair(member,phone);
  const d=store.deployment(member);
  store.sync([report(d,'online')]);
  store.admin(owner,member,{action:'ban',reason:'Suspended'});
  assert.deepEqual(store.sync([report(d,'online')]),[]);
  assert.throws(()=>store.control(member,'resume'),{status:403});
  assert.equal(store.ownerData('', member).audit[0].action,'ban');
  store.admin(owner,member,{action:'unban',reason:'Reviewed'});
  assert.deepEqual(store.sync([]),[]);
  store.control(member,'resume');
  assert.equal(store.sync([])[0].id,d.id);
  assert.equal(store.user(member).coins,0);
});

test('coin transfers are atomic, recorded on both wallets, and safe to retry',t=>{
  const {store,owner,member}=fixture(t);
  const requestId=randomUUID();
  store.transfer(member,OWNER_EMAIL,4,requestId);
  store.transfer(member,OWNER_EMAIL,4,requestId);
  assert.equal(store.user(member).coins,6);
  assert.equal(store.user(owner).coins,14);
  assert.equal(store.history(member)[0].delta,-4);
  assert.equal(store.history(owner)[0].delta,4);
  assert.throws(()=>store.transfer(member,OWNER_EMAIL,5,requestId),{status:409});
  assert.throws(()=>store.transfer(member,OWNER_EMAIL,7,randomUUID()),{status:409});
  assert.throws(()=>store.transfer(member,memberEmail,1,randomUUID()),{status:400});
  assert.throws(()=>store.transfer(member,'missing@example.com',1,randomUUID()),{status:404});
  store.admin(owner,member,{action:'ban',reason:'Test suspension'});
  assert.throws(()=>store.transfer(owner,memberEmail,1,randomUUID()),{status:404});
  assert.throws(()=>store.transfer(member,OWNER_EMAIL,1,randomUUID()),{status:403});
  assert.equal(store.user(member).coins+store.user(owner).coins,20);
});

test('renewal warning and email distinguish reconnecting from insufficient coins',async t=>{
  const {store,member,advance,clock}=fixture(t);
  store.pair(member,phone);
  const d=store.deployment(member), view=()=>store.dashboard(store.user(member)).deployment;
  assert.equal(view().state,'queued');
  assert.equal(view().workerAvailable,false);
  store.sync([report(d,'code',{code:'ABCD1234'})]);
  assert.equal(view().state,'awaiting_code');
  assert.equal(view().workerAvailable,true);
  store.sync([report(d,'online')]);
  const renewal=clock()+DAY;
  assert.equal(view().nextRenewal,renewal);
  assert.equal(view().lowBalanceAlert,false);
  advance(19*60*60_000);
  store.sync([report(d,'connecting')]);
  assert.equal(view().state,'reconnecting');
  assert.equal(view().lowBalanceAlert,true);
  const emails=[];
  const sendMail=async mail=>{emails.push(mail);};
  await startRenewalNotices(store,sendMail,'https://portal.example.com')();
  await startRenewalNotices(store,sendMail,'https://portal.example.com')();
  assert.equal(emails.length,1);
  assert.equal(emails[0].to,memberEmail);
  assert.match(emails[0].text,/needs 10 coins/);
  advance(5*60*60_000);
  assert.equal(view().state,'low_balance');
  assert.equal(view().nextRenewal,null);
  assert.equal(view().lowBalanceAlert,false);
});

test('Railway defaults put the database and worker under the volume and honor explicit paths',()=>{
  const mount={RAILWAY_VOLUME_MOUNT_PATH:'/data'};
  assert.deepEqual(portalPaths(mount,'/app'),{dir:'/data',worker:'/data/worker',legacy:'/app/data/portal',
    portalPersistent:true,workerPersistent:true});
  const custom=portalPaths({...mount,PORTAL_DATA_DIR:'/data/portal',WORKER_DATA_DIR:'/data-worker'},'/app');
  assert.equal(custom.dir,'/data/portal');
  assert.equal(custom.workerPersistent,false);
  assert.equal(portalPaths({},'/app').dir,'/app/data/portal');
  assert.equal(portalPaths({RAILWAY_VOLUME_MOUNT_PATH:'/app/data'},'/app').dir,'/app/data/portal');
});

test('HTTP password signup and login, protected owner, origin and worker access',async t=>{
  const {store}=fixture(t);
  const workerToken='worker-test-token-'.repeat(3), ownerSignupToken='owner-test-token-'.repeat(3), origin='http://localhost:3000';
  const server=createServer({store,origin,ownerSignupToken,workerToken});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port;
  const get=(url,options)=>fetch(root+url,{redirect:'manual',...options});
  const post=(url,data,headers={})=>get(url,{method:'POST',headers:{origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  const email='real.user@gmail.com';
  const registration={email,password,name:'New user'};
  assert.equal((await post('/api/auth/register',registration,{origin:'https://example.com'})).status,403);
  assert.equal((await post('/api/auth/register',{...registration,email:'Abdul.Ganiy346+tag@googlemail.com'})).status,403);
  const signup=await post('/api/auth/register',registration);
  assert.equal(signup.status,201);
  const cookie=signup.headers.get('set-cookie').split(';')[0];
  assert.equal((await signup.json()).user.coins,10);
  assert.equal((await post('/api/auth/register',{...registration,email:'realuser+another@gmail.com'})).status,409);
  assert.ok(!store.password('realuser@gmail.com').digest.includes(password));
  assert.equal((await post('/api/auth/login',{email,password:'wrong'})).status,401);
  assert.equal((await post('/api/auth/login',{email:'REALUSER@gmail.com',password})).status,200);
  assert.equal((await get('/api/owner',{headers:{cookie}})).status,403);
  assert.equal((await post('/api/pair',{phone},{cookie})).status,202);
  assert.equal((await post('/internal/sync',{reports:[]})).status,403);
  const tasks=await (await post('/internal/sync',{reports:[]},{authorization:'Bearer '+workerToken})).json();
  assert.equal(tasks.deployments[0].phone,phone);
  assert.equal((await get('/')).status,200);
  assert.equal((await get('/auth/google')).status,404);
  assert.equal((await get('/store.js')).status,404);
});

test('owner sign-in survives a restart, and password recovery keeps the same account and wallet',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'portal-account-test-'));
  const file=path.join(dir,'portal.sqlite'), emails=[];
  const origin='http://localhost:3000', ownerSignupToken='s'.repeat(40);
  let now=Date.now(),store,server;
  t.after(async()=>{
    if(server)await new Promise(resolve=>server.close(resolve));
    store?.db.close();
    await fs.rm(dir,{recursive:true,force:true});
  });
  async function boot(setup){
    store=new Store(file,()=>now);
    server=createServer({store,origin,workerToken:'w'.repeat(40),ownerSignupToken:setup,
      sendMail:async mail=>{emails.push(mail);}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  const url=route=>'http://127.0.0.1:'+server.address().port+route;
  const post=(route,data,cookie)=>fetch(url(route),{method:'POST',
    headers:{origin,'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
  const credentials={email:OWNER_EMAIL,password};
  const cookieOf=response=>response.headers.get('set-cookie').split(';')[0];
  await boot(ownerSignupToken);
  const registration=await post('/api/auth/register',{...credentials,name:'Owner',ownerToken:ownerSignupToken});
  assert.equal(registration.status,201);
  const id=store.password(OWNER_EMAIL).user_id;
  store.admin(id,id,{action:'grant',amount:37,reason:'Persisted balance'});
  await post('/api/logout',{},cookieOf(registration));
  await new Promise(resolve=>server.close(resolve));server=null;
  store.db.close();store=null;
  await boot();
  const login=await post('/api/auth/login',credentials);
  assert.equal(login.status,200);
  const oldCookie=cookieOf(login);
  assert.equal((await login.json()).user.coins,47);
  assert.deepEqual(await (await post('/api/auth/forgot-password',{email:'unknown@example.com'})).json(),{ok:true});
  assert.equal(emails.length,0);
  const requestReset=()=>post('/api/auth/forgot-password',{email:OWNER_EMAIL});
  assert.equal((await requestReset()).status,202);
  const token=mail=>mail.text.match(/#reset=([\w-]+)/)[1];
  const expired=token(emails[0]);
  assert.equal(store.get('SELECT token FROM password_resets').token===expired,false);
  now+=30*60_000;
  const newPassword='a different test-only password';
  const reset=token=>post('/api/auth/reset-password',{token,password:newPassword});
  assert.equal((await reset(expired)).status,400);
  assert.equal((await requestReset()).status,202);
  const valid=token(emails[1]);
  assert.equal((await reset(valid)).status,200);
  assert.equal((await reset(valid)).status,400);
  assert.equal((await (await fetch(url('/api/me'),{headers:{cookie:oldCookie}})).json()).user,null);
  assert.equal((await post('/api/auth/login',credentials)).status,401);
  const recovered=await (await post('/api/auth/login',{...credentials,password:newPassword})).json();
  assert.equal(store.password(OWNER_EMAIL).user_id,id);
  assert.equal(recovered.user.isOwner,true);
  assert.equal(recovered.user.coins,47);
});

test('owner can use the one-time setup token and a legacy user can keep their account',async t=>{
  const store=new Store(':memory:');
  t.after(()=>store.db.close());
  store.run('INSERT INTO users VALUES (?,?,?,?,?,?)','legacy','legacy@gmail.com','Legacy',25,0,Date.now());
  store.putSession('legacy','legacy-session');
  const origin='http://localhost:3000', ownerSignupToken='owner-setup-secret-'.repeat(3);
  const server=createServer({store,origin,ownerSignupToken,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=(route,data,cookie)=>fetch('http://127.0.0.1:'+server.address().port+route,{
    method:'POST',headers:{origin,'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)
  });
  const owner=await post('/api/auth/register',{email:OWNER_EMAIL,password,name:'Owner',ownerToken:ownerSignupToken});
  assert.equal(owner.status,201);
  assert.equal((await owner.json()).user.isOwner,true);
  assert.equal((await post('/api/auth/register',{email:OWNER_EMAIL,password,name:'Owner',ownerToken:ownerSignupToken})).status,409);
  assert.equal((await post('/api/auth/register',{email:'legacy@gmail.com',password,name:'Other'})).status,409);
  assert.equal((await post('/api/auth/set-password',{password})).status,401);
  const legacy=await post('/api/auth/set-password',{password},'raymon=legacy-session');
  assert.equal(legacy.status,200);
  assert.equal((await legacy.json()).user.coins,25);
  assert.equal(store.password('legacy@gmail.com').user_id,'legacy');
  assert.equal(store.session('legacy-session'),null);
  assert.equal((await post('/api/auth/login',{email:'legacy@gmail.com',password})).status,200);
});

test('worker opens isolated auth and gates a bot until paid, then stops it on ban',async t=>{
  const {store,clock,owner,member}=fixture(t);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'raymon-portal-test-'));
  let bot, stopped=0;
  const worker=new Worker({root,clock,url:'http://localhost:3000',token:'test',
    fetcher:async(_url,req)=>Response.json({deployments:store.sync(JSON.parse(req.body).reports)}),
    createBot:async({authDir,dir})=>{
      assert.ok(authDir.startsWith(dir+path.sep+'auth-'));
      bot={sock:{user:{id:'2348012345678:4@s.whatsapp.net'}},async start(){await this.onPairCode('TEST1234');},
        async onMessages(){return 'pong';},async stop(){stopped++;}};
      return {bot,close(){}};
    }});
  t.after(async()=>{await worker.stop();await fs.rm(root,{recursive:true,force:true});});
  store.pair(member,phone);
  await worker.tick();
  assert.equal(await bot.onMessages(),undefined);
  await worker.tick();
  assert.equal(store.dashboard(store.user(member)).deployment.code,'TEST1234');
  bot.connected=true;
  await bot.onConnected();
  assert.equal(await bot.onMessages(),undefined);
  await worker.tick();
  assert.equal(await bot.onMessages(),'pong');
  assert.equal(store.user(member).coins,0);
  store.admin(owner,member,{action:'ban',reason:'Stop test'});
  await worker.tick();
  assert.equal(stopped,1);
  assert.equal(await bot.onMessages(),undefined);
});
