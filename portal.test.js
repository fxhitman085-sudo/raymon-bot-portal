const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID,scryptSync}=require('node:crypto');
const {Store,DAY,OWNER_EMAIL}=require('./store');
const {createServer,portalPaths,startRenewalNotices}=require('./server');
const {Worker}=require('./worker');

const memberEmail='member@gmail.com';
const password='a long test-only password';
function seedFounder(store,plaintext){
  const id=randomUUID(),salt='4'.repeat(32);
  const key=plaintext?scryptSync(plaintext,Buffer.from(salt,'hex'),64,{N:32768,r:8,p:3,maxmem:40*1024*1024}):null;
  store.tx(()=>{
    store.run('INSERT INTO users(id,email,name,created) VALUES (?,?,?,?)',id,OWNER_EMAIL,'Founder',store.clock());
    store.run('INSERT INTO owner VALUES (1,?)',id);
    store.run('INSERT INTO passwords VALUES (?,?,?)',OWNER_EMAIL,id,key?salt+':'+key.toString('hex'):'test');
    store.createProfile(id,'founder');
    store.credit(id,10,'starter','One-time starter coins');
  });
  return id;
}

function fixture(t){
  let now=Date.now();
  const store=new Store(':memory:',()=>now,2);
  t.after(()=>store.db.close());
  const owner=seedFounder(store);
  const member=store.register({email:memberEmail,name:'Member',digest:'test'}).id;
  return {store,owner,member,clock:()=>now,advance:ms=>now+=ms};
}
const phone='+2348012345678',phone2='+2348098765432';
const report=(d,status,extra={})=>({id:d.id,generation:d.generation,status,...extra});

test('daily claims reset at midnight in Lagos and owner controls are enforced',t=>{
  const {store,owner,member,clock,advance}=fixture(t);
  const config={...store.rewardConfig(),dailyEnabled:true,referralEnabled:true,dailyAmount:7};
  assert.throws(()=>store.updateRewardConfig(member,config),{status:403});
  assert.equal(store.claimDaily(member),2);
  assert.throws(()=>store.claimDaily(member),{status:409});
  const {nextReset}=store.dailyBonus(member);
  assert.equal(new Date(nextReset).getUTCHours(),23);
  assert.equal(new Date(nextReset).getUTCMinutes(),0);
  store.updateRewardConfig(owner,config);
  advance(nextReset-clock()-1);
  assert.throws(()=>store.claimDaily(member),{status:409});
  advance(1);
  assert.equal(store.claimDaily(member),7);
  assert.equal(store.user(member).coins,19);
  assert.deepEqual({...store.ownerData().rewards.daily},{claims:2,paid:9});
  store.updateRewardConfig(owner,{...config,dailyEnabled:false});
  assert.throws(()=>store.claimDaily(owner),{status:409});
});

test('referrals pay once, preserve pending amounts and respect the configured trigger',t=>{
  const {store,owner,member}=fixture(t);
  const referral=store.user(member).referral_code;
  const register=email=>store.register({email,name:'Referred',digest:'test',referral});
  const user=register('first@example.test');
  assert.equal(user.coins,10);
  assert.equal(store.referralStats(member).pending,1);
  assert.throws(()=>register(memberEmail),{status:409});
  const changed={...store.rewardConfig(),dailyEnabled:true,referralEnabled:true,
    inviterAmount:3,inviteeAmount:4,referralTrigger:'signup'};
  store.updateRewardConfig(owner,changed);
  const second=register('second@example.test');
  assert.equal(second.coins,14);
  assert.equal(store.user(member).coins,13);
  store.pair(user.id,phone);
  const bot=store.deployment(user.id);
  store.sync([report(bot,'online'),report(bot,'online')]);
  assert.equal(store.user(user.id).coins,5);
  assert.equal(store.user(member).coins,18);
  assert.deepEqual({...store.referralStats(member)},{pending:0,completed:2,earned:8});
  assert.deepEqual({...store.ownerData().rewards.referrals},{pending:0,completed:2,earned:17});
  store.updateRewardConfig(owner,{...changed,referralEnabled:false});
  assert.equal(register('third@example.test').coins,10);
  assert.equal(store.referralStats(member).completed,2);
});

test('signed-in profile photos are resized, isolated by account and removable',async t=>{
  const {store,owner,member}=fixture(t);
  const sharp=require('sharp');
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  store.putSession(owner,'photo-owner');
  store.putSession(member,'photo-member');
  const addr='http://127.0.0.1:'+server.address().port+'/api/profile/avatar';
  const request=(token,type,body)=>fetch(addr,{...(body?{method:'POST',body}:{}),
    headers:{origin,cookie:'raymon='+token,...(type?{'Content-Type':type}:{})}});
  assert.equal((await request('photo-member','image/png',Buffer.from('not an image'))).status,400);
  const image=await sharp({create:{width:40,height:60,channels:3,background:'blue'}}).png().toBuffer();
  const uploaded=await request('photo-member','image/png',image);
  assert.equal(uploaded.status,200);
  assert.ok((await uploaded.json()).user.avatarVersion);
  assert.equal((await request('photo-owner')).status,404);
  assert.equal((await request('invalid')).status,401);
  const saved=await request('photo-member');
  assert.equal(saved.headers.get('content-type'),'image/jpeg');
  assert.equal((await sharp(Buffer.from(await saved.arrayBuffer())).metadata()).width,256);
  assert.equal((await request('photo-member','application/json',JSON.stringify({remove:true}))).status,200);
  assert.equal((await request('photo-member')).status,404);
});

test('starter coins are granted once and an existing owner cannot be replaced',t=>{
  const {store,owner,member}=fixture(t);
  assert.equal(store.user(member).coins,10);
  assert.equal(store.history(member).length,1);
  assert.throws(()=>store.register({email:memberEmail,name:'Duplicate',digest:'other'}),{status:409});
  assert.throws(()=>store.register({email:OWNER_EMAIL,name:'Imposter',digest:'other',ownerAuthorized:true}),{status:403});
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
  const owner=seedFounder(store);
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
  const workerToken='worker-test-token-'.repeat(3), origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken});
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

