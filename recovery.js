'use strict';
const {randomBytes,createHash,createCipheriv,createDecipheriv}=require('node:crypto');
const DAY=86400000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
const validId=id=>typeof id==='string'&&/^[A-F0-9]{16}$/.test(id);
const validBrowser=token=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token);
const codeValid=code=>typeof code==='string'&&/^[A-Z2-9]{10}$/.test(code);
function encrypt(secret,message){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),iv);
  const ciphertext=Buffer.concat([cipher.update(message,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
}
function decrypt(secret,stored){
  const b=Buffer.from(stored,'base64url');
  const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),b.subarray(0,12));
  decipher.setAuthTag(b.subarray(12,28));
  return Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8');
}
function fail(status,message){const error=new Error(message);error.status=status;throw error;}
class Recovery {
  constructor(store){
    this.s=store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        browser_hash TEXT NOT NULL, code_hash TEXT NOT NULL, code_encrypted TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','used')),
        created INTEGER NOT NULL, expires INTEGER NOT NULL, reviewed INTEGER,
        actor TEXT REFERENCES users(id), attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS recovery_requests_user ON recovery_requests(user_id,created);
      CREATE INDEX IF NOT EXISTS recovery_requests_state ON recovery_requests(state,created);
    `);
  }
  request(email,secret){
    const id=randomBytes(8).toString('hex').toUpperCase();
    const code=Array.from(randomBytes(10),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
    const now=this.s.clock(), account=this.s.password(email);
    const user=account&&this.s.user(account.user_id);
    if(user&&!user.banned&&!user.closed_at){
      this.s.tx(()=>{
        this.s.run("UPDATE recovery_requests SET state='rejected' WHERE user_id=? AND state IN ('pending','approved')",user.id);
        this.s.run('INSERT INTO recovery_requests(id,user_id,browser_hash,code_hash,code_encrypted,state,created,expires) VALUES (?,?,?,?,?,?,?,?)',
          id,user.id,hash(secret),hash(id+':'+code),'', 'pending',now,now+DAY);
        this.s.run('UPDATE recovery_requests SET code_encrypted=? WHERE id=?',encrypt(secret,code),id);
      });
    }
    return {id,expires:now+DAY};
  }
  own(id,secret){
    if(!validId(id)||!validBrowser(secret))return null;
    const row=this.s.get('SELECT * FROM recovery_requests WHERE id=? AND browser_hash=?',id,hash(secret));
    if(!row||row.expires<=this.s.clock())return null;
    return row;
  }
  status(id,secret){
    const row=this.own(id,secret);
    if(!row)return {state:validId(id)&&validBrowser(secret)?'pending':'expired'};
    if(row.state!=='approved')return {state:row.state,expires:row.expires};
    try{return {state:'approved',code:decrypt(secret,row.code_encrypted),expires:row.expires};}
    catch{return {state:'expired'};}
  }
  inbox(actor){
    this.s.v3.permit(actor,'passwords.review');
    const now=this.s.clock();
    return this.s.all(`SELECT r.id,r.created,r.expires,r.state,u.email,u.name,
      CASE WHEN v.phone IS NULL THEN 0 ELSE 1 END AS phoneLinked
      FROM recovery_requests r JOIN users u ON u.id=r.user_id
      LEFT JOIN verified_numbers v ON v.user_id=u.id
      WHERE r.state='pending' AND r.expires>? ORDER BY r.created DESC LIMIT 100`,now);
  }
  review(actor,id,action,phone){
    this.s.v3.permit(actor,'passwords.review');
    if(!validId(id)||!['approve','reject'].includes(action))fail(400,'Choose a valid recovery request and action.');
    return this.s.tx(()=>{
      const row=this.s.get(`SELECT r.*,u.banned,p.closed_at FROM recovery_requests r JOIN users u ON u.id=r.user_id
        LEFT JOIN portal_profiles p ON p.user_id=u.id WHERE r.id=?`,id);
      if(!row||row.state!=='pending'||row.expires<=this.s.clock())fail(409,'This request is no longer pending.');
      const target=this.s.user(row.user_id);
      if(target.banned||target.closed_at)fail(409,'This account is inactive.');
      if(!target.is_owner&&this.s.get('SELECT 1 FROM v3_admins WHERE user_id=?',target.id)&&!this.s.user(actor).is_owner)
        fail(403,'Only the Founder may review administrator recovery requests.');
      if(target.is_owner&&!this.s.user(actor).is_owner)fail(403,'Only the Founder may review Founder requests.');
      if(action==='approve'){
        if(typeof phone!=='string'||!/^[0-9]{8,16}$/.test(phone.replace(/^\+/,'')))
          fail(400,'Enter the full linked WhatsApp number, including country code.');
        const normalized='+'+phone.replace(/^\+/,'');
        const verified=this.s.get('SELECT 1 FROM verified_numbers WHERE user_id=? AND phone=?',row.user_id,normalized);
        if(!verified)fail(403,'Linked WhatsApp number does not match. Do not approve this request.');
      }
      const now=this.s.clock();
      this.s.run('UPDATE recovery_requests SET state=?,reviewed=?,actor=?,expires=? WHERE id=?',
        action==='approve'?'approved':'rejected',now,actor,
        action==='approve'?Math.min(row.expires,now+15*60000):now+DAY,id);
      this.s.v3.audit(actor,'password.'+action,row.user_id,'Recovery request '+id);
      return {ok:true};
    });
  }
  consume(id,secret,code,passwordDigest){
    const initial=this.own(id,secret);
    if(!initial||initial.state!=='approved')fail(400,'This recovery request is invalid or expired.');
    if(initial.attempts>=5)fail(429,'Too many code attempts. Start a new request.');
    this.s.run('UPDATE recovery_requests SET attempts=attempts+1 WHERE id=?',id);
    if(!codeValid(code)||hash(id+':'+code)!==initial.code_hash)fail(400,'Invalid recovery code.');
    return this.s.tx(()=>{
      const row=this.own(id,secret);
      if(!row||row.state!=='approved')fail(400,'This recovery request is invalid or expired.');
      if(row.attempts>=5)fail(429,'Too many code attempts. Start a new request.');
      const target=this.s.user(row.user_id);
      if(!target||target.banned||target.closed_at)fail(403,'Account unavailable.');
      this.s.run('UPDATE passwords SET digest=? WHERE user_id=?',passwordDigest,row.user_id);
      this.s.run('DELETE FROM sessions WHERE user_id=?',row.user_id);
      this.s.run('DELETE FROM password_resets WHERE email=?',target.email);
      this.s.run("UPDATE recovery_requests SET state='used',code_encrypted='' WHERE user_id=? AND state IN ('pending','approved')",row.user_id);
      return {ok:true};
    });
  }
}
module.exports={Recovery};
