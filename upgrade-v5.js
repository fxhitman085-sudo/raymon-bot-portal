'use strict';
const {randomUUID}=require('node:crypto');
const cleanText=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)?value.trim():null;
const tiers=['silver','gold','diamond'];
class UpgradeV5 {
 constructor(s,ErrorType){
  this.s=s;this.Error=ErrorType;
  s.db.exec(`
   CREATE TABLE IF NOT EXISTS v5_chat_messages(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL,
    reply_to TEXT REFERENCES v5_chat_messages(id),created INTEGER NOT NULL,
    edited INTEGER,deleted INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS v5_chat_order ON v5_chat_messages(created DESC,id DESC);
   CREATE TABLE IF NOT EXISTS v5_chat_reports(
    message_id TEXT NOT NULL REFERENCES v5_chat_messages(id),
    reporter_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created INTEGER NOT NULL,
    PRIMARY KEY(message_id,reporter_id)
   );
   CREATE TABLE IF NOT EXISTS v5_chat_mutes(
    user_id TEXT PRIMARY KEY REFERENCES users(id),until INTEGER NOT NULL,actor TEXT REFERENCES users(id),reason TEXT
   );
   CREATE TABLE IF NOT EXISTS v5_chat_limits(user_id TEXT PRIMARY KEY REFERENCES users(id),last_post INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS v5_releases(
    id TEXT PRIMARY KEY,version TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,
    feature TEXT NOT NULL CHECK(feature IN ('community_chat','vip_menu_gallery')),
    state TEXT NOT NULL CHECK(state IN ('draft','beta','global','paused')),
    created INTEGER NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL REFERENCES users(id)
   );
   CREATE TABLE IF NOT EXISTS v5_release_history(
    id TEXT PRIMARY KEY,release_id TEXT NOT NULL REFERENCES v5_releases(id),
    actor TEXT NOT NULL REFERENCES users(id),
    from_state TEXT,to_state TEXT NOT NULL,created INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS v5_release_history_order ON v5_release_history(release_id,created DESC);
   CREATE TABLE IF NOT EXISTS v5_release_audience(
    release_id TEXT NOT NULL REFERENCES v5_releases(id),kind TEXT NOT NULL CHECK(kind IN ('user','tier')),
    value TEXT NOT NULL,PRIMARY KEY(release_id,kind,value)
   );
   CREATE TABLE IF NOT EXISTS v5_release_feedback(
    release_id TEXT NOT NULL REFERENCES v5_releases(id),user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,created INTEGER NOT NULL,
    PRIMARY KEY(release_id,user_id,created)
   );
   CREATE TABLE IF NOT EXISTS v5_menu_images(
    id TEXT PRIMARY KEY,deployment_id TEXT NOT NULL REFERENCES deployments(id),
    user_id TEXT NOT NULL REFERENCES users(id),jpeg BLOB NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL,created INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS v5_menu_owner ON v5_menu_images(deployment_id,user_id,position);
   CREATE TABLE IF NOT EXISTS v5_menu_options(
    deployment_id TEXT PRIMARY KEY REFERENCES deployments(id),
    mode TEXT NOT NULL DEFAULT 'sequential',revision TEXT NOT NULL
   );
  `);
 }
 seed(){
  const actor=this.s.get('SELECT user_id AS id FROM owner WHERE singleton=1')||
    this.s.get('SELECT id FROM users ORDER BY created LIMIT 1');
  if(!actor)return;
  for(const [feature,version,title] of [
   ['community_chat','v5.0.0-community','RAYMON Community Chat'],
   ['vip_menu_gallery','v5.0.0-menu','VIP Menu Gallery']
  ]){
   if(!this.s.get('SELECT 1 FROM v5_releases WHERE feature=? LIMIT 1',feature)){
    const now=this.s.clock();
    const rid=randomUUID();
    this.s.run("INSERT INTO v5_releases VALUES (?,?,?,?,?,'global',?,?,?)",
      rid,version,title,'First stable release',feature,now,now,actor.id);
    this.s.run("INSERT INTO v5_release_history VALUES (?,?,?,?,?,?)",
      randomUUID(),rid,actor.id,null,'global',now);
   }
  }
 }
 fail(status,message){throw new this.Error(status,message);}
 founder(id){const u=this.s.requireActive(id);if(!u.is_owner)this.fail(403,'Founder access required.');return u;}
 role(id){
  const u=this.s.user(id);if(!u||u.banned||u.closed_at)return {role:null,vip:null};
  const staff=this.s.v3.role(u);
  const level=staff.suspended?null:staff.level;
  const role=u.is_owner?'FOUNDER':level===7?'CHIEF ADMIN':level>=5?'SENIOR ADMIN':level>=1?'ADMIN':null;
  return {role,vip:this.s.vip.membership(id)?.tier||null};
 }
 release(feature){this.seed();return this.s.get("SELECT * FROM v5_releases WHERE feature=? AND state IN ('beta','global') ORDER BY updated DESC LIMIT 1",feature);}
 hasAccess(id,feature){
  const r=this.release(feature);
  if(!r)return false;
  if(r.state==='global'||this.s.get("SELECT 1 FROM v5_releases WHERE feature=? AND state='global'",feature))return true;
  const member=this.s.vip.membership(id)?.tier;
  return !!this.s.get(`SELECT 1 FROM v5_release_audience WHERE release_id=?
    AND ((kind='user' AND value=?) OR (kind='tier' AND value=?)) LIMIT 1`,r.id,id,member||'');
 }
 // Existing community chat can be turned off immediately via release state.
 messages(id,after=0){
  this.s.requireActive(id);
  if(!this.hasAccess(id,'community_chat'))return {enabled:false,messages:[]};
  const cutoff=Number.isSafeInteger(after)&&after>=0?after:0;
  const rows=this.s.all(`SELECT m.id,m.user_id AS userId,u.name,u.banned,p.closed_at,
      m.message,m.reply_to AS replyTo,m.created,m.edited,m.deleted,m.pinned
    FROM v5_chat_messages m JOIN users u ON u.id=m.user_id
    LEFT JOIN portal_profiles p ON p.user_id=u.id
    WHERE m.created>? ORDER BY m.created DESC,m.rowid DESC LIMIT 100`,cutoff).reverse();
  return {enabled:true,messages:rows.map(r=>({
   id:r.id,userId:r.userId,name:r.name,role:this.role(r.userId).role,
   vip:this.role(r.userId).vip,message:r.deleted?'':r.message,
   replyTo:r.replyTo,created:r.created,edited:r.edited,deleted:!!r.deleted,pinned:!!r.pinned
  }))};
 }
 send(id,text,replyTo=null){
  this.s.requireActive(id);
  if(!this.hasAccess(id,'community_chat'))this.fail(403,'Community chat is not available to your account yet.');
  const message=cleanText(text,1200);
  if(!message)this.fail(400,'Enter a message of up to 1,200 characters.');
  const now=this.s.clock(),mute=this.s.get('SELECT until FROM v5_chat_mutes WHERE user_id=?',id);
  if(mute?.until>now)this.fail(403,'You are temporarily muted in the community.');
  const replying=replyTo===null?null:this.s.get('SELECT id FROM v5_chat_messages WHERE id=? AND deleted=0',replyTo);
  if(replyTo!==null&&!replying)this.fail(404,'Reply target was not found.');
  return this.s.tx(()=>{
   const previous=this.s.get('SELECT last_post FROM v5_chat_limits WHERE user_id=?',id);
   if(previous&&now-previous.last_post<2500)this.fail(429,'Please wait before sending another message.');
   if(this.s.get('SELECT COUNT(*) AS n FROM v5_chat_messages WHERE user_id=? AND created>?',id,now-60_000).n>=18)this.fail(429,'Chat slow mode: try again shortly.');
   const uuid=randomUUID();
   this.s.run('INSERT INTO v5_chat_messages(id,user_id,message,reply_to,created) VALUES (?,?,?,?,?)',uuid,id,message,replyTo,now);
   this.s.run(`INSERT INTO v5_chat_limits VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_post=excluded.last_post`,id,now);
   return {id:uuid,created:now};
  });
 }
 moderate(actor,action,messageId,targetId,reason='',until=0){
  const user=this.s.requireActive(actor),role=this.s.v3.role(user);
  const allowed=user.is_owner||(!role.suspended&&role.level>=1&&role.permissions.includes('users.moderate'));
  if(!allowed)this.fail(403,'Community moderation permission required.');
  if(action==='dismiss'){
   this.s.run('DELETE FROM v5_chat_reports WHERE message_id=?',messageId);
  }else if(action==='delete'||action==='pin'||action==='unpin'){
   const row=this.s.get('SELECT id FROM v5_chat_messages WHERE id=?',messageId);
   if(!row)this.fail(404,'Message not found.');
   if(action==='delete')this.s.run("UPDATE v5_chat_messages SET message='',deleted=1,pinned=0 WHERE id=?",messageId);
   else this.s.run('UPDATE v5_chat_messages SET pinned=? WHERE id=? AND deleted=0',Number(action==='pin'),messageId);
  }else if(action==='mute'||action==='unmute'){
   const target=this.s.user(targetId);
   if(!target||target.is_owner||target.closed_at)this.fail(403,'Cannot mute this account.');
   if(!user.is_owner&&(this.s.v3.role(target).level||0)>=(role.level||0))this.fail(403,'Cannot moderate equal or higher-ranked staff.');
   if(action==='mute'){
    if(!Number.isInteger(until)||until<5||until>10080)this.fail(400,'Choose 5 to 10,080 minutes.');
    this.s.run(`INSERT INTO v5_chat_mutes(user_id,until,actor,reason) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET until=excluded.until,actor=excluded.actor,reason=excluded.reason`,
      targetId,this.s.clock()+until*60000,actor,String(reason).slice(0,180));
   }else this.s.run('DELETE FROM v5_chat_mutes WHERE user_id=?',targetId);
  }else this.fail(400,'Unknown moderation action.');
  this.s.v3.audit(actor,'community.'+action,messageId||targetId,String(reason).slice(0,180));
  return {ok:true};
 }
 messageAction(id,{action,messageId,text,reason}){
  this.s.requireActive(id);
  const row=this.s.get('SELECT * FROM v5_chat_messages WHERE id=?',messageId);
  if(!row||row.deleted)this.fail(404,'Message not found.');
  if(action==='edit'||action==='delete'){
   if(row.user_id!==id)this.fail(403,'You can only edit or delete your own messages.');
   if(this.s.clock()-row.created>24*60*60*1000)this.fail(409,'Message edit and deletion window has expired.');
   if(action==='delete')this.s.run("UPDATE v5_chat_messages SET message='',deleted=1,pinned=0 WHERE id=?",messageId);
   else{
    const next=cleanText(text,1200);if(!next)this.fail(400,'Enter a valid message.');
    this.s.run('UPDATE v5_chat_messages SET message=?,edited=? WHERE id=?',next,this.s.clock(),messageId);
   }
  }else if(action==='report'){
   const why=cleanText(reason,300);
   if(!why)this.fail(400,'Provide a brief report reason.');
   if(row.user_id===id)this.fail(400,'You cannot report your own message.');
   this.s.run('INSERT OR IGNORE INTO v5_chat_reports VALUES (?,?,?,?)',messageId,id,why,this.s.clock());
  }else this.fail(400,'Unknown message action.');
  return {ok:true};
 }
 reports(actor){
  this.s.v3.permit(actor,'users.moderate');
  return this.s.all(`SELECT r.message_id AS messageId,r.reason,r.created,m.message,m.deleted,
    m.user_id AS userId,u.name,COUNT(*) OVER(PARTITION BY r.message_id) AS reports
    FROM v5_chat_reports r JOIN v5_chat_messages m ON m.id=r.message_id
    JOIN users u ON u.id=m.user_id ORDER BY r.created DESC LIMIT 60`);
 }
 releases(id){
  this.founder(id);this.seed();
  const items=this.s.all('SELECT * FROM v5_releases ORDER BY updated DESC LIMIT 60');
  return items.map(r=>({...r,audience:this.s.all('SELECT kind,value FROM v5_release_audience WHERE release_id=?',r.id),
   feedback:this.s.get('SELECT COUNT(*) AS n FROM v5_release_feedback WHERE release_id=?',r.id).n}));
 }
 createRelease(id,{version,title,description,feature}){
  this.founder(id);this.seed();
  if(!/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version||'')||!cleanText(title,90)||!cleanText(description,1600)||!['community_chat','vip_menu_gallery'].includes(feature))
   this.fail(400,'Enter a semantic version, title, details, and a deployed feature.');
  const releaseId=randomUUID(),now=this.s.clock();
  this.s.run("INSERT INTO v5_releases VALUES (?,?,?,?,?,'draft',?,?,?)",releaseId,version,title.trim(),description.trim(),feature,now,now,id);
  this.s.v3.audit(id,'release.create',releaseId,version+' · '+feature);
  return {id:releaseId};
 }
 audience(id,{releaseId,users=[],tiers:chosen=[]}){
  this.founder(id);
  const r=this.s.get('SELECT * FROM v5_releases WHERE id=?',releaseId);
  if(!r||!['draft','beta'].includes(r.state))this.fail(409,'Choose a draft or beta release.');
  if(!Array.isArray(users)||users.length>100||!Array.isArray(chosen)||chosen.length>3||chosen.some(t=>!tiers.includes(t)))this.fail(400,'Choose valid beta testers.');
  const allUsers=[...new Set(users)];
  for(const uid of allUsers)if(!this.s.user(uid)||this.s.user(uid).banned||this.s.user(uid).closed_at)this.fail(400,'One of the selected testers does not exist.');
  this.s.tx(()=>{
   this.s.run('DELETE FROM v5_release_audience WHERE release_id=?',releaseId);
   for(const uid of allUsers)this.s.run("INSERT INTO v5_release_audience VALUES (?,'user',?)",releaseId,uid);
   for(const t of new Set(chosen))this.s.run("INSERT INTO v5_release_audience VALUES (?,'tier',?)",releaseId,t);
  });
  this.s.v3.audit(id,'release.audience',releaseId,allUsers.length+' users · '+chosen.join(','));
  return {ok:true};
 }
 transition(id,releaseId,next,confirmation){
  this.founder(id);
  const r=this.s.get('SELECT * FROM v5_releases WHERE id=?',releaseId);
  if(!r)this.fail(404,'Release not found.');
  if(!['beta','global','paused','rollback'].includes(next))this.fail(400,'Unknown release status.');
  if(confirmation!==r.version)this.fail(400,'Type the release version to confirm.');
  if(next==='beta'&&r.state!=='draft'&&r.state!=='paused')this.fail(409,'Start beta from a draft or paused release.');
  if(next==='global'&&r.state!=='beta')this.fail(409,'Only a tested beta can launch globally.');
  if(next==='paused'&&!['beta','global'].includes(r.state))this.fail(409,'Only active releases can be paused.');
  if(next==='rollback'&&r.state!=='global')this.fail(409,'Only the current global release can be rolled back.');
  if(next==='beta'&&!this.s.get('SELECT 1 FROM v5_release_audience WHERE release_id=?',releaseId))this.fail(409,'Select testers before starting beta.');
  // A feature shipped in this application is switched by a server-side feature gate;
  // code not present in this deployed version cannot be pushed by this control.
  let actual=next;
  this.s.tx(()=>{
   const now=this.s.clock();
   if(next==='rollback'){
    const old=this.s.get(`SELECT rr.id,rr.version FROM v5_releases rr JOIN v5_release_history h ON h.release_id=rr.id
      WHERE rr.feature=? AND rr.id<>? AND rr.state='paused' AND h.to_state='global'
      ORDER BY h.created DESC LIMIT 1`,r.feature,releaseId);
    if(!old)this.fail(409,'No previous stable release is available to restore.');
    this.s.run("UPDATE v5_releases SET state='paused',updated=? WHERE id=?",now,releaseId);
    this.s.run("UPDATE v5_releases SET state='global',updated=? WHERE id=?",now,old.id);
    this.s.run('INSERT INTO v5_release_history VALUES (?,?,?,?,?,?)',randomUUID(),releaseId,id,r.state,'paused',now);
    this.s.run('INSERT INTO v5_release_history VALUES (?,?,?,?,?,?)',randomUUID(),old.id,id,'paused','global',now);
    this.s.v3.audit(id,'release.rollback',releaseId,'Restored '+old.version);
    actual='global';
   }else{
    // Beta and the current stable version run side by side. Only a global
    // launch replaces the stable release, preventing unselected users from
    // losing core community features while new changes are tested.
    if(next==='beta')this.s.run("UPDATE v5_releases SET state='paused',updated=? WHERE feature=? AND id<>? AND state='beta'",now,r.feature,releaseId);
    if(next==='global')this.s.run("UPDATE v5_releases SET state='paused',updated=? WHERE feature=? AND id<>? AND state IN ('beta','global')",now,r.feature,releaseId);
    this.s.run('UPDATE v5_releases SET state=?,updated=? WHERE id=?',next,now,releaseId);
    this.s.run('INSERT INTO v5_release_history VALUES (?,?,?,?,?,?)',randomUUID(),releaseId,id,r.state,next,now);
    this.s.v3.audit(id,'release.'+next,releaseId,r.version+' · '+r.feature);
    if(next==='global')this.s.run('INSERT INTO portal_announcements VALUES (?,?,?,?)',
     randomUUID(),'RAYMON BOT '+r.version+' released',r.title+' — '+r.description,now);
   }
  });
  return {ok:true,state:actual};
 }
 myBetas(id){
  this.s.requireActive(id);this.seed();
  const releases=this.s.all("SELECT * FROM v5_releases WHERE state='beta' ORDER BY updated DESC LIMIT 30");
  return releases.filter(r=>this.isTester(id,r)).map(r=>({id:r.id,title:r.title,version:r.version,
    feature:r.feature,description:r.description}));
 }
 isTester(id,r){
  const tier=this.s.vip.membership(id)?.tier;
  return !!this.s.get(`SELECT 1 FROM v5_release_audience WHERE release_id=?
    AND ((kind='user' AND value=?) OR (kind='tier' AND value=?))`,r.id,id,tier||'');
 }
 feedback(id,releaseId,description){
  this.s.requireActive(id);
  const r=this.s.get('SELECT * FROM v5_releases WHERE id=?',releaseId);
  if(!r||r.state!=='beta'||!this.isTester(id,r))this.fail(403,'Beta access required.');
  const text=cleanText(description,1200);if(!text)this.fail(400,'Enter beta feedback.');
  this.s.run('INSERT INTO v5_release_feedback VALUES (?,?,?,?)',releaseId,id,text,this.s.clock());
  return {ok:true};
 }
 feedbackList(id,releaseId){
  this.founder(id);
  return this.s.all(`SELECT f.text,f.created,u.name FROM v5_release_feedback f JOIN users u ON u.id=f.user_id
   WHERE f.release_id=? ORDER BY f.created DESC LIMIT 100`,releaseId);
 }
 menu(id,botId){
  this.s.requireActive(id);
  const bot=this.s.deployment(id,botId);
  if(!bot)this.fail(404,'Bot not found.');
  const tier=this.s.vip.membership(id)?.tier||null;
  const enabled=!!tier&&this.hasAccess(id,'vip_menu_gallery');
  const row=this.s.get('SELECT mode,revision FROM v5_menu_options WHERE deployment_id=?',bot.id);
  const items=this.s.all('SELECT id,enabled,position,created FROM v5_menu_images WHERE deployment_id=? ORDER BY position,created',bot.id);
  return {enabled,tier,limit:tier==='diamond'?10:tier?1:0,mode:row?.mode||'sequential',revision:row?.revision||null,images:items};
 }
 addImage(id,botId,jpeg){
  const state=this.menu(id,botId);
  if(!state.enabled)this.fail(403,'An active eligible VIP membership is required.');
  if(!Buffer.isBuffer(jpeg)||jpeg.length>1024*1024)this.fail(400,'Invalid menu image.');
  if(state.images.length>=state.limit)this.fail(409,'Your VIP gallery limit has been reached. Remove an image first.');
  const imgId=randomUUID();
  this.s.tx(()=>{
   this.s.run('INSERT INTO v5_menu_images VALUES (?,?,?,?,1,?,?)',imgId,botId,id,jpeg,state.images.length,this.s.clock());
   this.touchMenu(botId);
  });
  return {id:imgId};
 }
 touchMenu(botId){
  this.s.run(`INSERT INTO v5_menu_options VALUES (?,'sequential',?) ON CONFLICT(deployment_id)
  DO UPDATE SET revision=excluded.revision`,botId,randomUUID());
 }
 menuConfigure(id,botId,{mode,active}){
  const state=this.menu(id,botId);
  if(!state.enabled)this.fail(403,'VIP menu customization is unavailable.');
  if(!['fixed','sequential','random'].includes(mode)||state.tier!=='diamond'&&mode!=='fixed'||!Array.isArray(active)||active.length>state.limit||active.some(x=>typeof x!=='string'))
   this.fail(400,'Select a valid display mode and active images.');
  const unique=[...new Set(active)];
  if(unique.some(key=>!state.images.some(img=>img.id===key)))this.fail(400,'Unknown image.');
  this.s.tx(()=>{
   this.s.run(`INSERT INTO v5_menu_options VALUES (?,?,?) ON CONFLICT(deployment_id)
     DO UPDATE SET mode=excluded.mode,revision=excluded.revision`,botId,mode,randomUUID());
   for(const image of state.images)this.s.run('UPDATE v5_menu_images SET enabled=? WHERE id=?',Number(unique.includes(image.id)),image.id);
  });
  return {ok:true};
 }
 removeImage(id,botId,img){
  this.menu(id,botId);
  this.s.tx(()=>{
   if(!this.s.get('SELECT id FROM v5_menu_images WHERE id=? AND deployment_id=? AND user_id=?',img,botId,id))this.fail(404,'Menu image not found.');
   this.s.run('DELETE FROM v5_menu_images WHERE id=?',img);this.touchMenu(botId);
  });
  return {ok:true};
 }
 image(id,botId,imageId){
  this.s.requireActive(id);
  if(!this.s.deployment(id,botId))this.fail(404,'Bot not found.');
  const row=this.s.get('SELECT jpeg FROM v5_menu_images WHERE id=? AND deployment_id=?',imageId,botId);
  if(!row)this.fail(404,'Menu image not found.');
  return row.jpeg;
 }
 workerMenu(botId){
  const d=this.s.get('SELECT * FROM deployments WHERE id=?',botId);
  if(!d)return {enabled:false};
  const membership=this.s.vip.membership(d.user_id);
  if(!membership||!this.hasAccess(d.user_id,'vip_menu_gallery'))return {enabled:false};
  const state=this.menu(d.user_id,botId);
  const images=this.s.all('SELECT id FROM v5_menu_images WHERE deployment_id=? AND enabled=1 ORDER BY position,created',botId)
    .map(r=>r.id).slice(0,membership.tier==='diamond'?10:1);
  return {enabled:!!images.length,mode:membership.tier==='diamond'?state.mode:'fixed',revision:state.revision,images};
 }
}
module.exports={UpgradeV5};
