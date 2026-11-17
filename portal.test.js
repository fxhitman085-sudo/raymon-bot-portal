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
  advance(12_001);
  assert.equal(store.dashboard(store.user(member)).deployment.code,null);
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

test('each dashboard reports only its own eligible deployments as its slot usage',t=>{
  const {store,owner,member,advance}=fixture(t);
  store.pair(owner,phone);
  store.pair(member,phone2);
  const active=store.deployment(member);
  store.sync([report(active,'online')]);
  const slots=id=>store.dashboard(store.user(id)).capacity;
  assert.deepEqual(slots(member),{used:2,accountUsed:1,total:2});
  assert.deepEqual(slots(owner),{used:2,accountUsed:1,total:2});
  advance(180_001);
  assert.deepEqual(slots(owner),{used:1,accountUsed:0,total:2});
  assert.deepEqual(slots(member),{used:1,accountUsed:1,total:2});
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

test('an unlinked account can verify a replacement number without losing paid time or balance',t=>{
  const {store,advance,owner,member}=fixture(t);
  store.pair(member,phone);
  const original=store.deployment(member);
  store.sync([report(original,'online')]);
  const paid=store.deployment(member).paid_until;
  assert.throws(()=>store.pair(member,phone2),{status:409});
  store.sync([report(original,'needs_pairing')]);
  advance(45_001);
  store.pair(member,phone2);
  const attempt=store.deployment(member);
  assert.throws(()=>store.pair(owner,phone),{status:409});
  assert.throws(()=>store.pair(owner,phone2),{status:409});
  store.sync([report(attempt,'pair_failed')]);
  assert.equal(store.get('SELECT phone FROM verified_numbers WHERE user_id=?',member).phone,phone);
  advance(45_001);
  store.pair(member,phone2);
  const replacement=store.deployment(member);
  store.sync([report(attempt,'online'),report(replacement,'online')]);
  assert.equal(store.get('SELECT phone FROM verified_numbers WHERE user_id=?',member).phone,phone2);
  assert.equal(store.deployment(member).paid_until,paid);
  assert.equal(store.deployment(member).linked,1);
  assert.equal(store.user(member).coins,0);
  assert.equal(store.history(member).filter(x=>x.kind==='uptime').length,1);
  assert.throws(()=>store.pair(owner,phone2),{status:409});
  store.pair(owner,phone);
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

test('five bots share one balance and users and owners can cancel individual deployments',t=>{
  let now=Date.now();
  const store=new Store(':memory:',()=>now);
  t.after(()=>store.db.close());
  const owner=store.register({email:OWNER_EMAIL,name:'Owner',digest:'test',ownerAuthorized:true}).id;
  const member=store.register({email:memberEmail,name:'Member',digest:'test'}).id;
  store.admin(owner,member,{action:'grant',amount:60,reason:'Fund five bots'});
  for(let i=0;i<5;i++)store.pair(member,'+234801234567'+i,{add:true});
  const bots=store.deployments(member);
  assert.equal(bots.length,5);
  store.sync(bots.map(bot=>report(bot,'online')));
  assert.equal(store.user(member).coins,20);
  assert.equal(store.dashboard(store.user(member)).deployments.length,5);
  assert.throws(()=>store.control(owner,'cancel',bots[0].id),{status:404});
  assert.throws(()=>store.admin(member,member,{action:'cancel',deploymentId:bots[0].id,reason:'No'}),{status:403});
  store.control(member,'cancel',bots[0].id);
  store.admin(owner,member,{action:'cancel',deploymentId:bots[1].id,reason:'Requested'});
  assert.equal(store.ownerData('',member).deployments.length,3);
  assert.equal(store.ownerData('',member).audit[0].action,'cancel');
  assert.equal(store.get('SELECT 1 FROM verified_numbers WHERE phone=?',bots[0].phone),undefined);
  now+=DAY;
  const active=store.sync(bots.map(bot=>report(bot,'online')));
  assert.equal(store.user(member).coins,0);
  assert.equal(active.length,2);
  assert.ok(active.every(bot=>bot.id!==bots[0].id&&bot.id!==bots[1].id&&bot.permitUntil>now));
  assert.equal(store.dashboard(store.user(member)).deployments.filter(bot=>bot.state==='low_balance').length,1);
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
  const firstSocket=bot.sock;
  bot.socketClosed=true;
  await worker.tick();
  assert.equal(store.dashboard(store.user(member)).deployment.code,null);
  bot.sock={...firstSocket};
  bot.socketClosed=false;
  await worker.tick();
  assert.equal(store.dashboard(store.user(member)).deployment.code,null);
  await bot.onPairCode('NEXT1234');
  await worker.tick();
  assert.equal(store.dashboard(store.user(member)).deployment.code,'NEXT1234');
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

test('bot settings are scoped to one deployment and acknowledged only by the matching revision',t=>{
  const {store,member,owner}=fixture(t);
  store.pair(member,phone,{settings:{mode:'public',statusReact:true,statusEmoji:'👩🏽‍💻'}});
  const first=store.sync([])[0];
  assert.deepEqual(first.settings.patch,{mode:'public',statusReact:true,statusEmoji:'👩🏽‍💻'});
  assert.throws(()=>store.saveSettings(owner,first.id,{mode:'private'}),{status:404});
  assert.throws(()=>store.saveSettings(member,first.id,{authDir:'/tmp/other'}),{status:400});
  store.saveSettings(member,first.id,{prefix:'!'});
  const second=store.sync([report(first,'connecting',{settings:{
    appliedRevision:first.settings.revision,values:{mode:'public'}
  }})])[0];
  assert.equal(second.settings.patch.prefix,'!');
  const values={mode:'public',prefix:'!',statusReact:true,statusEmoji:'👩🏽‍💻'};
  store.sync([report(second,'connecting',{settings:{appliedRevision:second.settings.revision,values}})]);
  let view=store.dashboard(store.user(member)).deployment.settings;
  assert.equal(view.pending,false);
  assert.equal(view.values.prefix,'!');
  store.sync([report(second,'connecting',{settings:{appliedRevision:second.settings.revision,values:{...values,prefix:'?'}}})]);
  view=store.dashboard(store.user(member)).deployment.settings;
  assert.equal(view.values.prefix,'?');
  assert.equal(store.dashboard(store.user(owner)).deployments.length,0);
});

test('bundled runtime loads, applies settings and preserves them when reopened',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'raymon-runtime-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {createRuntimeBot}=require('./worker');
  const {apply,read}=require('./bot-settings');
  const args={dir:root,authDir:path.join(root,'auth'),phone,id:randomUUID()};
  const first=await createRuntimeBot(args);
  try{
    const {executeCommand}=require('./bot-runtime/lib/commands');
    const announcement=await executeCommand({config:first.bot.config,db:first.bot.db,senderNumber:phone.slice(1)},'announce',['Test']);
    assert.equal(announcement.ok,false);
    assert.match(announcement.message,/main RAYMON BOT hosted on Bot-Hosting\.net/);
    apply(first.bot,{revision:randomUUID(),patch:{prefix:'!',statusReact:true,statusEmoji:'❤️‍🩹',awayMessage:'Back soon',updateAlerts:false}});
    assert.equal(first.bot.config.prefix,'!');
    assert.equal(read(first.bot).updateAlerts,false);
  }finally{await first.close();}
  const second=await createRuntimeBot(args);
  try{
    const saved=read(second.bot);
    assert.equal(saved.prefix,'!');
    assert.equal(saved.statusEmoji,'❤️‍🩹');
    assert.equal(saved.awayMessage,'Back soon');
    assert.equal(saved.updateAlerts,false);
  }finally{await second.close();}
});

test('password changes revoke old sessions and closing an account preserves its billing records',async t=>{
  const {store,owner}=fixture(t);
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const post=(path,data,cookie='')=>fetch(base+path,{method:'POST',
    headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(data)});
  const ref=store.user(owner).referral_code;
  const password='initial test passphrase';
  const signup=await post('/api/auth/register',{name:'Riley',username:'riley_user',email:'riley@example.test',
    password,confirmation:password,referral:ref});
  assert.equal(signup.status,201);
  const sid=signup.headers.get('set-cookie').split(';')[0];
  const account=store.session(sid.split('=')[1]);
  assert.equal(store.get('SELECT referred_by FROM portal_profiles WHERE user_id=?',account.id).referred_by,owner);
  const changes=await post('/api/profile',{username:'riley_new',name:'Riley Morgan',theme:'light'},sid);
  assert.equal(changes.status,200);
  assert.equal((await changes.json()).user.theme,'light');
  const signin=await post('/api/auth/login',{email:'riley_new',password,remember:false});
  assert.equal(signin.status,200);
  assert.doesNotMatch(signin.headers.get('set-cookie'),/Max-Age/i);
  const replacement='replacement test passphrase';
  const update=await post('/api/auth/change-password',{currentPassword:password,password:replacement,confirmation:replacement},sid);
  assert.equal(update.status,200);
  assert.equal(store.session(sid.split('=')[1]),null);
  assert.equal((await post('/api/auth/login',{email:'riley_new',password})).status,401);
  const cookie=update.headers.get('set-cookie').split(';')[0];
  store.pair(account.id,phone);
  assert.equal((await post('/api/auth/close-account',{confirmation:'wrong',password:replacement},cookie)).status,400);
  assert.equal((await post('/api/auth/close-account',{confirmation:'DELETE',password:'wrong'},cookie)).status,401);
  assert.equal((await post('/api/auth/close-account',{confirmation:'DELETE',password:replacement},cookie)).status,200);
  assert.equal(store.history(account.id).length,1);
  assert.equal(store.deployments(account.id).length,0);
  assert.equal((await post('/api/auth/login',{email:account.email,password:replacement})).status,401);
  assert.equal(store.issuePasswordReset(account.email,'test'),false);
});

test('a portal ban signs out the user and blocks sign-in until unbanned',async t=>{
  const {store,owner}=fixture(t);
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const api=(route,body,cookie='')=>fetch('http://127.0.0.1:'+server.address().port+route,{
    ...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    headers:{origin,cookie,'Content-Type':'application/json'}
  });
  const account={email:'ban-test@example.test',password,name:'Ban Test'};
  const signup=await api('/api/auth/register',account);
  assert.equal(signup.status,201);
  const oldCookie=signup.headers.get('set-cookie').split(';')[0];
  const id=store.password(account.email).user_id;
  const change=action=>store.admin(owner,id,{action,reason:'Access control test'});

  assert.equal(store.issuePasswordReset(account.email,'a'.repeat(43)),true);
  change('ban');
  assert.equal(store.passwordReset('a'.repeat(43)),undefined);
  assert.equal(store.issuePasswordReset(account.email,'b'.repeat(43)),false);
  assert.equal((await (await api('/api/me',null,oldCookie)).json()).user,null);
  assert.equal((await api('/api/profile',{name:'Ban Test'},oldCookie)).status,401);
  assert.equal((await api('/api/auth/login',{...account,password:'wrong'})).status,401);
  const blocked=await api('/api/auth/login',account);
  assert.equal(blocked.status,403);
  assert.equal(blocked.headers.get('set-cookie'),null);
  assert.equal((await blocked.json()).error,'You have been banned. Kindly contact the support team.');

  change('unban');
  assert.equal((await (await api('/api/me',null,oldCookie)).json()).user,null);
  const restored=await api('/api/auth/login',account);
  assert.equal(restored.status,200);
  assert.equal((await restored.json()).user.coins,10);
});

test('portal notifications and event logs are scoped and persisted',t=>{
  const {store,owner,member}=fixture(t);
  assert.throws(()=>store.publishAnnouncement(member,'Title','Body'),{status:403});
  store.publishAnnouncement(owner,'Maintenance','Service notice');
  store.pair(member,phone);
  const bot=store.deployment(member);
  const user=store.user(member);
  const notice=store.notices(user).find(row=>row.title==='Pairing requested');
  assert.ok(notice);
  assert.throws(()=>store.updateNotice(store.user(owner),notice.id,'read'),{status:404});
  assert.throws(()=>store.eventLogs(owner,bot.id),{status:404});
  store.updateNotice(user,notice.id,'read');
  assert.equal(store.notices(user).find(row=>row.id===notice.id).read,true);
  store.updateNotice(user,notice.id,'dismiss');
  assert.equal(store.notices(user).some(row=>row.id===notice.id),false);
  assert.ok(store.notices(user).some(row=>row.title==='Maintenance'));
  assert.equal(store.eventLogs(member,bot.id)[0].title,'Pairing requested');
});

test('worker times out an attempt with no code and the user can retry',async t=>{
  const {store,member,clock,advance}=fixture(t);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'raymon-no-code-'));
  let stops=0;
  const worker=new Worker({root,clock,url:'http://localhost:3000',token:'test',
    fetcher:async(_url,req)=>Response.json({deployments:store.sync(JSON.parse(req.body).reports)}),
    createBot:async()=>({bot:{sock:{},async start(){},async stop(){stops++;}},close(){}})});
  t.after(async()=>{await worker.stop();await fs.rm(root,{recursive:true,force:true});});
  store.pair(member,phone);
  const first=store.deployment(member);
  await worker.tick();
  advance(76_000);
  await worker.tick();
  assert.equal(store.deployment(member).state,'pair_no_code');
  assert.equal(stops,1);
  assert.equal(store.user(member).coins,10);
  store.pair(member,phone,{id:first.id});
  assert.notEqual(store.deployment(member).generation,first.generation);
});

test('restart keeps the auth generation and rejects stale worker reports',t=>{
  const {store,member,owner}=fixture(t);
  store.pair(member,phone);
  const bot=store.deployment(member);
  store.sync([report(bot,'online')]);
  assert.throws(()=>store.control(owner,'restart',bot.id),{status:404});
  store.control(member,'restart',bot.id);
  const task=store.sync([report(bot,'online')])[0];
  assert.equal(task.generation,bot.generation);
  assert.equal(store.deployment(member).state,'connecting');
  store.sync([report(bot,'online',{restart:task.restart})]);
  assert.equal(store.deployment(member).state,'online');
  assert.equal(store.user(member).coins,0);
  assert.equal(store.history(member).filter(row=>row.kind==='uptime').length,1);
});
