const community=require('./community');
const {DEFAULTS,validate,groupId,groupOptions}=require('./bot-settings');
const {DatabaseSync}=require('node:sqlite');
const {PortalV3,ACCOUNT_PERMISSIONS,ADMIN_ACTIONS}=require('./portal-v3');
const {randomUUID,createHash}=require('node:crypto');

const DAY=86_400_000, PRICE=10, PAIR_WINDOW=180_000;
const PAIRING_REPORT_TTL=12_000;
const LOW_BALANCE_WINDOW=6*60*60_000, RESET_WINDOW=30*60_000;
const OWNER_EMAIL='abdulganiy346@gmail.com';
const BAN_MESSAGE='You have been banned. Kindly contact the support team.';
const LAGOS_OFFSET=3_600_000;
const hash=value=>createHash('sha256').update(value).digest('hex');
class PortalError extends Error {
  constructor(status,message){super(message);this.status=status;}
}

class Store {
  constructor(file,clock=Date.now,maxBots=8){
    this.clock=clock;
    this.maxBots=maxBots;
    this.db=new DatabaseSync(file);
    this.codes=new Map();
    this.groupRequests=new Map();
    this.workerSeen=null;
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL,
        coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),
        banned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS users_login_email ON users(lower(email));
      CREATE TABLE IF NOT EXISTS passwords (
        email TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL,
        kind TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id,created DESC);
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), phone TEXT NOT NULL,
        generation TEXT NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0,
        paid_until INTEGER NOT NULL DEFAULT 0, pair_until INTEGER NOT NULL DEFAULT 0,
        requested INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS verified_numbers (phone TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfers (
        sender TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        recipient TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL, amount INTEGER NOT NULL,
        PRIMARY KEY(sender,request_id)
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        token TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES passwords(email),
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS password_resets_email ON password_resets(email);
      CREATE TABLE IF NOT EXISTS renewal_notices (
        deployment_id TEXT PRIMARY KEY REFERENCES deployments(id), paid_until INTEGER NOT NULL
      );
    `);
    const columns=this.all('PRAGMA table_info(deployments)');
    if(!columns.some(column=>column.name==='verified_phone')){
      this.db.exec('PRAGMA foreign_keys=OFF');
      try{
        this.tx(()=>this.db.exec(`
          CREATE TABLE deployments_next (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), phone TEXT NOT NULL,
            generation TEXT NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0,
            paid_until INTEGER NOT NULL DEFAULT 0, pair_until INTEGER NOT NULL DEFAULT 0,
            requested INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, verified_phone TEXT
          );
          INSERT INTO deployments_next SELECT d.*,v.phone FROM deployments d
            LEFT JOIN verified_numbers v ON v.user_id=d.user_id;
          DROP TABLE deployments;
          ALTER TABLE deployments_next RENAME TO deployments;
          CREATE INDEX deployments_user ON deployments(user_id,requested,id);
          CREATE TABLE verified_numbers_next (phone TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
          INSERT INTO verified_numbers_next SELECT phone,user_id FROM verified_numbers;
          DROP TABLE verified_numbers;
          ALTER TABLE verified_numbers_next RENAME TO verified_numbers;
        `));
      }finally{this.db.exec('PRAGMA foreign_keys=ON');}
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS bot_settings (
      deployment_id TEXT PRIMARY KEY REFERENCES deployments(id), revision TEXT,
      patch TEXT NOT NULL DEFAULT '{}', applied TEXT
    );
    CREATE TABLE IF NOT EXISTS portal_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id), username TEXT COLLATE NOCASE UNIQUE,
      theme TEXT NOT NULL DEFAULT 'dark', referral_code TEXT NOT NULL UNIQUE,
      referred_by TEXT REFERENCES users(id), closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS portal_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), deployment_id TEXT REFERENCES deployments(id),
      title TEXT NOT NULL, description TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_events_user ON portal_events(user_id,created DESC);
    CREATE INDEX IF NOT EXISTS portal_events_deployment ON portal_events(deployment_id,created DESC);
    CREATE TABLE IF NOT EXISTS portal_announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_notice_state (
      user_id TEXT NOT NULL REFERENCES users(id), notice_id TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,notice_id)
    );
    CREATE TABLE IF NOT EXISTS portal_restart (
      deployment_id TEXT PRIMARY KEY REFERENCES deployments(id), token TEXT NOT NULL, requested INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_avatars (
      user_id TEXT PRIMARY KEY REFERENCES users(id), version TEXT NOT NULL, jpeg BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_rewards (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      daily_enabled INTEGER NOT NULL, daily_amount INTEGER NOT NULL,
      referral_enabled INTEGER NOT NULL, inviter_amount INTEGER NOT NULL,
      invitee_amount INTEGER NOT NULL, referral_trigger TEXT NOT NULL
    );
    INSERT OR IGNORE INTO portal_rewards VALUES (1,1,2,1,5,5,'online');
    CREATE TABLE IF NOT EXISTS portal_referral_rewards (
      invitee TEXT PRIMARY KEY REFERENCES users(id), inviter TEXT NOT NULL REFERENCES users(id),
      inviter_amount INTEGER NOT NULL, invitee_amount INTEGER NOT NULL, trigger TEXT NOT NULL,
      paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS portal_referral_rewards_inviter ON portal_referral_rewards(inviter);
    `);
    this.tx(()=>{
      for(const user of this.all('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM portal_profiles)')){
        this.createProfile(user.id);
      }
    });
    this.v3=new PortalV3(this,PortalError);
    community.init(this);
  }
  get(sql,...params){return this.db.prepare(sql).get(...params);}
  all(sql,...params){return this.db.prepare(sql).all(...params);}
  run(sql,...params){return this.db.prepare(sql).run(...params);}
  tx(fn){
    this.db.exec('BEGIN IMMEDIATE');
    try{const value=fn();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  credit(userId,delta,kind,reason,actor=null,id=randomUUID()){
    this.run('INSERT INTO ledger VALUES (?,?,?,?,?,?,?)',id,userId,delta,kind,reason,actor,this.clock());
    this.run('UPDATE users SET coins=coins+? WHERE id=?',delta,userId);
  }
  transfer(senderId,email,amount,requestId){
    if(!Number.isSafeInteger(amount)||amount<1||amount>1_000_000||
      typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))
      throw new PortalError(400,'Enter a whole amount between 1 and 1,000,000 coins.');
    return this.tx(()=>{
      const sender=this.requireActive(senderId);
      const prior=this.get('SELECT email,amount FROM transfers WHERE sender=? AND request_id=?',senderId,requestId);
      if(prior){
        if(prior.email!==email||prior.amount!==amount)throw new PortalError(409,'This transfer has already been submitted.');
        return;
      }
      const recipient=this.get(`SELECT u.* FROM users u JOIN passwords p ON p.user_id=u.id
        WHERE p.email=? AND u.banned=0`,email);
      if(!recipient)throw new PortalError(404,'No eligible portal account matches that email address.');
      if(recipient.id===sender.id)throw new PortalError(400,'Choose a different recipient.');
      if(sender.coins<amount)throw new PortalError(409,'You do not have enough coins for this transfer.');
      if(recipient.coins+amount>1_000_000)throw new PortalError(409,'This transfer would exceed the recipient’s balance limit.');
      this.run('INSERT INTO transfers VALUES (?,?,?,?,?)',senderId,requestId,recipient.id,email,amount);
      this.credit(sender.id,-amount,'transfer_out','Coins sent to '+email,sender.id);
      this.credit(recipient.id,amount,'transfer_in','Coins received from '+sender.email,sender.id);
    });
  }
  password(email){return this.get('SELECT user_id,digest FROM passwords WHERE email=?',email);}
  issuePasswordReset(email,token){
    return this.tx(()=>{
      const saved=this.password(email);
      const user=saved&&this.user(saved.user_id);
      if(!user||user.banned||user.closed_at)return false;
      const now=this.clock();
      this.run('DELETE FROM password_resets WHERE expires<=?',now);
      this.run('INSERT INTO password_resets VALUES (?,?,?)',hash(token),email,now+RESET_WINDOW);
      return true;
    });
  }
  passwordReset(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    return this.get(`SELECT r.email FROM password_resets r JOIN passwords p ON p.email=r.email
      JOIN users u ON u.id=p.user_id WHERE r.token=? AND r.expires>? AND u.banned=0`,hash(token),this.clock());
  }
  resetPassword(token,digest){
    this.tx(()=>{
      const reset=this.passwordReset(token);
      if(!reset)throw new PortalError(400,'This reset link is invalid or expired. Request a new one.');
      const {user_id:id}=this.password(reset.email);
      this.run('UPDATE passwords SET digest=? WHERE email=?',digest,reset.email);
      this.run('DELETE FROM sessions WHERE user_id=?',id);
      this.run('DELETE FROM password_resets WHERE email=?',reset.email);
    });
  }
  hasPassword(userId){return !!this.get('SELECT 1 FROM passwords WHERE user_id=?',userId);}
  register({email,name,digest,username=null,referral=null}){
    return this.tx(()=>{
      if(email===OWNER_EMAIL)throw new PortalError(403,'Use the existing Founder sign-in.');
      if(this.password(email)||this.get('SELECT id FROM users WHERE lower(email)=?',email))
        throw new PortalError(409,'This account already exists. Sign in or use your existing session to set a password.');
      const id=randomUUID();
      this.run('INSERT INTO users(id,email,name,created) VALUES (?,?,?,?)',id,email,name,this.clock());
      this.credit(id,10,'starter','One-time starter coins',null,'starter:'+id);
      this.run('INSERT INTO passwords VALUES (?,?,?)',email,id,digest);
      this.createProfile(id,username,referral);
      this.recordReferral(id);
      this.v3.saveOnboarding(id,0);
      this.event(id,null,'Welcome to RAYMON BOT','Your account received 10 starter coins. Deploy a bot to get started.');
      return this.user(id);
    });
  }
  setPasswordForSession(userId,email,digest){
    return this.tx(()=>{
      const user=this.requireActive(userId);
      if(this.hasPassword(userId)||this.password(email))throw new PortalError(409,'A password is already configured.');
      if(email===OWNER_EMAIL&&!user.is_owner)throw new PortalError(403,'Owner setup is restricted.');
      this.run('INSERT INTO passwords VALUES (?,?,?)',email,userId,digest);
      return user;
    });
  }
  user(id){return this.get(`SELECT u.*,p.username,p.theme,p.referral_code,p.closed_at,
    EXISTS(SELECT 1 FROM owner WHERE user_id=u.id) AS is_owner
    FROM users u LEFT JOIN portal_profiles p ON p.user_id=u.id WHERE u.id=?`,id);}
  createProfile(id,username=null,referral=null){
    const ref=referral&&this.get('SELECT user_id FROM portal_profiles WHERE referral_code=? AND closed_at IS NULL',referral);
    this.run('INSERT INTO portal_profiles (user_id,referral_code,referred_by) VALUES (?,?,?)',
      id,hash('raymon-referral:'+id).slice(0,16),ref?.user_id||null);
    if(username)this.updateUsername(id,username);
  }
  rewardConfig(){
    return this.get(`SELECT daily_enabled AS dailyEnabled,daily_amount AS dailyAmount,
      referral_enabled AS referralEnabled,inviter_amount AS inviterAmount,invitee_amount AS inviteeAmount,
      referral_trigger AS referralTrigger FROM portal_rewards WHERE singleton=1`);
  }
  updateRewardConfig(id,data){
    return this.tx(()=>{
      if(!this.requireActive(id).is_owner)throw new PortalError(403,'Owner access required.');
      const {dailyEnabled,dailyAmount,referralEnabled,inviterAmount,inviteeAmount,referralTrigger}=data||{};
      if(typeof dailyEnabled!=='boolean'||typeof referralEnabled!=='boolean'||
        ![dailyAmount,inviterAmount,inviteeAmount].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000)||
        dailyEnabled&&dailyAmount===0||referralEnabled&&inviterAmount+inviteeAmount===0||
        !['online','signup'].includes(referralTrigger))throw new PortalError(400,'Check the reward amounts and payout settings.');
      this.run('UPDATE portal_rewards SET daily_enabled=?,daily_amount=?,referral_enabled=?,inviter_amount=?,invitee_amount=?,referral_trigger=? WHERE singleton=1',
        Number(dailyEnabled),dailyAmount,Number(referralEnabled),inviterAmount,inviteeAmount,referralTrigger);
    });
  }
  dailyBonus(id,now=this.clock(),settings=this.rewardConfig()){
    const day=Math.floor((now+LAGOS_OFFSET)/DAY);
    const claimId='daily:'+id+':'+day;
    return {claimId,enabled:!!settings.dailyEnabled,amount:settings.dailyAmount,
      claimed:!!this.get('SELECT 1 FROM ledger WHERE id=?',claimId),nextReset:(day+1)*DAY-LAGOS_OFFSET};
  }
  claimDaily(id){
    return this.tx(()=>{
      this.requireActive(id);
      const bonus=this.dailyBonus(id);
      if(!bonus.enabled)throw new PortalError(409,'Daily bonus is currently turned off.');
      if(bonus.claimed)throw new PortalError(409,'You already claimed today’s bonus.');
      this.credit(id,bonus.amount,'daily_bonus','Daily bonus',null,bonus.claimId);
      return bonus.amount;
    });
  }
  recordReferral(invitee){
    const settings=this.rewardConfig();
    if(!settings.referralEnabled)return;
    const inviter=this.get('SELECT referred_by FROM portal_profiles WHERE user_id=?',invitee)?.referred_by;
    if(!inviter||inviter===invitee||this.user(inviter)?.banned)return;
    this.run('INSERT INTO portal_referral_rewards VALUES (?,?,?,?,?,NULL)',
      invitee,inviter,settings.inviterAmount,settings.inviteeAmount,settings.referralTrigger);
    if(settings.referralTrigger==='signup')this.payReferral(invitee,'signup');
  }
  payReferral(invitee,trigger){
    const reward=this.get('SELECT * FROM portal_referral_rewards WHERE invitee=? AND trigger=? AND paid_at IS NULL',invitee,trigger);
    if(!reward||!this.rewardConfig().referralEnabled)return;
    const inviter=this.user(reward.inviter);
    if(!inviter||inviter.banned||inviter.closed_at)return;
    if(reward.inviter_amount)this.credit(reward.inviter,reward.inviter_amount,'referral_inviter','Referral reward',null,'referral-inviter:'+invitee);
    if(reward.invitee_amount)this.credit(invitee,reward.invitee_amount,'referral_invitee','Welcome referral bonus',null,'referral-invitee:'+invitee);
    this.run('UPDATE portal_referral_rewards SET paid_at=? WHERE invitee=?',this.clock(),invitee);
  }
  referralStats(inviter=null){
    const filter=inviter===null?'':' WHERE inviter=?';
    const amount=inviter===null?'inviter_amount+invitee_amount':'inviter_amount';
    return this.get(`SELECT count(*) FILTER (WHERE paid_at IS NULL) AS pending,
      count(paid_at) AS completed,coalesce(sum(${amount}) FILTER (WHERE paid_at IS NOT NULL),0) AS earned
      FROM portal_referral_rewards${filter}`,...(inviter===null?[]:[inviter]));
  }
  avatar(id){return this.get('SELECT version,jpeg FROM portal_avatars WHERE user_id=?',id);}
  setAvatar(id,jpeg){
    this.requireActive(id);
    if(!jpeg)this.run('DELETE FROM portal_avatars WHERE user_id=?',id);
    else this.run(`INSERT INTO portal_avatars VALUES (?,?,?) ON CONFLICT(user_id)
      DO UPDATE SET version=excluded.version,jpeg=excluded.jpeg`,id,randomUUID(),jpeg);
  }
  updateUsername(id,username){
    const other=this.get('SELECT user_id FROM portal_profiles WHERE username=?',username);
    if(other&&other.user_id!==id)throw new PortalError(409,'That username is already taken.');
    this.run('UPDATE portal_profiles SET username=? WHERE user_id=?',username,id);
  }
  loginEmail(username){
    return this.get(`SELECT p.email FROM portal_profiles f JOIN passwords p ON p.user_id=f.user_id
      WHERE f.username=? AND f.closed_at IS NULL`,username)?.email||null;
  }
  updateProfile(id,{name,username,theme}){
    return this.tx(()=>{
      this.requireActive(id);
      if(username!==undefined)this.updateUsername(id,username);
      if(name!==undefined)this.run('UPDATE users SET name=? WHERE id=?',name,id);
      if(theme!==undefined)this.run('UPDATE portal_profiles SET theme=? WHERE user_id=?',theme,id);
      return this.user(id);
    });
  }
  changePassword(id,email,oldDigest,newDigest){
    this.tx(()=>{
      this.requireActive(id);
      const updated=this.run('UPDATE passwords SET digest=? WHERE email=? AND user_id=? AND digest=?',newDigest,email,id,oldDigest);
      if(!updated.changes)throw new PortalError(409,'Your credentials changed. Try again.');
      this.run('DELETE FROM sessions WHERE user_id=?',id);
      this.run('DELETE FROM password_resets WHERE email=?',email);
    });
  }
  closeAccount(id,email,oldDigest){
    this.tx(()=>{
      const user=this.requireActive(id);
      if(user.is_owner)throw new PortalError(409,'The owner account is protected.');
      const saved=this.password(email);
      if(saved?.user_id!==id||saved.digest!==oldDigest)throw new PortalError(409,'Your credentials changed. Try again.');
      for(const bot of this.deployments(id))this.cancel(bot);
      this.run('UPDATE portal_profiles SET closed_at=? WHERE user_id=?',this.clock(),id);
      this.run('DELETE FROM portal_avatars WHERE user_id=?',id);
      this.run('UPDATE users SET banned=1 WHERE id=?',id);
      this.run('DELETE FROM sessions WHERE user_id=?',id);
      this.run('DELETE FROM password_resets WHERE email=?',email);
    });
  }
  event(userId,deploymentId,title,description){
    const id=randomUUID();
    this.run('INSERT INTO portal_events VALUES (?,?,?,?,?,?)',id,userId,deploymentId,title,description,this.clock());
    return id;
  }
  eventLogs(id,botId){
    this.requireActive(id);
    const bot=this.deployment(id,botId);
    if(!bot)throw new PortalError(404,'Bot not found.');
    return this.all(`SELECT title,description,created FROM portal_events
      WHERE user_id=? AND deployment_id=? ORDER BY created DESC,rowid DESC LIMIT 50`,id,bot.id);
  }
  announcements(){
    return this.all('SELECT id,title,description,created FROM portal_announcements ORDER BY created DESC,rowid DESC LIMIT 30');
  }
  publishAnnouncement(id,title,description){
    this.tx(()=>{
      this.v3.permit(id,'announcements.publish');
      const announcement=randomUUID();
      this.run('INSERT INTO portal_announcements VALUES (?,?,?,?)',announcement,title,description,this.clock());
      this.v3.audit(id,'announcement.publish',announcement,title);
    });
  }
  notices(user){
    const entries=this.all(`SELECT e.id,e.title,e.description,e.created,n.ticket_id AS ticketId,n.staff AS staffTicket
      FROM portal_events e LEFT JOIN v3_ticket_notices n ON n.event_id=e.id WHERE e.user_id=?
      UNION ALL SELECT 'billing:'||id,'Bot maintenance charge',reason||' ('||delta||' coins)',created,NULL,NULL
      FROM ledger WHERE user_id=? AND kind='uptime'
      UNION ALL SELECT 'announcement:'||id,title,description,created,NULL,NULL FROM portal_announcements
      WHERE created>=? ORDER BY created DESC LIMIT 80`,user.id,user.id,user.created);
    for(const bot of this.deployments(user.id)){
      if(this.lowBalance(bot,user))entries.unshift({id:'low:'+bot.id+':'+bot.paid_until,title:'Low coin balance',
        description:'Add coins before your next bot renewal.',created:bot.paid_until-LOW_BALANCE_WINDOW});
    }
    const states=new Map(this.all('SELECT notice_id,dismissed FROM portal_notice_state WHERE user_id=?',user.id)
      .map(row=>[row.notice_id,row.dismissed]));
    return entries.filter(row=>states.get(row.id)!==1).map(row=>({...row,read:states.has(row.id)}));
  }
  updateNotice(user,id,action){
    if(!['read','dismiss'].includes(action)||!this.notices(user).some(row=>row.id===id))
      throw new PortalError(404,'Notification not found.');
    this.run(`INSERT INTO portal_notice_state VALUES (?,?,?) ON CONFLICT(user_id,notice_id)
      DO UPDATE SET dismissed=MAX(dismissed,excluded.dismissed)`,user.id,id,Number(action==='dismiss'));
  }
  putSession(id,token){
    const now=this.clock();
    this.run('DELETE FROM sessions WHERE expires<=?',now);
    this.run('INSERT INTO sessions VALUES (?,?,?)',hash(token),id,now+7*DAY);
  }
  session(token){
    if(!token||token.length>100)return null;
    const row=this.get('SELECT user_id FROM sessions WHERE token=? AND expires>?',hash(token),this.clock());
    const user=row&&this.user(row.user_id);
    return user&&!user.banned&&!user.closed_at?user:null;
  }
  logout(token){if(token)this.run('DELETE FROM sessions WHERE token=?',hash(token));}
  deployments(userId){return this.all("SELECT * FROM deployments WHERE user_id=? AND state<>'cancelled' ORDER BY requested,id",userId);}
  deployment(userId,id){
    if(id===undefined)return this.deployments(userId)[0];
    return this.get("SELECT * FROM deployments WHERE id=? AND user_id=? AND state<>'cancelled'",id,userId);
  }
  requireActive(userId){
    const user=this.user(userId);
    if(!user||user.banned)throw new PortalError(403,BAN_MESSAGE);
    return user;
  }
  pair(userId,phone,{add=false,id,settings}={}){
    if(typeof phone!=='string'||!/^\+[1-9][0-9]{7,14}$/.test(phone))
      throw new PortalError(400,'Enter your WhatsApp number with its country code, such as +234…');
    return this.tx(()=>{
      const user=this.requireActive(userId), now=this.clock();
      const current=add?null:this.deployment(userId,id);
      if(id!==undefined&&!current)throw new PortalError(404,'Bot not found.');
      if(current?.linked)throw new PortalError(409,'Your WhatsApp is already linked. Use Resume bot.');
      if(current?.intent==='pair'&&current.pair_until>now&&current.phone===phone)return;
      if(current&&current.requested+45_000>now)throw new PortalError(429,'Wait 45 seconds between pairing attempts.');
      if(user.coins<PRICE&&!(current?.paid_until>now))throw new PortalError(409,'You need at least 10 coins to start.');
      if((phone!==current?.verified_phone&&this.get('SELECT 1 FROM verified_numbers WHERE phone=?',phone))||
        this.get("SELECT 1 FROM deployments WHERE phone=? AND id<>? AND intent='pair' AND pair_until>?",phone,current?.id||'',now))
        throw new PortalError(409,'This WhatsApp number is registered or already being paired.');
      this.checkCapacity(current?.id);
      const botId=current?.id||randomUUID(),generation=randomUUID();
      this.run(`INSERT INTO deployments (id,user_id,phone,generation,intent,state,pair_until,requested)
        VALUES (?,?,?,?,'pair','queued',?,?)
        ON CONFLICT(id) DO UPDATE SET phone=excluded.phone,generation=excluded.generation,intent='pair',state='queued',
        pair_until=excluded.pair_until,requested=excluded.requested,last_seen=0`,botId,userId,phone,generation,now+PAIR_WINDOW,now);
      if(settings!==undefined)this.queueSettings(botId,settings);
      this.codes.delete(botId);
      this.event(userId,botId,'Pairing requested','Waiting for a pairing code from WhatsApp.');
    });
  }
  queueSettings(id,input){
    let changes;
    try{changes=validate(input);}catch(error){throw new PortalError(400,error.message);}
    if(!Object.keys(changes).length)return;
    const prior=this.get('SELECT patch FROM bot_settings WHERE deployment_id=?',id);
    const patch={...JSON.parse(prior?.patch||'{}'),...changes};
    this.run(`INSERT INTO bot_settings (deployment_id,revision,patch) VALUES (?,?,?)
      ON CONFLICT(deployment_id) DO UPDATE SET revision=excluded.revision,patch=excluded.patch`,
      id,randomUUID(),JSON.stringify(patch));
  }
  saveSettings(userId,id,input){
    this.tx(()=>{
      this.requireActive(userId);
      const bot=typeof id==='string'&&this.deployment(userId,id);
      if(!bot)throw new PortalError(404,'Bot not found.');
      this.queueSettings(bot.id,input);
    });
  }
  settingsView(id){
    const row=this.get('SELECT * FROM bot_settings WHERE deployment_id=?',id);
    return {values:{...DEFAULTS,...JSON.parse(row?.applied||'{}'),...JSON.parse(row?.patch||'{}')},
      synced:!!row?.applied,pending:!!row?.revision};
  }
  reportSettings(id,report){
    if(!report?.values||typeof report.appliedRevision!=='string'&&report.appliedRevision!==null)return;
    const row=this.get('SELECT revision,applied FROM bot_settings WHERE deployment_id=?',id);
    if(row?.revision&&row.revision!==report.appliedRevision)return;
    let snapshot;
    try{snapshot=JSON.stringify(validate(report.values,{snapshot:true}));}catch{return;}
    if(row?.applied===snapshot&&!row.revision)return;
    this.run(`INSERT INTO bot_settings (deployment_id,applied) VALUES (?,?)
      ON CONFLICT(deployment_id) DO UPDATE SET applied=excluded.applied,revision=NULL,patch='{}'`,id,snapshot);
  }
  groupSettings(userId,id,request){
    this.requireActive(userId);
    const bot=typeof id==='string'&&this.deployment(userId,id);
    if(!bot||!bot.linked)throw new PortalError(404,'Linked bot not found.');
    if(bot.intent!=='run'||bot.last_seen+15_000<=this.clock())throw new PortalError(409,'Bring this bot online to manage groups.');
    const prior=this.groupRequests.get(id);
    if(prior?.expires>this.clock()&&!prior.result)throw new PortalError(409,'A group request is already in progress.');
    let task;
    if(request?.action==='list')task={action:'list'};
    else if(request?.action==='save'&&groupId(request.group)){
      try{task={action:'save',group:request.group,values:groupOptions(request.values)};}
      catch(error){throw new PortalError(400,error.message);}
    }else throw new PortalError(400,'Select a group settings action.');
    const token=randomUUID();
    this.groupRequests.set(id,{...task,token,expires:this.clock()+25_000,generation:bot.generation});
    return token;
  }
  groupResult(userId,id,token){
    this.requireActive(userId);
    const bot=typeof id==='string'&&this.deployment(userId,id);
    if(!bot||!bot.linked)throw new PortalError(404,'Linked bot not found.');
    const task=this.groupRequests.get(id);
    if(!task||task.token!==token||task.expires<=this.clock())throw new PortalError(409,'Group request expired. Try again.');
    return task.result||{pending:true};
  }
  checkCapacity(id){
    const now=this.clock();
    const {count}=this.get(`SELECT COUNT(*) AS count FROM deployments d JOIN users u ON u.id=d.user_id
      WHERE d.id<>? AND u.banned=0 AND ((d.intent='pair' AND d.pair_until>?) OR
      (d.intent='run' AND (d.paid_until>? OR u.coins>=?)))`,id||'',now,now,PRICE);
    if(count>=this.maxBots)throw new PortalError(503,'All bot slots are currently occupied. Try again later.');
  }
  cancel(d){
    if(d.verified_phone)this.run('DELETE FROM verified_numbers WHERE phone=? AND user_id=?',d.verified_phone,d.user_id);
    this.run("UPDATE deployments SET intent='pause',state='cancelled',linked=0,pair_until=0,verified_phone=NULL WHERE id=?",d.id);
    this.codes.delete(d.id);
    this.event(d.user_id,d.id,'Deployment cancelled','This deployment was removed from your active list.');
  }
  control(userId,action,id){
    return this.tx(()=>{
      const user=this.requireActive(userId), d=this.deployment(userId,id),now=this.clock();
      if(!d)throw new PortalError(404,'Bot not found.');
      if(action==='cancel'){
        this.cancel(d);
      }else if(action==='pause'){
        this.run("UPDATE deployments SET intent='pause',state='paused',pair_until=0 WHERE id=?",d.id);
        this.codes.delete(d.id);
        if(d.intent!=='pause')this.event(userId,d.id,'Bot paused','The deployment was paused from the portal.');
      }else if(action==='restart'){
        if(!d.linked||d.intent!=='run')throw new PortalError(409,'Start the linked bot before restarting it.');
        if(d.paid_until<=now&&user.coins<PRICE)throw new PortalError(409,'Your bot needs coins before it can restart.');
        const prior=this.get('SELECT requested FROM portal_restart WHERE deployment_id=?',d.id);
        if(prior&&prior.requested+15_000>now)throw new PortalError(429,'A restart was requested recently.');
        this.run(`INSERT INTO portal_restart VALUES (?,?,?) ON CONFLICT(deployment_id)
          DO UPDATE SET token=excluded.token,requested=excluded.requested`,d.id,randomUUID(),now);
        this.run("UPDATE deployments SET state='connecting',last_seen=0 WHERE id=?",d.id);
        this.event(userId,d.id,'Restart requested','The worker will reconnect this deployment with its saved session.');
      }else if(action==='resume'){
        if(!d.linked)throw new PortalError(409,'You need to pair your WhatsApp again.');
        if(d.paid_until<=now&&user.coins<PRICE)throw new PortalError(409,'You need at least 10 coins to resume.');
        this.checkCapacity(d.id);
        if(d.intent!=='run')this.run("UPDATE deployments SET intent='run',state='connecting',last_seen=0 WHERE id=?",d.id);
      }else throw new PortalError(400,'Unknown bot action.');
    });
  }
  admin(actorId,targetId,{action,amount,reason,deploymentId}){
    if(!['grant','remove','ban','unban','pause','cancel'].includes(action)||typeof reason!=='string'||!reason.trim()||reason.length>180)
      throw new PortalError(400,'Choose an action and enter a reason of up to 180 characters.');
    reason=reason.trim();
    return this.tx(()=>{
      const actor=this.v3.permit(actorId,ADMIN_ACTIONS[action]), target=this.user(targetId);
      if(!target||target.closed_at)throw new PortalError(404,'User not found.');
      if(!actor.is_owner&&(target.is_owner||this.get('SELECT 1 FROM v3_admins WHERE user_id=?',target.id)))
        throw new PortalError(403,'Only the Founder can manage staff accounts.');
      if(action==='cancel'){
        const d=typeof deploymentId==='string'&&this.deployment(targetId,deploymentId);
        if(!d)throw new PortalError(404,'Bot not found.');
        this.cancel(d);
      }else if(['grant','remove'].includes(action)){
        if(!Number.isSafeInteger(amount)||amount<1||amount>100_000)throw new PortalError(400,'Enter a whole amount between 1 and 100,000.');
        const delta=action==='grant'?amount:-amount;
        if(target.coins+delta<0||target.coins+delta>1_000_000)throw new PortalError(409,'This adjustment would put the balance outside its allowed range.');
        this.credit(targetId,delta,'owner_adjustment',reason,actorId);
      }else{
        if(target.is_owner&&action==='ban')throw new PortalError(409,'The owner account is protected.');
        if(action==='ban'||action==='unban'){
          this.run('UPDATE users SET banned=? WHERE id=?',Number(action==='ban'),targetId);
          if(action==='ban'||target.banned){
            this.run('DELETE FROM sessions WHERE user_id=?',targetId);
            this.run('DELETE FROM password_resets WHERE email=?',target.email);
          }
        }
        if(action!=='unban'){
          this.run("UPDATE deployments SET intent='pause',state='paused',pair_until=0 WHERE user_id=? AND state<>'cancelled'",targetId);
          for(const d of this.deployments(targetId))this.codes.delete(d.id);
        }
      }
      this.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),actorId,targetId,action,reason,this.clock());
      this.v3.audit(actorId,'account.'+action,targetId,reason);
    });
  }
  state(d,user,now=this.clock()){
    if(user.banned)return 'suspended';
    if(d.intent==='pair'&&d.pair_until<=now)return 'expired';
    if(d.intent==='run'&&d.paid_until<=now&&user.coins<PRICE)return 'low_balance';
    if(d.intent==='run'&&(d.state==='connecting'||(d.state==='online'&&d.last_seen+12_000<=now)))return 'reconnecting';
    return d.state;
  }
  lowBalance(d,user,now=this.clock()){
    if(user.banned||d.intent!=='run'||!d.linked||d.paid_until<=now||d.paid_until>now+LOW_BALANCE_WINDOW)return false;
    const {n}=this.get(`SELECT count(*) AS n FROM deployments WHERE user_id=? AND intent='run' AND linked=1
      AND (paid_until<? OR (paid_until=? AND id<=?))`,user.id,d.paid_until,d.paid_until,d.id);
    return user.coins<n*PRICE;
  }
  pendingRenewalNotices(){
    const now=this.clock();
    return this.all(`SELECT d.id,d.phone,d.paid_until,p.email,d.user_id FROM deployments d
      JOIN users u ON u.id=d.user_id JOIN passwords p ON p.user_id=u.id
      LEFT JOIN renewal_notices n ON n.deployment_id=d.id AND n.paid_until=d.paid_until
      WHERE d.intent='run' AND d.linked=1 AND u.banned=0 AND u.coins < ? * (
        SELECT count(*) FROM deployments r WHERE r.user_id=d.user_id AND r.intent='run' AND r.linked=1
        AND (r.paid_until<d.paid_until OR (r.paid_until=d.paid_until AND r.id<=d.id)))
      AND d.paid_until>? AND d.paid_until<=? AND n.deployment_id IS NULL
      ORDER BY d.paid_until,d.id`,PRICE,now,now+LOW_BALANCE_WINDOW);
  }
  markRenewalNotice(id,paidUntil){
    this.run(`INSERT INTO renewal_notices VALUES (?,?) ON CONFLICT(deployment_id)
      DO UPDATE SET paid_until=excluded.paid_until WHERE excluded.paid_until>renewal_notices.paid_until`,id,paidUntil);
  }
  dashboard(user){
    const now=this.clock();
    const rewards=this.rewardConfig();
    const {claimId,...dailyBonus}=this.dailyBonus(user.id,now,rewards);
    const ownReferral=this.get('SELECT invitee_amount AS amount,paid_at AS paidAt FROM portal_referral_rewards WHERE invitee=?',user.id);
    const deployments=this.deployments(user.id).map(d=>{
      const code=this.codes.get(d.id);
      return {id:d.id,phone:d.phone,requested:d.requested||null,state:this.state(d,user,now),linked:!!d.linked,settings:this.settingsView(d.id),paidUntil:d.paid_until||null,
        nextRenewal:d.intent==='run'&&d.linked&&d.paid_until>now&&!user.banned?d.paid_until:null,
        lowBalanceAlert:this.lowBalance(d,user,now),
        workerAvailable:this.workerSeen!==null&&this.workerSeen+15_000>now,
        lastSeen:d.last_seen||null,
        pairingExpires:d.intent==='pair'&&d.pair_until>now?d.pair_until:null,
        code:d.intent==='pair'&&code?.generation===d.generation&&code.expires>now&&!user.banned?code.value:null};
    });
    const {used,accountUsed}=this.get(`SELECT COUNT(*) AS used,
      COUNT(CASE WHEN d.user_id=? THEN 1 END) AS accountUsed
      FROM deployments d JOIN users u ON u.id=d.user_id
      WHERE u.banned=0 AND ((d.intent='pair' AND d.pair_until>?) OR
      (d.intent='run' AND (d.paid_until>? OR u.coins>=?)))`,user.id,now,now,PRICE);
    return {settingsDefaults:DEFAULTS,user:{name:user.name,email:user.email,coins:user.coins,isOwner:!!user.is_owner,
      username:user.username,theme:user.theme||'dark',created:user.created,referralCode:user.referral_code,
      avatarVersion:this.get('SELECT version FROM portal_avatars WHERE user_id=?',user.id)?.version||null,
      banned:!!user.banned,needsPassword:!this.hasPassword(user.id),staff:this.v3.role(user),
      onboarding:this.v3.onboarding(user.id)},capacity:{used,accountUsed,total:this.maxBots},
      unread:this.notices(user).filter(row=>!row.read).length,workerAvailable:this.workerSeen!==null&&this.workerSeen+15_000>now,
      dailyBonus,referralProgram:{enabled:!!rewards.referralEnabled,inviterAmount:rewards.inviterAmount,
        inviteeAmount:rewards.inviteeAmount,trigger:rewards.referralTrigger,
        ownBonus:ownReferral||null,...this.referralStats(user.id)},
      deployment:deployments[0]||null,deployments,history:this.history(user.id),price:PRICE};
  }
  history(id){return this.all('SELECT delta,kind,reason,created FROM ledger WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50',id);}
  ownerData(search='',id,{phoneSearch=true}={}){
    const q='%'+search.toLowerCase().slice(0,100)+'%';
    const users=this.all(`SELECT u.id,u.email,u.name,u.coins,u.banned,p.closed_at,
      EXISTS(SELECT 1 FROM owner WHERE user_id=u.id) AS founder,
      EXISTS(SELECT 1 FROM v3_admins WHERE user_id=u.id) AS staff FROM users u LEFT JOIN portal_profiles p ON p.user_id=u.id
      WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? OR EXISTS
      (SELECT 1 FROM deployments d WHERE d.user_id=u.id AND d.state<>'cancelled' AND d.phone LIKE ?)
      ORDER BY u.created DESC LIMIT 100`,q,q,phoneSearch?q:null);
    const bots=this.all("SELECT id,phone,intent,state,paid_until,pair_until,last_seen FROM deployments WHERE user_id=? AND state<>'cancelled' ORDER BY requested,id",id||'');
    const selected=id?this.user(id):null;
    const deployments=selected?bots.map(d=>({id:d.id,phone:d.phone,state:this.state(d,selected)})):[];
    const stats=this.get(`SELECT (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM deployments WHERE state<>'cancelled') AS deployments,
      (SELECT count(*) FROM deployments WHERE state='online' AND last_seen>?) AS online,
      (SELECT count(*) FROM ledger WHERE kind='uptime') AS charges`,this.clock()-12_000);
    const daily=this.get("SELECT count(*) AS claims,coalesce(sum(delta),0) AS paid FROM ledger WHERE kind='daily_bonus'");
    return {stats,users,deployments,rewards:{settings:this.rewardConfig(),daily,referrals:this.referralStats()},
      history:id?this.history(id):[],audit:id?this.all('SELECT action,reason,created FROM audit WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50',id):[]};
  }
  staffAccountData(actorId,search='',id){
    const actor=this.requireActive(actorId);
    if(actor.is_owner)return this.ownerData(search,id);
    const {permissions}=this.v3.role(actor);
    if(!permissions.some(key=>ACCOUNT_PERMISSIONS.includes(key)))throw new PortalError(403,'Account access required.');
    const showCoins=permissions.includes('coins.view');
    const showBots=permissions.includes('deployments.view');
    const data=this.ownerData(search,id,{phoneSearch:showBots});
    return {
      users:data.users.map(({coins,...user})=>showCoins?{...user,coins}:user),
      deployments:showBots?data.deployments:[],
      history:showCoins?data.history:[],audit:[]
    };
  }
  sync(reports){
    const now=this.clock();
    for(const [id,code] of this.codes)if(code.expires<=now)this.codes.delete(id);
    const deployments=this.tx(()=>{
      for(const d of this.all("SELECT id,user_id FROM deployments WHERE intent='pair' AND pair_until<=?",now)){
        this.event(d.user_id,d.id,'Pairing expired','Request a fresh code to continue.');
      }
      this.run("UPDATE deployments SET intent='pause',state='expired' WHERE intent='pair' AND pair_until<=?",now);
      for(const [id,task] of this.groupRequests)if(task.expires<=now)this.groupRequests.delete(id);
      for(const report of reports)this.report(report,now);
      const active=this.all(`SELECT d.*,u.coins FROM deployments d JOIN users u ON u.id=d.user_id
        WHERE u.banned=0 AND ((d.intent='pair' AND d.pair_until>? AND (u.coins>=? OR d.paid_until>?)) OR
        (d.intent='run' AND d.linked=1 AND (d.paid_until>? OR u.coins>=?)))
        ORDER BY (d.state='online') DESC,d.requested LIMIT ?`,now,PRICE,now,now,PRICE,this.maxBots);
      return active.map(d=>{
        const settings=this.get('SELECT revision,patch FROM bot_settings WHERE deployment_id=?',d.id);
        const groups=this.groupRequests.get(d.id);
        const restart=this.get('SELECT token FROM portal_restart WHERE deployment_id=?',d.id)?.token;
        return {id:d.id,phone:d.phone,generation:d.generation,intent:d.intent,
          ...(restart?{restart}:{}),
          community:community.task(this,d),
          pairUntil:d.pair_until,permitUntil:d.paid_until>now?Math.min(d.paid_until,now+12_000):0,
          ...(groups&&!groups.result&&groups.generation===d.generation?{groups}:{}),
          ...(settings?.revision?{settings:{revision:settings.revision,patch:JSON.parse(settings.patch)}}:{})};
      });
    });
    this.workerSeen=now;
    return deployments;
  }
  report(r,now){
    if(!r||typeof r.id!=='string'||typeof r.generation!=='string')return;
    const d=this.get('SELECT * FROM deployments WHERE id=? AND generation=?',r.id,r.generation);
    if(!d||d.intent==='pause')return;
    const restart=this.get('SELECT token FROM portal_restart WHERE deployment_id=?',d.id)?.token;
    if(restart&&r.restart!==restart)return;
    const user=this.user(d.user_id);
    if(!user||user.banned)return;
    community.report(this,d,r,now);
    this.reportSettings(d.id,r.settings);
    const groups=this.groupRequests.get(d.id);
    if(groups&&!groups.result&&groups.generation===d.generation&&r.groups?.token===groups.token){
      groups.result=r.groups.error?{error:'Group settings could not be loaded or changed. Check this bot’s group admin access.'}:
        groups.action==='save'?{saved:true}:{groups:r.groups.groups};
    }
    if(r.status==='code'&&d.intent==='pair'&&/^[A-Z0-9]{8}$/i.test(r.code||'')){
      this.codes.set(d.id,{generation:d.generation,value:r.code,expires:Math.min(d.pair_until,now+PAIRING_REPORT_TTL)});
      this.run("UPDATE deployments SET state='awaiting_code' WHERE id=?",d.id);
    }else if(['needs_pairing','pair_failed','pair_no_code'].includes(r.status)){
      this.codes.delete(d.id);
      const detail={
        pair_no_code:'WhatsApp did not issue a code in time. Request a fresh code.',
        pair_failed:'The worker could not finish pairing. Try a fresh code.',
        needs_pairing:'The saved WhatsApp session needs to be linked again.'
      };
      this.event(d.user_id,d.id,'WhatsApp connection failed',detail[r.status]);
      this.run("UPDATE deployments SET intent='pause',state=?,linked=0,pair_until=0 WHERE id=?",r.status,d.id);
    }else if(r.status==='connecting'&&d.intent==='pair'){
      this.codes.delete(d.id);
      if(d.state==='awaiting_code')this.run("UPDATE deployments SET state='queued' WHERE id=?",d.id);
    }else if(r.status==='connecting'&&d.intent==='run'){
      if(d.state==='online')this.event(d.user_id,d.id,'Connection interrupted','The worker is attempting to reconnect.');
      this.run("UPDATE deployments SET state='connecting' WHERE id=?",d.id);
    }else if(r.status==='online'){
      if(d.intent==='pair'){
        const existing=this.get('SELECT user_id FROM verified_numbers WHERE phone=?',d.phone);
        if(existing&&(existing.user_id!==d.user_id||d.verified_phone!==d.phone)){
          this.run("UPDATE deployments SET intent='pause',state='pair_failed',pair_until=0 WHERE id=?",d.id);
          this.codes.delete(d.id);
          return;
        }
        if(d.verified_phone&&d.verified_phone!==d.phone)this.run('DELETE FROM verified_numbers WHERE phone=? AND user_id=?',d.verified_phone,d.user_id);
        this.run('INSERT OR IGNORE INTO verified_numbers (phone,user_id) VALUES (?,?)',d.phone,d.user_id);
        this.run('UPDATE deployments SET verified_phone=? WHERE id=?',d.phone,d.id);
        this.v3.rememberPhone(d.user_id,d.phone);
      }
      this.codes.delete(d.id);
      if(d.state!=='online')this.event(d.user_id,d.id,'Bot connected','WhatsApp confirmed the deployment is connected.');
      let paidUntil=d.paid_until;
      if(paidUntil<=now&&user.coins>=PRICE){
        this.credit(user.id,-PRICE,'uptime','24 hours of bot access');
        paidUntil=now+DAY;
      }
      this.run("UPDATE deployments SET intent='run',state='online',linked=1,paid_until=?,pair_until=0,last_seen=? WHERE id=?",paidUntil,now,d.id);
      if(paidUntil>now){
        this.payReferral(d.user_id,'online');
        if(d.intent==='pair'||d.paid_until<=now&&d.verified_phone===d.phone)this.v3.qualify(d.user_id,d.phone,now);
      }
    }
  }
}
module.exports={Store,PortalError,DAY,PRICE,OWNER_EMAIL,BAN_MESSAGE};

