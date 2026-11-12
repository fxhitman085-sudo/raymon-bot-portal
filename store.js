const {DatabaseSync}=require('node:sqlite');
const {randomUUID,createHash}=require('node:crypto');

const DAY=86_400_000, PRICE=10, PAIR_WINDOW=180_000;
const LOW_BALANCE_WINDOW=6*60*60_000, RESET_WINDOW=30*60_000;
const OWNER_EMAIL='abdulganiy346@gmail.com';
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
      if(!this.password(email))return false;
      const now=this.clock();
      this.run('DELETE FROM password_resets WHERE expires<=?',now);
      this.run('INSERT INTO password_resets VALUES (?,?,?)',hash(token),email,now+RESET_WINDOW);
      return true;
    });
  }
  passwordReset(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    return this.get('SELECT email FROM password_resets WHERE token=? AND expires>?',hash(token),this.clock());
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
  register({email,name,digest,ownerAuthorized=false}){
    return this.tx(()=>{
      const isOwner=email===OWNER_EMAIL;
      if(isOwner&&!ownerAuthorized)throw new PortalError(403,'The owner account requires its setup token.');
      const pinned=isOwner&&this.get('SELECT user_id FROM owner WHERE singleton=1');
      const existing=this.get('SELECT id FROM users WHERE lower(email)=?',email);
      const priorOwner=pinned&&this.user(pinned.user_id);
      if(this.password(email)||(priorOwner&&this.hasPassword(priorOwner.id))||(existing&&!isOwner))
        throw new PortalError(409,'This account already exists. Sign in or use your existing session to set a password.');
      if(isOwner&&existing&&existing.id!==priorOwner?.id)
        throw new PortalError(409,'This email is tied to an existing account.');
      const id=priorOwner?.id||randomUUID();
      if(!priorOwner){
        this.run('INSERT INTO users(id,email,name,created) VALUES (?,?,?,?)',id,email,name,this.clock());
        this.credit(id,10,'starter','One-time starter coins',null,'starter:'+id);
        if(isOwner)this.run('INSERT INTO owner VALUES (1,?)',id);
      }
      this.run('INSERT INTO passwords VALUES (?,?,?)',email,id,digest);
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
  user(id){return this.get('SELECT u.*, EXISTS(SELECT 1 FROM owner WHERE user_id=u.id) AS is_owner FROM users u WHERE id=?',id);}
  putSession(id,token){
    const now=this.clock();
    this.run('DELETE FROM sessions WHERE expires<=?',now);
    this.run('INSERT INTO sessions VALUES (?,?,?)',hash(token),id,now+7*DAY);
  }
  session(token){
    if(!token||token.length>100)return null;
    const row=this.get('SELECT user_id FROM sessions WHERE token=? AND expires>?',hash(token),this.clock());
    return row?this.user(row.user_id):null;
  }
  logout(token){if(token)this.run('DELETE FROM sessions WHERE token=?',hash(token));}
  deployment(userId){return this.get('SELECT * FROM deployments WHERE user_id=?',userId);}
  requireActive(userId){
    const user=this.user(userId);
    if(!user||user.banned)throw new PortalError(403,'This account is suspended.');
    return user;
  }
  pair(userId,phone){
    if(typeof phone!=='string'||!/^\+[1-9][0-9]{7,14}$/.test(phone))
      throw new PortalError(400,'Enter your WhatsApp number with its country code, such as +234…');
    return this.tx(()=>{
      const user=this.requireActive(userId), now=this.clock();
      const current=this.deployment(userId);
      const verified=this.get('SELECT phone FROM verified_numbers WHERE user_id=?',userId);
      if(verified&&verified.phone!==phone)throw new PortalError(409,'This account already has a verified WhatsApp number.');
      if(current?.linked)throw new PortalError(409,'Your WhatsApp is already linked. Use Resume bot.');
      if(current?.intent==='pair'&&current.pair_until>now)return;
      if(current&&current.requested+45_000>now)throw new PortalError(429,'Wait 45 seconds between pairing attempts.');
      if(user.coins<PRICE&&!(current?.paid_until>now))throw new PortalError(409,'You need at least 10 coins to start.');
      if(this.get('SELECT 1 FROM verified_numbers WHERE phone=? AND user_id<>?',phone,userId)||
        this.get("SELECT 1 FROM deployments WHERE phone=? AND user_id<>? AND intent='pair' AND pair_until>?",phone,userId,now))
        throw new PortalError(409,'This WhatsApp number is registered or already being paired.');
      this.checkCapacity(userId);
      const id=current?.id||randomUUID(),generation=randomUUID();
      this.run(`INSERT INTO deployments (id,user_id,phone,generation,intent,state,pair_until,requested)
        VALUES (?,?,?,?,'pair','queued',?,?)
        ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,generation=excluded.generation,intent='pair',state='queued',
        pair_until=excluded.pair_until,requested=excluded.requested,last_seen=0`,id,userId,phone,generation,now+PAIR_WINDOW,now);
      this.codes.delete(id);
    });
  }
  checkCapacity(userId){
    const {count}=this.get(`SELECT COUNT(*) AS count FROM deployments d JOIN users u ON u.id=d.user_id
      WHERE d.user_id<>? AND u.banned=0 AND ((d.intent='pair' AND d.pair_until>?) OR
      (d.intent='run' AND (d.paid_until>? OR u.coins>=?)))`,userId,this.clock(),this.clock(),PRICE);
    if(count>=this.maxBots)throw new PortalError(503,'All bot slots are currently occupied. Try again later.');
  }
  control(userId,action){
    return this.tx(()=>{
      const user=this.requireActive(userId), d=this.deployment(userId),now=this.clock();
      if(!d)throw new PortalError(404,'Pair your WhatsApp first.');
      if(action==='pause'){
        this.run("UPDATE deployments SET intent='pause',state='paused',pair_until=0 WHERE id=?",d.id);
        this.codes.delete(d.id);
      }else if(action==='resume'){
        if(!d.linked)throw new PortalError(409,'You need to pair your WhatsApp again.');
        if(d.paid_until<=now&&user.coins<PRICE)throw new PortalError(409,'You need at least 10 coins to resume.');
        this.checkCapacity(userId);
        if(d.intent!=='run')this.run("UPDATE deployments SET intent='run',state='connecting',last_seen=0 WHERE id=?",d.id);
      }else throw new PortalError(400,'Unknown bot action.');
    });
  }
  admin(actorId,targetId,{action,amount,reason}){
    if(!['grant','remove','ban','unban','pause'].includes(action)||typeof reason!=='string'||!reason.trim()||reason.length>180)
      throw new PortalError(400,'Choose an action and enter a reason of up to 180 characters.');
    reason=reason.trim();
    return this.tx(()=>{
      const actor=this.requireActive(actorId), target=this.user(targetId);
      if(!actor.is_owner)throw new PortalError(403,'Owner access required.');
      if(!target)throw new PortalError(404,'User not found.');
      if(['grant','remove'].includes(action)){
        if(!Number.isSafeInteger(amount)||amount<1||amount>100_000)throw new PortalError(400,'Enter a whole amount between 1 and 100,000.');
        const delta=action==='grant'?amount:-amount;
        if(target.coins+delta<0||target.coins+delta>1_000_000)throw new PortalError(409,'This adjustment would put the balance outside its allowed range.');
        this.credit(targetId,delta,'owner_adjustment',reason,actorId);
      }else{
        if(target.is_owner&&action==='ban')throw new PortalError(409,'The owner account is protected.');
        if(action==='ban'||action==='unban')this.run('UPDATE users SET banned=? WHERE id=?',Number(action==='ban'),targetId);
        if(action!=='unban'){
          this.run("UPDATE deployments SET intent='pause',state='paused',pair_until=0 WHERE user_id=?",targetId);
          const d=this.deployment(targetId);if(d)this.codes.delete(d.id);
        }
      }
      this.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),actorId,targetId,action,reason,this.clock());
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
    return !user.banned&&d.intent==='run'&&d.linked&&user.coins<PRICE&&
      d.paid_until>now&&d.paid_until<=now+LOW_BALANCE_WINDOW;
  }
  pendingRenewalNotices(){
    const now=this.clock();
    return this.all(`SELECT d.id,d.paid_until,p.email FROM deployments d
      JOIN users u ON u.id=d.user_id JOIN passwords p ON p.user_id=u.id
      LEFT JOIN renewal_notices n ON n.deployment_id=d.id AND n.paid_until=d.paid_until
      WHERE d.intent='run' AND d.linked=1 AND u.banned=0 AND u.coins<?
      AND d.paid_until>? AND d.paid_until<=? AND n.deployment_id IS NULL
      ORDER BY d.paid_until`,PRICE,now,now+LOW_BALANCE_WINDOW);
  }
  markRenewalNotice(id,paidUntil){
    this.run(`INSERT INTO renewal_notices VALUES (?,?) ON CONFLICT(deployment_id)
      DO UPDATE SET paid_until=excluded.paid_until WHERE excluded.paid_until>renewal_notices.paid_until`,id,paidUntil);
  }
  dashboard(user){
    const d=this.deployment(user.id),now=this.clock();
    let deployment=null;
    if(d){
      const code=this.codes.get(d.id);
      deployment={phone:d.phone,state:this.state(d,user,now),linked:!!d.linked,paidUntil:d.paid_until||null,
        nextRenewal:d.intent==='run'&&d.linked&&d.paid_until>now&&!user.banned?d.paid_until:null,
        lowBalanceAlert:this.lowBalance(d,user,now),
        workerAvailable:this.workerSeen!==null&&this.workerSeen+15_000>now,
        lastSeen:d.last_seen||null,
        pairingExpires:d.intent==='pair'&&d.pair_until>now?d.pair_until:null,
        code:d.intent==='pair'&&code?.generation===d.generation&&d.pair_until>now&&!user.banned?code.value:null};
    }
    return {user:{name:user.name,email:user.email,coins:user.coins,isOwner:!!user.is_owner,banned:!!user.banned,needsPassword:!this.hasPassword(user.id)},deployment,history:this.history(user.id),price:PRICE};
  }
  history(id){return this.all('SELECT delta,kind,reason,created FROM ledger WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50',id);}
  ownerData(search='',id){
    const q='%'+search.toLowerCase().slice(0,100)+'%';
    const users=this.all(`SELECT u.id,u.email,u.name,u.coins,u.banned,d.phone,d.intent,d.state,d.paid_until,d.pair_until,d.last_seen
      FROM users u LEFT JOIN deployments d ON d.user_id=u.id WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? OR d.phone LIKE ?
      ORDER BY u.created DESC LIMIT 100`,q,q,q);
    for(const user of users)if(user.phone)user.state=this.state(user,user);
    return {users,history:id?this.history(id):[],audit:id?this.all('SELECT action,reason,created FROM audit WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50',id):[]};
  }
  sync(reports){
    const now=this.clock();
    for(const [id,code] of this.codes)if(code.expires<=now)this.codes.delete(id);
    const deployments=this.tx(()=>{
      this.run("UPDATE deployments SET intent='pause',state='expired' WHERE intent='pair' AND pair_until<=?",now);
      for(const report of reports)this.report(report,now);
      const active=this.all(`SELECT d.*,u.coins FROM deployments d JOIN users u ON u.id=d.user_id
        WHERE u.banned=0 AND ((d.intent='pair' AND d.pair_until>? AND (u.coins>=? OR d.paid_until>?)) OR
        (d.intent='run' AND d.linked=1 AND (d.paid_until>? OR u.coins>=?)))
        ORDER BY (d.state='online') DESC,d.requested LIMIT ?`,now,PRICE,now,now,PRICE,this.maxBots);
      return active.map(d=>({id:d.id,phone:d.phone,generation:d.generation,intent:d.intent,
        pairUntil:d.pair_until,permitUntil:d.paid_until>now?Math.min(d.paid_until,now+12_000):0}));
    });
    this.workerSeen=now;
    return deployments;
  }
  report(r,now){
    if(!r||typeof r.id!=='string'||typeof r.generation!=='string')return;
    const d=this.get('SELECT * FROM deployments WHERE id=? AND generation=?',r.id,r.generation);
    if(!d||d.intent==='pause')return;
    const user=this.user(d.user_id);
    if(!user||user.banned)return;
    if(r.status==='code'&&d.intent==='pair'&&/^[A-Z0-9]{8}$/i.test(r.code||'')){
      this.codes.set(d.id,{generation:d.generation,value:r.code,expires:d.pair_until});
      this.run("UPDATE deployments SET state='awaiting_code' WHERE id=?",d.id);
    }else if(['needs_pairing','pair_failed'].includes(r.status)){
      this.codes.delete(d.id);
      this.run("UPDATE deployments SET intent='pause',state=?,linked=0,pair_until=0 WHERE id=?",r.status,d.id);
    }else if(r.status==='connecting'&&d.intent==='run'){
      this.run("UPDATE deployments SET state='connecting' WHERE id=?",d.id);
    }else if(r.status==='online'){
      if(d.intent==='pair'){
        this.run('INSERT OR IGNORE INTO verified_numbers VALUES (?,?)',d.phone,d.user_id);
        if(!this.get('SELECT 1 FROM verified_numbers WHERE phone=? AND user_id=?',d.phone,d.user_id)){
          this.run("UPDATE deployments SET intent='pause',state='pair_failed',pair_until=0 WHERE id=?",d.id);
          return;
        }
      }
      this.codes.delete(d.id);
      let paidUntil=d.paid_until;
      if(paidUntil<=now&&user.coins>=PRICE){
        this.credit(user.id,-PRICE,'uptime','24 hours of bot access');
        paidUntil=now+DAY;
      }
      this.run("UPDATE deployments SET intent='run',state='online',linked=1,paid_until=?,pair_until=0,last_seen=? WHERE id=?",paidUntil,now,d.id);
    }
  }
}
module.exports={Store,PortalError,DAY,PRICE,OWNER_EMAIL};