test('owner sign-in survives restart; admin-approved recovery preserves account and coins',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'portal-recovery-'));
  const file=path.join(dir,'portal.sqlite'),origin='http://localhost:3000';
  let now=Date.now(),store,server;
  t.after(async()=>{
    if(server)await new Promise(resolve=>server.close(resolve));
    store?.db.close();
    await fs.rm(dir,{recursive:true,force:true});
  });
  async function boot(){
    store=new Store(file,()=>now);
    server=createServer({store,origin,workerToken:'w'.repeat(40)});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  const url=route=>'http://127.0.0.1:'+server.address().port+route;
  const post=(route,data,cookies)=>fetch(url(route),{method:'POST',
    headers:{origin,'Content-Type':'application/json',...(cookies?{cookie:cookies}:{})},body:JSON.stringify(data)});
  const cookieOf=response=>response.headers.get('set-cookie').split(';')[0];
  await boot();
  const id=seedFounder(store,password);
  store.admin(id,id,{action:'grant',amount:37,reason:'Persisted balance'});
  store.run('INSERT INTO verified_numbers VALUES (?,?)',phone,id);
  await new Promise(resolve=>server.close(resolve));server=null;store.db.close();store=null;
  await boot();
  const credentials={email:OWNER_EMAIL,password};
  const login=await post('/api/auth/login',credentials);
  assert.equal(login.status,200);
  const ownerCookie=cookieOf(login);
  assert.equal((await login.json()).user.coins,47);
  const missing=await post('/api/auth/forgot-password',{email:'unknown@example.com'});
  assert.equal(missing.status,202);
  assert.equal((await missing.json()).ok,true);
  const request=await post('/api/auth/forgot-password',{email:OWNER_EMAIL});
  assert.equal(request.status,202);
  const {requestId}=await request.json(),browser=cookieOf(request);
  assert.match(requestId,/^[A-F0-9]{16}$/);
  const status=async cookie=>(await fetch(url('/api/auth/recovery-status?requestId='+requestId),{headers:cookie?{cookie}:undefined})).json();
  assert.equal((await status(browser)).state,'pending');
  assert.equal((await status()).state,'expired');
  assert.equal((await post('/api/owner/recovery',{requestId,action:'approve',phone:phone2},ownerCookie)).status,403);
  assert.equal((await post('/api/owner/recovery',{requestId,action:'approve',phone},ownerCookie)).status,200);
  const approved=await status(browser);
  assert.equal(approved.state,'approved');
  assert.match(approved.code,/^[A-Z2-9]{10}$/);
  assert.equal((await status()).code,undefined);
  const newPassword='a different test-only password';
  const reset={requestId,code:approved.code,password:newPassword,confirmation:newPassword};
  assert.equal((await post('/api/auth/reset-password',reset)).status,400);
  assert.equal((await post('/api/auth/reset-password',{...reset,code:'AAAAAAAAAA'},browser)).status,400);
  assert.equal((await post('/api/auth/reset-password',reset,browser)).status,200);
  assert.equal((await post('/api/auth/reset-password',reset,browser)).status,400);
  assert.equal((await (await fetch(url('/api/me'),{headers:{cookie:ownerCookie}})).json()).user,null);
  assert.equal((await post('/api/auth/login',credentials)).status,401);
  const recovered=await (await post('/api/auth/login',{...credentials,password:newPassword})).json();
  assert.equal(store.password(OWNER_EMAIL).user_id,id);
  assert.equal(recovered.user.isOwner,true);
  assert.equal(recovered.user.coins,47);
});

test('recovery approval respects administrator permissions, linked phone and code attempt limits',t=>{
  const {store,owner,member}=fixture(t);
  const target=store.register({email:'recovery-target@example.com',name:'Target',digest:'original-hash'}).id;
  store.v3.setStaff(owner,{userId:member,action:'level',level:2});
  store.run('INSERT INTO verified_numbers VALUES (?,?)',phone,target);
  const browser='z'.repeat(43),{id}=store.recovery.request('recovery-target@example.com',browser);
  assert.equal(store.recovery.inbox(owner).length,1);
  assert.throws(()=>store.recovery.inbox(member),{status:403});
  store.v3.setPermissions(owner,{level:2,permissions:['passwords.review']});
  assert.equal(store.recovery.inbox(member).length,1);
  assert.throws(()=>store.recovery.review(member,id,'approve',phone2),{status:403});
  assert.equal(store.recovery.review(member,id,'approve',phone).ok,true);
  const code=store.recovery.status(id,browser).code;
  assert.ok(code);
  assert.throws(()=>store.recovery.consume(id,'a'.repeat(43),code,'new-hash'),{status:400});
  for(let i=0;i<5;i++)assert.throws(()=>store.recovery.consume(id,browser,'AAAAAAAAAA','new-hash'),{status:400});
  assert.equal(store.get('SELECT attempts FROM recovery_requests WHERE id=?',id).attempts,5);
  assert.throws(()=>store.recovery.consume(id,browser,code,'new-hash'),{status:429});
  assert.equal(store.password('recovery-target@example.com').digest,'original-hash');
  store.v3.setStaff(owner,{userId:member,action:'suspend'});
  assert.throws(()=>store.recovery.inbox(member),{status:403});
});

