const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Store,DAY,OWNER_EMAIL}=require('./store');
const {createServer}=require('./server');
const {Worker}=require('./worker');

const profile=(sub,email=sub+'@gmail.com')=>({sub,email,email_verified:true,name:sub});
function fixture(t){
  let now=Date.now();
  const store=new Store(':memory:',()=>now,2);
  t.after(()=>store.db.close());
  store.signIn(profile('owner',OWNER_EMAIL));
  store.signIn(profile('member'));
  return {store,clock:()=>now,advance:ms=>now+=ms};
}
const phone='+2348012345678',phone2='+2348098765432';
const report=(d,status,extra={})=>({id:d.id,generation:d.generation,status,...extra});

test('starter grant is once per verified Google ID and the owner ID stays pinned',t=>{
  const {store}=fixture(t);
  assert.equal(store.signIn(profile('member')).coins,10);
  assert.equal(store.history('member').length,1);
  assert.equal(store.signIn(profile('imposter',OWNER_EMAIL)).is_owner,0);
  assert.equal(store.user('owner').is_owner,1);
  assert.throws(()=>store.signIn({...profile('invalid'),email_verified:false}),{status:403});
});

test('pairing charges only when online, renews once, and pauses when coins run out',t=>{
  const {store,advance,clock}=fixture(t);
  store.pair('member',phone);
  const d=store.deployment('member');
  store.sync([report(d,'code',{code:'ABCD1234'})]);
  assert.equal(store.user('member').coins,10);
  assert.equal(store.dashboard(store.user('member')).deployment.code,'ABCD1234');
  assert.equal(store.dashboard(store.user('owner')).deployment,null);
  assert.ok(!JSON.stringify(store.ownerData('', 'member')).includes('ABCD1234'));
  store.sync([report(d,'online'),report(d,'online')]);
  assert.equal(store.deployment('member').paid_until,clock()+DAY);
  assert.equal(store.user('member').coins,0);
  store.admin('owner','member',{action:'grant',amount:15,reason:'Demo adjustment'});
  advance(DAY);
  store.sync([report(d,'online'),report(d,'online')]);
  assert.equal(store.user('member').coins,5);
  advance(DAY);
  assert.deepEqual(store.sync([report(d,'online')]),[]);
  assert.equal(store.dashboard(store.user('member')).deployment.state,'low_balance');
  assert.equal(store.history('member').filter(x=>x.kind==='uptime').length,2);
});

test('expired pairing attempts cannot charge or permanently reserve a number',t=>{
  const {store,advance}=fixture(t);
  store.pair('member',phone);
  const original=store.deployment('member');
  assert.throws(()=>store.pair('owner',phone),{status:409});
  advance(180_001);
  assert.deepEqual(store.sync([report(original,'online')]),[]);
  assert.equal(store.user('member').coins,10);
  store.pair('owner',phone);
  const fresh=store.deployment('owner');
  store.sync([report(fresh,'online')]);
  assert.throws(()=>store.pair('member',phone),{status:409});
  store.pair('member',phone2);
  assert.equal(store.deployment('member').phone,phone2);
});

test('coin adjustments are owner-only and bans cancel active work',t=>{
  const {store}=fixture(t);
  assert.throws(()=>store.admin('member','member',{action:'grant',amount:10,reason:'unauthorized'}),{status:403});
  assert.throws(()=>store.admin('owner','member',{action:'remove',amount:11,reason:'too many'}),{status:409});
  store.pair('member',phone);
  const d=store.deployment('member');
  store.sync([report(d,'online')]);
  store.admin('owner','member',{action:'ban',reason:'Suspended'});
  assert.deepEqual(store.sync([report(d,'online')]),[]);
  assert.throws(()=>store.control('member','resume'),{status:403});
  assert.equal(store.ownerData('', 'member').audit[0].action,'ban');
  store.admin('owner','member',{action:'unban',reason:'Reviewed'});
  assert.deepEqual(store.sync([]),[]);
  store.control('member','resume');
  assert.equal(store.sync([])[0].id,d.id);
  assert.equal(store.user('member').coins,0);
});

test('HTTP login, owner authorization, request origin, and worker access',async t=>{
  const {store}=fixture(t);
  const token='x'.repeat(48), origin='http://localhost:3000';
  const server=createServer({store,origin,googleId:'test-id',googleSecret:'test-secret',workerToken:token,
    fetcher:async url=>Response.json(url.includes('/token')?{access_token:'test'}:profile('real-user'))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port;
  const get=(url,options)=>fetch(root+url,{redirect:'manual',...options});
  const start=await get('/auth/google');
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const oauth=start.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/auth/callback?state=wrong&code=x',{headers:{cookie:oauth}})).headers.get('location'),'/?error=signin');
  const callback=await get('/auth/callback?state='+state+'&code=x',{headers:{cookie:oauth}});
  assert.equal(callback.headers.get('location'),'/');
  const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('raymon=')).split(';')[0];
  assert.equal((await (await get('/api/me',{headers:{cookie}})).json()).user.coins,10);
  assert.equal((await get('/api/owner',{headers:{cookie}})).status,403);
  const req={method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({phone})};
  assert.equal((await get('/api/pair',req)).status,403);
  assert.equal((await get('/api/pair',{...req,headers:{...req.headers,origin}})).status,202);
  assert.equal((await get('/internal/sync',{...req,body:'{"reports":[]}'})).status,403);
  const tasks=await (await get('/internal/sync',{...req,headers:{...req.headers,authorization:'Bearer '+token},body:'{"reports":[]}'})).json();
  assert.equal(tasks.deployments[0].phone,phone);
  assert.equal((await get('/')).status,200);
  assert.equal((await get('/store.js')).status,404);
});

test('worker opens isolated auth and gates a bot until paid, then stops it on ban',async t=>{
  const {store,clock}=fixture(t);
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
  store.pair('member',phone);
  await worker.tick();
  assert.equal(await bot.onMessages(),undefined);
  await worker.tick();
  assert.equal(store.dashboard(store.user('member')).deployment.code,'TEST1234');
  bot.connected=true;
  await bot.onConnected();
  assert.equal(await bot.onMessages(),undefined);
  await worker.tick();
  assert.equal(await bot.onMessages(),'pong');
  assert.equal(store.user('member').coins,0);
  store.admin('owner','member',{action:'ban',reason:'Stop test'});
  await worker.tick();
  assert.equal(stopped,1);
  assert.equal(await bot.onMessages(),undefined);
});
