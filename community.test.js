const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Community,ADMIN,init,task,report}=require('./community');
const {Store}=require('./store');
async function setup(t,status='200'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'raymon-community-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let calls=0;
  const me=ADMIN.slice(1)+'@s.whatsapp.net';
  const group={id:'123456@g.us',participants:[{id:me,admin:'admin'}]};
  const sock={user:{id:me},groupGetInviteInfo:async()=>group,groupMetadata:async()=>group,
    groupParticipantsUpdate:async(id,numbers,action)=>{calls++;assert.equal(action,'add');assert.deepEqual(numbers,['2348012345678@s.whatsapp.net']);return [{status}];}};
  const entry={task:{phone:ADMIN,community:{phone:'+2348012345678'}},bot:{sock}};
  return {root,group,entry,calls:()=>calls,service:new Community({root,clock:()=>100000})};
}
test('successful addition is never repeated after restart or member leaves',async t=>{
  const f=await setup(t);await f.service.attempt(f.entry,'+2348012345678',()=>true);
  assert.equal(f.entry.communityResult.outcome,'added');assert.equal(f.calls(),1);
  delete f.entry.communityResult;
  await new Community({root:f.root}).attempt(f.entry,'+2348012345678',()=>true);
  assert.equal(f.calls(),1);assert.equal(f.entry.communityResult.outcome,'unknown');
});
test('privacy rejection is skipped without invitation or retry',async t=>{
  const f=await setup(t,'403');await f.service.attempt(f.entry,'+2348012345678',()=>true);
  assert.equal(f.entry.communityResult.outcome,'skipped');
  await f.service.attempt(f.entry,'+2348012345678',()=>true);assert.equal(f.calls(),1);
});
test('existing members, missing admin and expired permission never add',async t=>{
  const f=await setup(t);f.group.participants[0].admin=null;
  await f.service.attempt(f.entry,'+2348012345678',()=>true);assert.equal(f.calls(),0);
  f.group.participants[0].admin='admin';
  await f.service.attempt(f.entry,'+2348012345678',()=>false);assert.equal(f.calls(),0);
  f.group.participants.push({id:'2348012345678@s.whatsapp.net'});
  await f.service.attempt(f.entry,'+2348012345678',()=>true);
  assert.equal(f.entry.communityResult.outcome,'already_member');assert.equal(f.calls(),0);
});
test('another deployment cannot run additions',async t=>{
  const f=await setup(t);f.entry.task.phone='+2348099999999';f.service.run(f.entry,()=>true);
  assert.equal(f.service.running,null);assert.equal(f.calls(),0);
});
test('store includes previously verified users and accepts only designated admin results',()=>{
  const s=new Store(':memory:');
  try{
    const u=s.register({email:'test@example.com',name:'Test',digest:'test'});
    s.run('INSERT INTO verified_numbers VALUES (?,?)','+2348012345678',u.id);
    const d={phone:ADMIN,linked:1,intent:'run'};
    assert.equal(task(s,d).phone,'+2348012345678');
    const result={status:'online',community:{phone:'+2348012345678',outcome:'skipped'}};
    report(s,{...d,phone:'+2348099999999'},result,1);assert.ok(task(s,d));
    report(s,d,result,2);assert.equal(task(s,d),null);
    init(s);assert.equal(task(s,d),null);
  }finally{s.db.close();}
});