test('public signup cannot create a Founder and a legacy user can keep their account',async t=>{
  const store=new Store(':memory:');
  t.after(()=>store.db.close());
  store.run('INSERT INTO users VALUES (?,?,?,?,?,?)','legacy','legacy@gmail.com','Legacy',25,0,Date.now());
  store.putSession('legacy','legacy-session');
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=(route,data,cookie)=>fetch('http://127.0.0.1:'+server.address().port+route,{
    method:'POST',headers:{origin,'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)
  });
  const owner=await post('/api/auth/register',{email:OWNER_EMAIL,password,name:'Owner',ownerToken:'previous-token',isOwner:true,role:'founder'});
  assert.equal(owner.status,403);
  assert.equal(store.get('SELECT * FROM owner'),undefined);
  const ordinary=await post('/api/auth/register',{email:'regular@example.com',password,name:'Regular',ownerToken:'previous-token',role:'founder',isOwner:true});
  assert.equal(ordinary.status,201);
  assert.equal((await ordinary.json()).user.isOwner,false);
  assert.equal(store.get('SELECT * FROM owner'),undefined);
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

test('administrator permissions are independent, immediately revocable, and protect Founder and staff accounts',t=>{
  const {store,owner,member}=fixture(t);
  const other=store.register({email:'staff-target@example.com',name:'Target',digest:'test'}).id;
  const v3=store.v3;
  assert.throws(()=>v3.setStaff(member,{userId:other,action:'level',level:7}),{status:403});
  assert.throws(()=>v3.setStaff(owner,{userId:owner,action:'level',level:7}),{status:404});
  v3.setStaff(owner,{userId:member,action:'level',level:1});
  v3.setPermissions(owner,{level:1,permissions:['coins.adjust','announcements.publish']});
  assert.equal(Object.hasOwn(store.staffAccountData(member).users.find(row=>row.id===other),'coins'),false);
  store.admin(member,other,{action:'grant',amount:3,reason:'Support adjustment'});
  assert.equal(store.user(other).coins,13);
  assert.throws(()=>store.admin(member,owner,{action:'grant',amount:3,reason:'Target protected'}),{status:403});
  assert.throws(()=>v3.setPermissions(member,{level:7,permissions:['users.moderate']}),{status:403});
  v3.setStaff(owner,{userId:member,action:'level',level:7});
  assert.throws(()=>store.admin(member,other,{action:'grant',amount:3,reason:'No inheritance'}),{status:403});
  v3.setPermissions(owner,{level:7,permissions:['users.moderate']});
  v3.setStaff(owner,{userId:other,action:'level',level:1});
  assert.throws(()=>store.admin(member,other,{action:'ban',reason:'Staff protected'}),{status:403});
  v3.setStaff(owner,{userId:member,action:'suspend'});
  assert.throws(()=>store.staffAccountData(member),{status:403});
  v3.setStaff(owner,{userId:member,action:'restore'});
  assert.equal(store.staffAccountData(member).users.length,3);
  v3.setStaff(owner,{userId:member,action:'remove'});
  assert.equal(v3.role(store.user(member)).level,null);
  assert.ok(v3.staff(owner).audit.some(row=>row.action==='account.grant'&&row.target===other));
});

test('promo codes enforce activation, expiry and redemption limits atomically',t=>{
  const {store,owner,member,clock,advance}=fixture(t);
  const other=store.register({email:'promo-target@example.com',name:'Other',digest:'test'}).id;
  const v3=store.v3, expires=clock()+DAY;
  const promo={code:'WELCOME-3',amount:15,expires,maxClaims:1,active:true};
  assert.throws(()=>v3.promoSave(member,promo),{status:403});
  v3.promoSave(owner,promo);
  assert.throws(()=>v3.promoSave(owner,promo),{status:409});
  const {id}=v3.promos(owner).codes[0];
  v3.promoSave(owner,{promoId:id,active:false});
  assert.throws(()=>v3.redeem(member,promo.code),{status:404});
  v3.promoSave(owner,{promoId:id,active:true});
  assert.deepEqual(v3.redeem(member,' welcome-3 '),{amount:15});
  assert.throws(()=>v3.redeem(member,promo.code),{status:409});
  assert.throws(()=>v3.redeem(other,promo.code),{status:409});
  assert.equal(store.user(member).coins,25);
  assert.equal(v3.promos(owner,id).history[0].amount,15);
  v3.promoSave(owner,{promoId:id,amount:20,expires,maxClaims:2,active:true});
  assert.equal(v3.promos(owner,id).history[0].amount,15);
  advance(DAY);
  assert.throws(()=>v3.redeem(other,promo.code),{status:404});
});

test('support tickets and sanitized screenshots are private and staff replies notify the requester',async t=>{
  const {store,owner,member}=fixture(t);
  const other=store.register({email:'support-target@example.com',name:'Other',digest:'test'}).id;
  store.v3.setStaff(owner,{userId:other,action:'level',level:1});
  store.v3.setPermissions(owner,{level:1,permissions:['tickets.view']});
  store.putSession(owner,'owner-support');
  store.putSession(member,'member-support');
  store.putSession(other,'other-support');
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route,session,data)=>fetch('http://127.0.0.1:'+server.address().port+'/api/'+route,{
    method:data?'POST':'GET',headers:{origin,'Content-Type':'application/json',...(session?{cookie:'raymon='+session}:{})},
    body:data?JSON.stringify(data):undefined
  });
  const screenshot=(await require('sharp')({create:{width:2000,height:500,channels:3,background:'blue'}}).png().toBuffer()).toString('base64');
  const draft={action:'create',subject:'Pairing help',message:'My code did not show.'};
  assert.equal((await request('v3/tickets','member-support',{...draft,screenshot:'QUJDRA=='})).status,400);
  const opened=await request('v3/tickets','member-support',{...draft,screenshot});
  assert.equal(opened.status,200);
  const {id}=await opened.json();
  const route='v3/ticket?id='+id;
  assert.equal((await request(route,'other-support')).status,404);
  assert.equal((await request(route+'&staff=1','member-support')).status,403);
  const staffView=await (await request(route+'&staff=1','other-support')).json();
  const attachment=route+'&attachment='+staffView.messages[0].id;
  assert.equal((await request(attachment,null)).status,401);
  assert.equal((await request(attachment,'other-support')).status,404);
  const image=await request(attachment,'member-support');
  assert.equal(image.headers.get('content-type'),'image/jpeg');
  assert.equal((await require('sharp')(Buffer.from(await image.arrayBuffer())).metadata()).width,1600);
  const reply={action:'reply',ticketId:id,message:'Try starting a new pairing attempt.'};
  assert.equal((await request('v3/tickets?staff=1','other-support',reply)).status,403);
  assert.equal((await request('v3/tickets?staff=1','owner-support',{action:'assign',ticketId:id,assignee:other})).status,200);
  assert.equal((await request('v3/tickets?staff=1','owner-support',reply)).status,200);
  const {notices}=await (await request('notifications','member-support')).json();
  const notice=notices.find(row=>row.title==='New support reply');
  assert.equal(notice.ticketId,id);
  assert.equal(notice.read,false);
  assert.equal((await request('v3/tickets?staff=1','owner-support',{action:'close',ticketId:id})).status,200);
  assert.equal((await request('v3/tickets','member-support',reply)).status,409);
  store.v3.setStaff(owner,{userId:other,action:'suspend'});
  assert.equal((await request(attachment+'&staff=1','other-support')).status,403);
});

test('referral rankings use verified numbers and support idempotent awards in Lagos periods',t=>{
  const {store,owner,member,clock,advance}=fixture(t);
  const v3=store.v3, referral=store.user(member).referral_code;
  const add=email=>store.register({email,name:'Invitee',digest:'test',referral}).id;
  const invitee=add('invitee@example.com');
  assert.equal(v3.rankings(member,'all',0).rows.length,0);
  v3.referralAction(owner,{action:'configure',period:'daily',mode:'automatic',prizes:[20]});
  store.pair(invitee,phone);
  const bot=store.deployment(invitee);
  store.sync([report(bot,'online')]);
  assert.equal(v3.rankings(member,'all',0).rows[0].referrals,1);
  store.control(invitee,'cancel');
  const recycled=add('recycled@example.com');
  store.pair(recycled,phone);
  store.sync([report(store.deployment(recycled),'online')]);
  assert.equal(v3.rankings(member,'all',0).rows[0].referrals,1);
  const {end}=v3.rankings(member,'daily',0);
  assert.equal(new Date(end).getUTCHours(),23);
  advance(end-clock());
  const before=store.user(member).coins;
  v3.settleAutomatic();
  v3.settleAutomatic();
  assert.equal(store.user(member).coins,before+20);
  assert.equal(v3.referralAdmin(owner,'daily',1).award.winners[0].amount,20);
  v3.referralAction(owner,{action:'configure',period:'all',mode:'manual',prizes:[30]});
  const {preview,start}=v3.referralAdmin(owner,'all',0);
  const award={action:'approve',period:'all',preview:JSON.stringify(preview),expectedStart:start};
  assert.throws(()=>v3.referralAction(member,award),{status:403});
  v3.referralAction(owner,{action:'review',invitee,excluded:true});
  assert.throws(()=>v3.referralAction(owner,award),{status:409});
  v3.referralAction(owner,{action:'review',invitee,excluded:false});
  v3.referralAction(owner,award);
  assert.throws(()=>v3.referralAction(owner,award),{status:409});
  assert.equal(store.user(member).coins,before+50);
});

test('Version 3 migrations preserve a Founder, balances, sessions and linked deployment generation',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'portal-v3-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'portal.sqlite'), now=Date.now();
  let store=new Store(file,()=>now);
  const owner=seedFounder(store),member=store.register({email:memberEmail,name:'Member',digest:'test',
    referral:store.user(owner).referral_code}).id;
  store.putSession(owner,'existing-owner-session');
  store.putSession(member,'existing-session');
  store.pair(member,phone);
  const bot=store.deployment(member);
  store.sync([report(bot,'online')]);
  const expected=[store.user(owner).coins,store.user(member).coins];
  // Recreate the prior schema without any Version 3 tables, keeping all existing records.
  store.db.exec('PRAGMA foreign_keys=OFF');
  for(const {name} of store.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"))
    store.db.exec('DROP TABLE '+name);
  store.db.close();
  store=new Store(file,()=>now);
  t.after(()=>store.db.close());
  assert.equal(store.session('existing-owner-session').is_owner,1);
  assert.equal(store.session('existing-session').id,member);
  assert.deepEqual([store.user(owner).coins,store.user(member).coins],expected);
  assert.equal(store.deployment(member).generation,bot.generation);
  assert.equal(store.deployment(member).linked,1);
  assert.equal(store.v3.rankings(owner,'all',0).rows[0].referrals,1);
  assert.equal(store.v3.onboarding(member),null);
  store.v3.saveOnboarding(member,3);
  assert.equal(store.v3.onboarding(member),3);
  store.v3.saveOnboarding(member,-1);
  store.v3.saveOnboarding(member,0);
  assert.equal(store.v3.onboarding(member),0);
});

test('coin payment packages are server priced, receipts are private and approval credits once',async t=>{
  const {store,owner,member}=fixture(t);
  const other=store.register({email:'payment-other@example.com',name:'Other',digest:'test'}).id;
  store.putSession(owner,'payment-owner');
  store.putSession(member,'payment-member');
  store.putSession(other,'payment-other');
  store.v3.setStaff(owner,{userId:other,action:'level',level:7});
  store.v3.setPermissions(owner,{level:7,permissions:['coins.adjust','coins.view']});
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port;
  const request=(route,session,data,source=origin)=>fetch(root+route,{
    method:data?'POST':'GET',headers:{origin:source,'Content-Type':'application/json',...(session?{cookie:'raymon='+session}:{})},
    body:data?JSON.stringify(data):undefined
  });
  const screenshot=(await require('sharp')({create:{width:200,height:400,channels:3,background:'blue'}}).png().toBuffer()).toString('base64');
  const payload={action:'submit',requestId:randomUUID(),packageId:'50',reference:'PAYMENT-TEST-123',
    screenshot,coins:100000,naira:1,status:'approved'};
  assert.equal((await request('/api/v3/payments',null,payload)).status,401);
  assert.equal((await request('/api/v3/payments','payment-member',payload,'https://example.com')).status,403);
  assert.equal((await request('/api/v3/payments','payment-member',{...payload,packageId:'999'})).status,400);
  assert.equal((await request('/api/v3/payments','payment-member',{...payload,screenshot:undefined})).status,400);
  assert.equal((await request('/api/v3/payments','payment-member',{...payload,screenshot:'aW52YWxpZA=='})).status,400);
  const submit=await request('/api/v3/payments','payment-member',payload);
  assert.equal(submit.status,200);
  const {id}=await submit.json();
  assert.equal(id,payload.requestId);
  assert.equal(store.user(member).coins,10);
  assert.equal((await request('/api/v3/payments','payment-member',payload)).status,200);
  assert.equal(store.get('SELECT count(*) AS n FROM v3_payments').n,1);
  const own=await (await request('/api/v3/payments','payment-member')).json();
  assert.deepEqual(own.packages.map(({naira,coins})=>[naira,coins]),[[500,50],[1000,100],[2000,200]]);
  assert.equal(own.bank,'OPay');
  assert.equal(own.accountNumber,'8059692394');
  assert.equal(own.items[0].coins,50);
  assert.equal(own.items[0].status,'pending');
  assert.equal(Object.hasOwn(own.items[0],'email'),false);
  assert.equal((await (await request('/api/v3/payments','payment-other')).json()).items.length,0);
  const attachment='/api/v3/payments?attachment='+id;
  assert.equal((await request(attachment,null)).status,401);
  assert.equal((await request(attachment,'payment-other')).status,404);
  assert.equal((await request(attachment+'&review=1','payment-other')).status,403);
  const receipt=await request(attachment,'payment-member');
  assert.equal(receipt.headers.get('content-type'),'image/jpeg');
  assert.equal((await require('sharp')(Buffer.from(await receipt.arrayBuffer())).metadata()).height,400);
  assert.equal((await request('/api/v3/payments?review=1','payment-other')).status,403);
  const review={action:'review',paymentId:id,decision:'approved',coins:200000};
  assert.equal((await request('/api/v3/payments','payment-other',review)).status,403);
  const approvals=await Promise.all([request('/api/v3/payments','payment-owner',review),request('/api/v3/payments','payment-owner',review)]);
  assert.deepEqual(approvals.map(response=>response.status),[200,200]);
  assert.equal(store.user(member).coins,60);
  assert.equal(store.all("SELECT * FROM ledger WHERE kind='coin_purchase'").length,1);
  assert.equal((await request('/api/v3/payments','payment-owner',{...review,decision:'rejected',reason:'Late review'})).status,409);
  assert.equal((await request('/api/v3/payments','payment-other',{...payload,requestId:randomUUID()})).status,409);
  assert.ok(store.notices(store.user(member)).some(row=>row.title==='Coin payment approved'));
  const support=await (await request('/api/community',null)).json();
  assert.equal(support.support,'https://wa.me/message/264FM6MC5QN3G1');
  const html=await (await request('/',null)).text();
  assert.ok(!html.includes('COMING SOON'));
  assert.ok(html.includes('href="https://wa.me/message/264FM6MC5QN3G1" target="_blank" rel="noopener noreferrer" id="support-button"'));
});

test('rejected receipts stay rejected, preserve coin balances and prevent duplicate references',t=>{
  const {store,owner,member}=fixture(t);
  const requestId=randomUUID();
  const payload={requestId,packageId:'100',reference:'ABC-123-XYZ'};
  const screenshot=Buffer.from('receipt fixture');
  store.v3.submitPayment(member,payload,screenshot);
  assert.throws(()=>store.v3.reviewPayment(owner,{paymentId:requestId,decision:'rejected',reason:''}),{status:400});
  store.v3.reviewPayment(owner,{paymentId:requestId,decision:'rejected',reason:'The transfer did not arrive.'});
  assert.equal(store.user(member).coins,10);
  assert.equal(store.v3.paymentRows(member,false).items[0].reason,'The transfer did not arrive.');
  assert.throws(()=>store.v3.reviewPayment(owner,{paymentId:requestId,decision:'approved'}),{status:409});
  assert.throws(()=>store.v3.submitPayment(member,{...payload,requestId:randomUUID(),reference:'abc123xyz'},Buffer.from('other receipt')),{status:409});
  assert.throws(()=>store.v3.submitPayment(member,{...payload,requestId:randomUUID(),reference:'DIFFERENT123'},screenshot),{status:409});
});

test('payment migration persists pending evidence and approval safely across restarts',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'portal-payments-'));
  const file=path.join(dir,'portal.sqlite');
  let store=new Store(file);
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  const owner=seedFounder(store);
  const member=store.register({email:'persistent-payment@example.com',name:'Member',digest:'test'}).id;
  const requestId=randomUUID(),receipt=Buffer.from('persistent private receipt');
  store.v3.submitPayment(member,{requestId,packageId:'200',reference:'PERSISTENT-PAYMENT'},receipt);
  store.db.close();
  store=new Store(file);
  assert.equal(Buffer.from(store.v3.payment(member,requestId,false).screenshot).toString(),receipt.toString());
  store.v3.reviewPayment(owner,{paymentId:requestId,decision:'approved'});
  store.db.close();
  store=new Store(file);
  store.v3.reviewPayment(owner,{paymentId:requestId,decision:'approved'});
  assert.equal(store.user(member).coins,210);
});

