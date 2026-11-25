'use strict';
const {randomBytes}=require('node:crypto');
const {ADMIN}=require('./community');

class Summons {
  constructor(store){
    this.s=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS summons (
      num INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT UNIQUE NOT NULL, deployment TEXT NOT NULL,
      phone TEXT NOT NULL, support INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS summons_mail (
      id TEXT PRIMARY KEY,ticket TEXT NOT NULL,via TEXT NOT NULL,recipient TEXT NOT NULL,
      kind TEXT NOT NULL,body TEXT NOT NULL,sent INTEGER DEFAULT 0,staff TEXT);
      CREATE INDEX IF NOT EXISTS summons_pending ON summons_mail(via,sent);
      CREATE TABLE IF NOT EXISTS summons_received (deployment TEXT,mid TEXT,PRIMARY KEY(deployment,mid));`);
  }
  verified(id){
    return this.s.get(`SELECT d.* FROM deployments d JOIN verified_numbers v ON v.user_id=d.user_id
      AND v.phone=d.phone WHERE d.id=? AND d.verified_phone=d.phone`,id);
  }
  online(d){return d?.intent==='run'&&d.state==='online'&&d.last_seen>this.s.clock()-12000;}
  queue(c,via,recipient,kind,body,staff=null){
    const mid='52A1'+randomBytes(12).toString('hex').toUpperCase();
    this.s.run('INSERT INTO summons_mail VALUES (?,?,?,?,?,?,0,?)',mid,c.ticket,via,recipient,kind,body,staff);
  }
  contact(c,message){
    this.queue(c,c.support?ADMIN:c.phone,c.phone,'chat',message);
  }
  create(id,deployment,reason){
    return this.s.v3.ticketAction(id,false,{action:'create',subject:'Summon Admin',message:reason,deployment},null);
  }
  opened(ticket,user,botId,reason){
    const d=this.verified(botId);
    if(!d||d.user_id!==user)this.s.v3.fail(400,'Choose a bot with a verified WhatsApp number.');
    const support=Number(!this.online(d));
    this.s.run('INSERT INTO summons(ticket,deployment,phone,support) VALUES (?,?,?,?)',ticket,d.id,d.phone,support);
    const c=this.get(ticket);
    this.s.run('UPDATE v3_tickets SET subject=? WHERE id=?','Case #'+c.num+' · '+reason.slice(0,80),ticket);
    for(const admin of this.s.v3.assignees()){
      if(!this.s.v3.role(this.s.user(admin.id)).permissions.includes('tickets.reply'))continue;
      this.s.v3.ticketNotice(admin.id,ticket,true,'Admin summoned','Case #'+c.num+' · '+reason.slice(0,100));
      const dest=this.s.get(`SELECT d.phone FROM deployments d JOIN verified_numbers v ON v.phone=d.phone AND v.user_id=d.user_id
        WHERE d.user_id=? AND d.phone=d.verified_phone ORDER BY d.last_seen DESC LIMIT 1`,admin.id);
      if(dest)this.queue(c,dest.phone,dest.phone,'summon','New support case #'+c.num+' · '+reason+'\nReply to this message with .accept to take the case.',admin.id);
    }
  }
  get(ticket){return this.s.get('SELECT * FROM summons WHERE ticket=?',ticket);}
  pending(d){
    return this.s.all(`SELECT m.id,m.recipient,m.body FROM summons_mail m JOIN summons c ON c.ticket=m.ticket
      JOIN v3_tickets t ON t.id=c.ticket JOIN verified_numbers v ON v.phone=c.phone AND v.user_id=t.user_id
      WHERE m.via=? AND m.sent=0 AND (m.staff IS NULL OR EXISTS (SELECT 1 FROM verified_numbers a WHERE a.user_id=m.staff AND a.phone=m.via AND (EXISTS (SELECT 1 FROM owner o WHERE o.user_id=a.user_id) OR EXISTS (SELECT 1 FROM v3_admins b JOIN v3_permissions p ON p.level=b.level AND p.permission='tickets.reply' WHERE b.user_id=a.user_id AND b.suspended=0)))) AND (m.kind!='summon' OR (t.assignee IS NULL AND t.closed=0))
      ORDER BY m.rowid LIMIT 6`,d.phone);
  }
  input(d,event){
    const {mid,quote,text,peer}=event;
    if(typeof mid!=='string'||mid.length>150||typeof text!=='string'||!text.trim()||text.length>4000)return;
    if(this.s.get('SELECT 1 FROM summons_received WHERE deployment=? AND mid=?',d.id,mid))return;
    const self=peer===d.phone;
    const mail=typeof quote==='string'&&this.s.get('SELECT * FROM summons_mail WHERE id=? AND via=? AND recipient=?',quote,d.phone,peer);
    if(self&&/^\.admin\s+help(?:\s|$)/i.test(text)){
      this.create(d.user_id,d.id,text.replace(/^\.admin\s+help\s*/i,'')||'Help requested');
    }else if(mail?.kind==='summon'&&mail.staff===d.user_id&&self&&/^\.accept$/i.test(text.trim())){
      this.s.v3.permit(d.user_id,'tickets.view');
      this.s.v3.permit(d.user_id,'tickets.reply');
      const t=this.s.v3.ticket(d.user_id,mail.ticket,true),c=this.get(t.id);
      if(t.closed)return;
      if(!t.assignee){
        this.s.run('UPDATE v3_tickets SET assignee=?,updated=? WHERE id=? AND assignee IS NULL',d.user_id,this.s.clock(),t.id);
        const name=this.s.user(d.user_id).name;
        const requester=this.verified(c.deployment);
        if(!this.online(requester)){c.support=1;this.s.run('UPDATE summons SET support=1 WHERE ticket=?',t.id);}
        this.contact(c,name+' has taken your case #'+c.num+'. Reply to this message to continue.');
      }
      this.queue(c,d.phone,d.phone,'receipt',t.assignee&&t.assignee!==d.user_id?'Case #'+c.num+' was taken by '+t.assigneeName+'.':'You have case #'+c.num+'. Open Support Dashboard → My Cases.',d.user_id);
    }else if(mail?.kind==='chat'){
      const c=this.get(mail.ticket),t=this.s.get('SELECT * FROM v3_tickets WHERE id=?',mail.ticket);
      if(!t||t.closed||!t.assignee||c.phone!==peer||(c.support?ADMIN:c.phone)!==d.phone||this.verified(c.deployment)?.user_id!==t.user_id)return;
      this.s.v3.ticketAction(t.user_id,false,{action:'reply',ticketId:t.id,message:text},event.image||null);
    }else return;
    this.s.run('INSERT INTO summons_received VALUES (?,?)',d.id,mid);
  }
}
module.exports={Summons};