test('Founder package editing preserves old payment prices, supports new packages, and blocks stale submissions',t=>{
  const {store,owner,member}=fixture(t),v3=store.v3;
  const original=v3.packages(member).find(row=>row.id==='50');
  const payment={requestId:randomUUID(),packageId:original.id,packageRevision:original.revision,reference:'ORIGINAL-PRICE'};
  const receipt=Buffer.from('original-price-receipt');
  v3.submitPayment(member,payment,receipt);
  assert.throws(()=>v3.savePackage(member,{packageId:'50',expectedRevision:original.revision,naira:700,coins:60,active:true}),{status:403});
  const updated=v3.savePackage(owner,{packageId:'50',expectedRevision:original.revision,naira:700,coins:60,active:true});
  assert.notEqual(updated.revision,original.revision);
  assert.deepEqual(v3.submitPayment(member,payment,receipt),{id:payment.requestId,status:'pending'});
  v3.reviewPayment(owner,{paymentId:payment.requestId,decision:'approved'});
  assert.equal(store.user(member).coins,60);
  assert.equal(v3.paymentRows(member,false).items[0].naira,500);
  assert.equal(v3.paymentRows(member,false).items[0].coins,50);
  assert.throws(()=>v3.submitPayment(member,{...payment,requestId:randomUUID(),reference:'STALE-PRICE'},Buffer.from('stale screenshot')),{status:409});
  const created={packageId:randomUUID(),expectedRevision:null,coins:350,naira:3200,active:true};
  const first=v3.savePackage(owner,created);
  assert.deepEqual(v3.savePackage(owner,created),first);
  const row=v3.packages(member).find(item=>item.id===created.packageId);
  v3.submitPayment(member,{requestId:randomUUID(),packageId:row.id,packageRevision:row.revision,reference:'NEW-PACKAGE-PRICE'},Buffer.from('new package screenshot'));
  assert.equal(v3.paymentRows(member,false).items[0].coins,350);
  assert.equal(v3.paymentRows(member,false).items[0].naira,3200);
  v3.savePackage(owner,{...created,expectedRevision:row.revision,active:false});
  assert.equal(v3.packages(member).some(item=>item.id===row.id),false);
  assert.equal(v3.packages(owner,true).find(item=>item.id===row.id).active,false);
  assert.throws(()=>v3.submitPayment(member,{requestId:randomUUID(),packageId:row.id,reference:'INACTIVE-PACKAGE'},Buffer.from('inactive screenshot')),{status:409});
  assert.throws(()=>v3.savePackage(owner,{...created,expectedRevision:row.revision,coins:500}),{status:409});
  assert.throws(()=>v3.savePackage(owner,{...created,packageId:randomUUID(),coins:0}),{status:400});
  assert.throws(()=>v3.savePackage(owner,{...created,packageId:randomUUID(),naira:1.5}),{status:400});
  assert.ok(v3.staff(owner).audit.some(item=>item.action==='package.created'));
});

test('package management API requires Founder access and exposes current packages to signed-in users',async t=>{
  const {store,owner,member}=fixture(t);
  store.putSession(owner,'package-founder');
  store.putSession(member,'package-member');
  store.v3.setStaff(owner,{userId:member,action:'level',level:7});
  store.v3.setPermissions(owner,{level:7,permissions:['coins.adjust','coins.view']});
  const origin='http://localhost:3000',server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(suffix,session,data)=>fetch('http://127.0.0.1:'+server.address().port+'/api/v3/packages'+suffix,{
    method:data?'POST':'GET',headers:{origin,'Content-Type':'application/json',...(session?{cookie:'raymon='+session}:{})},
    body:data?JSON.stringify(data):undefined
  });
  assert.equal((await request('',null)).status,401);
  assert.equal((await request('?manage=1','package-member')).status,403);
  const input={packageId:randomUUID(),expectedRevision:null,coins:500,naira:4500,active:true};
  assert.equal((await request('','package-member',input)).status,403);
  assert.equal((await request('','package-founder',input)).status,200);
  const result=await (await request('','package-member')).json();
  assert.equal(result.packages.find(row=>row.id===input.packageId).naira,4500);
});

test('custom package prices and activation survive restart without reseeding the defaults',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'portal-packages-')),file=path.join(dir,'portal.sqlite');
  let store=new Store(file);
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  const owner=seedFounder(store),initial=store.v3.packages(owner,true).find(item=>item.id==='50');
  store.v3.savePackage(owner,{packageId:'50',expectedRevision:initial.revision,naira:600,coins:55,active:false});
  const custom={packageId:randomUUID(),expectedRevision:null,naira:2700,coins:300,active:true};
  store.v3.savePackage(owner,custom);
  store.db.close();
  store=new Store(file);
  const restored=store.v3.packages(owner,true).find(row=>row.id==='50');
  assert.equal(restored.active,false);
  assert.equal(restored.naira,600);
  assert.equal(restored.coins,55);
  assert.equal(store.v3.packages(owner).find(row=>row.id===custom.packageId).coins,300);
  assert.equal(store.v3.packages(owner,true).length,4);
});


test('VIP memberships charge coins, apply hosting discounts and award daily bonuses once',t=>{
  const {store,owner,member,advance}=fixture(t);
  store.admin(owner,member,{action:'grant',amount:400,reason:'Fund VIP'});
  assert.equal(store.vip.rate(member),10);
  assert.throws(()=>store.vip.claim(member),{status:409});
  const bought=store.vip.buy(member,{tier:'gold',duration:'weekly',autoRenew:true});
  assert.equal(bought.cost,150);
  assert.equal(store.vip.rate(member),8);
  assert.equal(store.vip.membership(member).tier,'gold');
  assert.equal(store.vip.claim(member).amount,5);
  assert.throws(()=>store.vip.claim(member),{status:409});
  store.pair(member,phone);
  store.sync([report(store.deployment(member),'online')]);
  const charged=store.history(member).find(row=>row.kind==='uptime');
  assert.equal(charged.delta,-8);
  const beforeRenew=store.user(member).coins;
  advance(7*DAY+1);
  store.vip.tick();
  assert.equal(store.user(member).coins,beforeRenew-150);
  assert.equal(store.vip.rate(member),8);
  store.vip.setRenewal(member,false);
  assert.equal(store.vip.status(member).autoRenew,false);
  const claimed=store.vip.claim(member);
  assert.equal(claimed.amount,5);
  assert.equal(store.vip.purchaseBonus(member,100,randomUUID()),5);
});

test('VIP plan edit rights, backups, member grants and pairing diagnostics stay account-isolated',t=>{
  const {store,owner,member}=fixture(t);
  const other=store.register({email:'vip-other@example.com',name:'Other',digest:'test'}).id;
  assert.throws(()=>store.vip.configure(member,{tier:'silver'}),{status:403});
  const plan=store.vip.config('silver');
  store.vip.configure(owner,{tier:'silver',weekly:plan.weekly,monthly:plan.monthly,
    discount:plan.discount,daily:plan.daily,slots:plan.slots,themes:plan.themes,
    analyticsDays:plan.analytics_days,backups:plan.backups,bonusPercent:plan.bonus_percent,
    early:plan.early,active:true});
  store.vip.grant(owner,{userId:member,tier:'silver',days:30});
  assert.equal(store.vip.status(member).tier,'silver');
  store.pair(member,phone);
  const bot=store.deployment(member);
  const backup=store.vip.backup(member,bot.id);
  assert.ok(backup.id);
  assert.equal(store.vip.backups(member).length,1);
  assert.throws(()=>store.vip.restore(other,backup.id),{status:403});
  assert.equal(store.vip.restore(member,backup.id).ok,true);
  const reportResult=store.diagnostics.report(member,bot.id);
  assert.equal(reportResult.workerAvailable,false);
  assert.equal(reportResult.issue.title,'Pairing worker unavailable');
  assert.throws(()=>store.diagnostics.report(other,bot.id),{status:404});
  assert.throws(()=>store.diagnostics.fleet(other),{status:403});
  const fleet=store.diagnostics.fleet(owner);
  assert.equal(fleet.workerAvailable,false);
  store.vip.revoke(owner,member);
  assert.equal(store.vip.rate(member),10);
});


test('VIP themes enforce entitlements and support inbox prioritizes higher tiers',t=>{
  const {store,owner,member}=fixture(t);
  const other=store.register({email:'vip-ordinary@example.com',name:'Ordinary',digest:'test'}).id;
  assert.equal(store.vip.themeAllowed(member,'midnight'),false);
  store.vip.grant(owner,{userId:member,tier:'silver',days:14});
  assert.equal(store.vip.themeAllowed(member,'midnight'),true);
  assert.equal(store.vip.themeAllowed(member,'gold'),false);
  store.vip.grant(owner,{userId:member,tier:'gold',days:10});
  assert.equal(store.vip.themeAllowed(member,'gold'),true);
  const when=store.clock();
  store.run('INSERT INTO v3_tickets VALUES (?,?,?,NULL,0,?,?)',
    randomUUID(),other,'Standard ticket',when,when+1000);
  store.run('INSERT INTO v3_tickets VALUES (?,?,?,NULL,0,?,?)',
    randomUUID(),member,'Gold ticket',when,when);
  const inbox=store.v3.ticketInbox(owner,true);
  assert.equal(inbox[0].subject,'Gold ticket');
  assert.equal(inbox[0].priorityRank,2);
  assert.equal(inbox[1].priorityRank,0);
  const after=store.v3.ticketInbox(owner,true,{rank:inbox[0].priorityRank,stamp:inbox[0].updated,id:inbox[0].id});
  assert.equal(after[0].subject,'Standard ticket');
  store.vip.revoke(owner,member);
  assert.equal(store.vip.themeAllowed(member,'midnight'),false);
});

test('VIP HTTP endpoints enforce login, expose badge resources, and validate coin checkout',async t=>{
  const {store,owner,member}=fixture(t);
  store.putSession(member,'vip-session');
  store.admin(owner,member,{action:'grant',amount:190,reason:'VIP checkout test'});
  const origin='http://localhost:3000',server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=path=>'http://127.0.0.1:'+server.address().port+path;
  const get=(path,cookie)=>fetch(url(path),{headers:cookie?{cookie}:undefined});
  const post=(path,data,cookie)=>fetch(url(path),{method:'POST',headers:{origin,'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
  assert.equal((await get('/api/vip')).status,401);
  for(const tier of ['silver','gold','diamond']){
    const image=await get('/vip-'+tier+'.svg');
    assert.equal(image.status,200);
    assert.match(image.headers.get('content-type'),/image\/svg\+xml/);
  }
  assert.equal((await get('/vip-ui.js')).status,200);
  const cookie='raymon=vip-session';
  const before=await (await get('/api/vip',cookie)).json();
  assert.equal(before.tier,null);
  const bought=await post('/api/vip',{action:'buy',tier:'silver',duration:'weekly',autoRenew:false},cookie);
  assert.equal(bought.status,200);
  assert.equal((await bought.json()).cost,50);
  const after=await (await get('/api/vip',cookie)).json();
  assert.equal(after.tier,'silver');
  assert.equal(store.user(member).coins,150);
  assert.equal((await post('/api/vip',{action:'claim'},cookie)).status,200);
  assert.equal((await post('/api/vip',{action:'claim'},cookie)).status,409);
  assert.equal((await get('/api/owner/diagnostics',cookie)).status,403);
});

test('Control Center 4.0 delegates only lower administrator levels to configured active Level 7',t=>{
  const {store,owner,member}=fixture(t);
  const peer=store.register({email:'cc4-peer@example.com',name:'Peer',digest:'test'}).id;
  const junior=store.register({email:'cc4-junior@example.com',name:'Junior',digest:'test'}).id;
  const founder=store.v3;
  founder.setStaff(owner,{userId:member,action:'level',level:7});
  founder.setStaff(owner,{userId:peer,action:'level',level:7});
  assert.ok(founder.role(store.user(member)).permissions.includes('staff.manage.lower'));
  assert.equal(founder.canManageLower(member),true);
  assert.throws(()=>founder.setStaff(member,{userId:junior,action:'level',level:1}),{status:400});
  founder.setStaff(member,{userId:junior,action:'level',level:1,reason:'Appointed to support requests'});
  assert.equal(founder.role(store.user(junior)).level,1);
  founder.setStaff(member,{userId:junior,action:'level',level:6,reason:'Promoted for operations'});
  assert.equal(founder.role(store.user(junior)).level,6);
  assert.throws(()=>founder.setStaff(member,{userId:junior,action:'level',level:7,reason:'Unauthorized'}),{status:403});
  assert.throws(()=>founder.setStaff(member,{userId:peer,action:'suspend',reason:'Unauthorized'}),{status:403});
  assert.throws(()=>founder.setStaff(member,{userId:member,action:'remove',reason:'Unauthorized'}),{status:403});
  assert.throws(()=>founder.setStaff(member,{userId:owner,action:'level',level:6,reason:'Unauthorized'}),{status:404});
  assert.throws(()=>founder.setPermissions(member,{level:6,permissions:['coins.view']}),{status:403});
  assert.ok(!founder.staffSearch(member,'founder').some(row=>row.id===owner));
  const list=founder.staff(member);
  assert.ok(list.admins.every(a=>a.level<7));
  assert.deepEqual(list.permissions,{});
  assert.deepEqual(list.levels,[]);
  assert.ok(list.audit.every(a=>a.actorEmail===store.user(member).email));
  founder.setStaff(member,{userId:junior,action:'suspend',reason:'Review access'});
  assert.equal(founder.role(store.user(junior)).suspended,true);
  founder.setStaff(member,{userId:junior,action:'restore',reason:'Access restored'});
  founder.setStaff(member,{userId:junior,action:'remove',reason:'End of assignment'});
  assert.equal(founder.role(store.user(junior)).level,null);
  assert.ok(founder.staff(owner).audit.some(a=>a.action==='admin.remove'&&a.summary.includes('End of assignment')));
  founder.setPermissions(owner,{level:7,permissions:[]});
  assert.equal(founder.canManageLower(member),false);
  assert.throws(()=>founder.staff(member),{status:403});
  assert.throws(()=>founder.setStaff(member,{userId:junior,action:'level',level:1,reason:'No access'}),{status:403});
});

test('Control Center 4.0 restricts overview metrics to each administrators permissions',t=>{
  const {store,owner,member}=fixture(t);
  const v3=store.v3;
  v3.setStaff(owner,{userId:member,action:'level',level:2});
  v3.setPermissions(owner,{level:2,permissions:['tickets.view']});
  const data=v3.overview(member);
  assert.equal(typeof data.tickets,'number');
  assert.equal(data.users,undefined);
  assert.equal(data.revenue,undefined);
  assert.equal(data.bots,undefined);
  assert.throws(()=>v3.staffSearch(member,'test'),{status:403});
  const founder=v3.overview(owner);
  assert.equal(typeof founder.revenue,'number');
  assert.equal(typeof founder.staff,'number');
  v3.setStaff(owner,{userId:member,action:'suspend'});
  assert.throws(()=>v3.overview(member),{status:403});
});

test('Control Center 4.0 web resources and staff endpoints use authenticated role checks',async t=>{
  const {store,owner,member}=fixture(t);
  store.putSession(owner,'cc4-founder');
  store.putSession(member,'cc4-delegate');
  const other=store.register({email:'cc4-target@example.com',name:'Target',digest:'test'}).id;
  store.v3.setStaff(owner,{userId:member,action:'level',level:7});
  const origin='http://localhost:3000';
  const server=createServer({store,origin,workerToken:'w'.repeat(40)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const get=(url,cookie)=>fetch(base+url,{headers:cookie?{cookie:'raymon='+cookie}:{},cache:'no-store'});
  const post=(url,body,cookie)=>fetch(base+url,{method:'POST',headers:{origin,'Content-Type':'application/json',cookie:'raymon='+cookie},body:JSON.stringify(body)});
  assert.equal((await get('/cc4.js')).status,200);
  assert.equal((await get('/api/v3/overview')).status,401);
  assert.equal((await get('/api/v3/staff-search?search=target','cc4-delegate')).status,200);
  assert.equal((await get('/api/v3/staff','cc4-delegate')).status,200);
  assert.equal((await post('/api/v3/permissions',{level:7,permissions:[]},'cc4-delegate')).status,403);
  assert.equal((await post('/api/v3/staff',{userId:other,action:'level',level:2,reason:'Support coverage'},'cc4-delegate')).status,200);
  assert.equal((await post('/api/v3/staff',{userId:other,action:'level',level:7,reason:'No'},'cc4-delegate')).status,403);
  const data=await (await get('/api/v3/overview','cc4-delegate')).json();
  assert.equal(typeof data.staff,'number');
  assert.equal(data.revenue,undefined);
});

test('VIP compact badges use scalable vector artwork, without embedded raster images',async()=>{
  for(const tier of ['silver','gold','diamond']){
    const svg=await fs.readFile(path.join(__dirname,'vip-'+tier+'.svg'),'utf8');
    assert.match(svg,/^<svg\s/);
    assert.match(svg,/viewBox="0 0 240 72"/);
    assert.match(svg,/<text\b[^>]*>VIP<\/text>/);
    assert.doesNotMatch(svg,/<image\b|data:image|base64,/i);
    assert.ok(Buffer.byteLength(svg)<9000);
  }
  const diamond=await fs.readFile(path.join(__dirname,'vip-diamond.svg'),'utf8');
  assert.match(diamond,/Brilliant-cut icy gemstone/);
  assert.match(diamond,/<path\s/);
  const client=await fs.readFile(path.join(__dirname,'vip-ui.js'),'utf8');
  assert.match(client,/heading\.append\(element\('h2',vipLabel\(plan\.tier\)\+' VIP'\),vipBadge\(plan\.tier\)\)/);
  assert.match(client,/identity\.append\(element\('strong',vipLabel\(info\.tier\)\+' VIP'\),vipBadge\(info\.tier\)\)/);
});


test('V5 community verifies staff badges and active VIP tier independently',t=>{
 const {store,owner,member}=fixture(t),v5=store.upgrade5;
 store.vip.grant(owner,{userId:owner,tier:'diamond',days:1});
 store.vip.grant(owner,{userId:member,tier:'gold',days:1});
 assert.deepEqual(v5.role(owner),{role:'FOUNDER',vip:'diamond'});
 assert.deepEqual(v5.role(member),{role:null,vip:'gold'});
 store.v3.setStaff(owner,{userId:member,action:'level',level:7});
 assert.deepEqual(v5.role(member),{role:'CHIEF ADMIN',vip:'gold'});
 store.v3.setStaff(owner,{userId:member,action:'level',level:5});
 assert.deepEqual(v5.role(member),{role:'SENIOR ADMIN',vip:'gold'});
 store.v3.setStaff(owner,{userId:member,action:'level',level:3});
 assert.deepEqual(v5.role(member),{role:'ADMIN',vip:'gold'});
 const post=v5.send(member,'Hello, everyone!');
 const chat=v5.messages(owner);
 assert.equal(chat.enabled,true);
 assert.equal(chat.messages.at(-1).message,'Hello, everyone!');
 assert.equal(chat.messages.at(-1).vip,'gold');
 assert.equal(chat.messages.at(-1).role,'ADMIN');
 assert.throws(()=>v5.send(member,'Immediate spam'),{status:429});
 assert.throws(()=>v5.messageAction(owner,{action:'delete',messageId:post.id}),{status:403});
 v5.messageAction(member,{action:'edit',messageId:post.id,text:'Updated greeting'});
 assert.equal(v5.messages(owner).messages.at(-1).message,'Updated greeting');
});

test('V5 releases enforce founder confirmation and tier-specific beta audiences',t=>{
 const {store,owner,member}=fixture(t),v5=store.upgrade5;
 const prior=v5.releases(owner);
 assert.equal(prior.some(r=>r.feature==='community_chat'&&r.state==='global'),true);
 const releaseId=v5.createRelease(owner,{version:'v5.1.0',title:'Chat Upgrade',description:'New controls',feature:'community_chat'}).id;
 assert.throws(()=>v5.transition(member,releaseId,'global','v5.1.0'),{status:403});
 assert.throws(()=>v5.transition(owner,releaseId,'global','v5.1.0'),{status:409});
 v5.audience(owner,{releaseId,tiers:['gold'],users:[]});
 assert.throws(()=>v5.transition(owner,releaseId,'beta','incorrect'),{status:400});
 v5.transition(owner,releaseId,'beta','v5.1.0');
 assert.equal(v5.hasAccess(member,'community_chat'),true,'Existing global chat remains live during beta');
 assert.equal(v5.myBetas(member).some(r=>r.id===releaseId),false);
 store.vip.grant(owner,{userId:member,tier:'gold',days:2});
 assert.equal(v5.myBetas(member).some(r=>r.id===releaseId),true);
 v5.feedback(member,releaseId,'This version is helpful.');
 assert.equal(v5.feedbackList(owner,releaseId).length,1);
 v5.transition(owner,releaseId,'global','v5.1.0');
 assert.equal(v5.releases(owner).find(r=>r.id===releaseId).state,'global');
 v5.transition(owner,releaseId,'rollback','v5.1.0');
 assert.equal(v5.releases(owner).find(r=>r.id===releaseId).state,'paused');
 assert.equal(v5.hasAccess(member,'community_chat'),true);
});

test('V5 VIP galleries isolate bot images, enforce tiers and respect expiration',t=>{
 const {store,owner,member,advance}=fixture(t),v5=store.upgrade5;
 const other=store.register({email:'other@example.test',name:'Other',digest:'test'}).id;
 store.pair(member,phone);
 const bot=store.deployment(member);
 assert.equal(v5.menu(member,bot.id).enabled,false);
 assert.throws(()=>v5.addImage(member,bot.id,Buffer.from('test')),{status:403});
 store.vip.grant(owner,{userId:member,tier:'diamond',minutes:5});
 assert.throws(()=>v5.setGalleryLimit(member,'diamond',4),{status:403});
 v5.setGalleryLimit(owner,'diamond',4);
 assert.equal(v5.menu(member,bot.id).limit,4);
 const first=v5.addImage(member,bot.id,Buffer.from('img one')).id;
 const second=v5.addImage(member,bot.id,Buffer.from('img two')).id;
 v5.menuConfigure(member,bot.id,{mode:'random',active:[first,second],order:[second,first]});
 assert.equal(v5.menu(member,bot.id).images[0].id,second);
 assert.equal(v5.menu(member,bot.id).images.length,2);
 const live=v5.workerMenu(bot.id);
 assert.equal(live.enabled,true);
 assert.equal(live.images.length,2);
 assert.equal(live.mode,'random');
 assert.throws(()=>v5.menu(other,bot.id),{status:404});
 assert.throws(()=>v5.image(other,bot.id,first),{status:404});
 advance(5*60_000+1);
 assert.equal(v5.workerMenu(bot.id).enabled,false);
 assert.equal(v5.menu(member,bot.id).images.length,2);
});

test('V5 HTTP chat and menu upload endpoints authorize sessions and preserve per-bot storage',async t=>{
 const {store,owner,member}=fixture(t);
 store.putSession(member,'v5-member');
 const origin='http://localhost:3000',server=createServer({store,origin,workerToken:'w'.repeat(40)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=path=>'http://127.0.0.1:'+server.address().port+path;
 const authorized={cookie:'raymon=v5-member'};
 const get=(p,headers={})=>fetch(url(p),{headers});
 const post=(p,value,headers=authorized)=>fetch(url(p),{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await get('/api/v5/chat')).status,401);
 assert.equal((await post('/api/v5/releases',{action:'create',version:'v9.1.0',feature:'community_chat'})).status,403);
 const sent=await post('/api/v5/chat',{text:'Hello everyone'});
 assert.equal(sent.status,201);
 const data=await (await get('/api/v5/chat',authorized)).json();
 assert.equal(data.messages.at(-1).message,'Hello everyone');
 assert.equal(data.messages.at(-1).name,'Member');
 assert.equal((await get('/internal/menu/'+randomUUID())).status,403);
});

test('summons binds quoted claims and replies to a single case across a channel switch',t=>{
  const {store,member,owner,advance}=fixture(t);
  store.pair(owner,phone);
  store.pair(member,phone2);
  const admin=store.deployment(owner),user=store.deployment(member);
  store.sync([report(admin,'online'),report(user,'online')]);
  const svc=store.summons;
  const {id}=svc.create(member,user.id,'My bot disconnected');
  const offer=svc.pending(admin)[0];
  assert.ok(offer);
  const accept={mid:'a',quote:offer.id,text:'.accept',peer:phone};
  store.tx(()=>svc.input(admin,accept));
  store.tx(()=>svc.input(admin,accept));
  assert.equal(store.v3.ticket(owner,id,true).assignee,owner);
  const confirmation=svc.pending(user)[0];
  store.tx(()=>svc.input(user,{mid:'b',quote:confirmation.id,text:'It stopped today.',peer:phone2}));
  assert.equal(store.v3.ticketView(owner,id,true).messages.at(-1).message,'It stopped today.');
  assert.throws(()=>store.v3.ticketAction(owner,true,{action:'assign',ticketId:id,assignee:null},null));
  advance(15000);
  store.v3.ticketAction(owner,true,{action:'switch',ticketId:id},null);
  assert.equal(svc.get(id).support,1);
});
