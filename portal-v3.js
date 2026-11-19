'use strict';
const {createHash,randomUUID}=require('node:crypto');

const PERMISSIONS={
  'tickets.view':'View the support inbox',
  'tickets.reply':'Reply to tickets',
  'tickets.assign':'Assign tickets',
  'tickets.close':'Close tickets',
  'users.view':'Search user accounts',
  'users.moderate':'Ban or unban regular users',
  'coins.view':'View user balances and coin history',
  'coins.adjust':'Adjust regular user balances',
  'deployments.view':'View deployments',
  'deployments.manage':'Pause or cancel regular user bots',
  'promos.view':'View promo codes and redemption history',
  'referrals.view':'View leaderboard prize and review history',
  'referrals.review':'Exclude or restore referral entries',
  'announcements.publish':'Publish website announcements',
  'passwords.review':'Review verified account recovery requests',
  'vip.view':'View VIP members and subscriptions',
  'vip.plans':'Configure VIP prices and benefits',
  'vip.grant':'Grant or revoke VIP memberships',
  'diagnostics.view':'View pairing diagnostics and worker health',
  'staff.manage.lower':'Appoint, promote and remove administrators below Level 7'
};
const ACCOUNT_PERMISSIONS=Object.keys(PERMISSIONS).filter(key=>/^(users|coins|deployments)\./.test(key));
const ADMIN_ACTIONS={grant:'coins.adjust',remove:'coins.adjust',ban:'users.moderate',unban:'users.moderate',
  pause:'deployments.manage',cancel:'deployments.manage'};
const PERIODS=['daily','weekly','monthly','all'];
const DAY=86_400_000, OFFSET=3_600_000;
const DEFAULT_COIN_PACKAGES=[
  {id:'50',naira:500,coins:50},
  {id:'100',naira:1000,coins:100},
  {id:'200',naira:2000,coins:200}
];
const digest=value=>createHash('sha256').update(value).digest('hex');
function periodWindow(period,now,previous=0){
  if(period==='all')return [0,0];
  const date=new Date(now+OFFSET);
  date.setUTCHours(0,0,0,0);
  if(period==='monthly'){
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth()-previous);
    const start=+date-OFFSET;
    date.setUTCMonth(date.getUTCMonth()+1);
    return [start,+date-OFFSET];
  }
  const days=period==='weekly'?7:1;
  if(days===7)date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  const start=+date-OFFSET-previous*days*DAY;
  return [start,start+days*DAY];
}

class PortalV3 {
  constructor(store,ErrorType){
    this.s=store;
    this.Error=ErrorType;
    store.tx(()=>store.db.exec(`
      CREATE TABLE IF NOT EXISTS v3_coin_packages (
        id TEXT PRIMARY KEY, naira INTEGER NOT NULL CHECK(naira>0 AND naira<=100000000),
        coins INTEGER NOT NULL CHECK(coins>0 AND coins<=1000000),
        active INTEGER NOT NULL CHECK(active IN (0,1)), revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_payments (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        package_id TEXT NOT NULL, naira INTEGER NOT NULL, coins INTEGER NOT NULL,
        reference TEXT NOT NULL, reference_key TEXT UNIQUE NOT NULL,
        screenshot BLOB NOT NULL, screenshot_hash TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        reason TEXT NOT NULL DEFAULT '', reviewer TEXT REFERENCES users(id),
        created INTEGER NOT NULL, reviewed INTEGER
      );
      CREATE INDEX IF NOT EXISTS v3_payments_user ON v3_payments(user_id,created DESC);
      CREATE INDEX IF NOT EXISTS v3_payments_status ON v3_payments(status,created);
      CREATE TABLE IF NOT EXISTS v3_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS v3_admins (
        user_id TEXT PRIMARY KEY REFERENCES users(id), level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 7),
        suspended INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS v3_permissions (
        level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 7), permission TEXT NOT NULL, PRIMARY KEY(level,permission)
      );
      CREATE TABLE IF NOT EXISTS v3_audit (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
        target TEXT NOT NULL, summary TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_tickets (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), subject TEXT NOT NULL,
        assignee TEXT REFERENCES users(id), closed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS v3_tickets_user ON v3_tickets(user_id,updated DESC);
      CREATE TABLE IF NOT EXISTS v3_ticket_messages (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES v3_tickets(id),
        author TEXT NOT NULL REFERENCES users(id), staff INTEGER NOT NULL, message TEXT NOT NULL,
        screenshot BLOB, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS v3_ticket_messages_ticket ON v3_ticket_messages(ticket_id);
      CREATE TABLE IF NOT EXISTS v3_ticket_notices (
        event_id TEXT PRIMARY KEY REFERENCES portal_events(id), ticket_id TEXT NOT NULL REFERENCES v3_tickets(id),
        staff INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_promos (
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, amount INTEGER NOT NULL, expires INTEGER NOT NULL,
        max_claims INTEGER NOT NULL, active INTEGER NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_claims (
        promo_id TEXT NOT NULL REFERENCES v3_promos(id), user_id TEXT NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(promo_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS v3_onboarding (
        user_id TEXT PRIMARY KEY REFERENCES users(id), step INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_referral_phones (
        fingerprint TEXT PRIMARY KEY, first_user TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS v3_referrals (
        invitee TEXT PRIMARY KEY REFERENCES users(id), inviter TEXT NOT NULL REFERENCES users(id),
        phone_hash TEXT NOT NULL UNIQUE, qualified INTEGER NOT NULL, excluded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS v3_referrals_period ON v3_referrals(qualified,inviter);
      CREATE TABLE IF NOT EXISTS v3_prizes (
        period TEXT PRIMARY KEY, mode TEXT NOT NULL, prizes TEXT NOT NULL, next_start INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v3_awards (
        period TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL, mode TEXT NOT NULL,
        awarded INTEGER NOT NULL, winners TEXT NOT NULL, PRIMARY KEY(period,starts)
      );
    `));
    store.tx(()=>{
      if(store.get("SELECT 1 FROM v3_migrations WHERE name='coin-packages'"))return;
      for(const item of DEFAULT_COIN_PACKAGES){
        store.run('INSERT OR IGNORE INTO v3_coin_packages VALUES (?,?,?,?,?)',item.id,item.naira,item.coins,1,randomUUID());
      }
      store.run("INSERT INTO v3_migrations VALUES ('coin-packages')");
    });
    store.tx(()=>{
      if(!store.get("SELECT 1 FROM v3_migrations WHERE name='chief-staff-delegation-v4'")){
        store.run("INSERT OR IGNORE INTO v3_permissions(level,permission) VALUES (7,'staff.manage.lower')");
        store.run("INSERT INTO v3_migrations VALUES ('chief-staff-delegation-v4')");
      }
    });
    // Backfill only from existing paid, verified deployments. Keep a permanent fingerprint so a
    // recycled or released number cannot qualify a second referral.
    store.tx(()=>{
      if(store.get("SELECT 1 FROM v3_migrations WHERE name='verified-referrals'"))return;
      const rows=store.all(`SELECT r.invitee,r.inviter,d.verified_phone,d.requested,d.last_seen,d.paid_until,
        CASE WHEN r.trigger='online' THEN r.paid_at END AS online_paid
        FROM portal_referral_rewards r JOIN deployments d ON d.user_id=r.invitee
        WHERE d.verified_phone IS NOT NULL AND d.paid_until>0 AND r.invitee<>r.inviter
          AND NOT EXISTS (SELECT 1 FROM v3_referrals v WHERE v.invitee=r.invitee)
        ORDER BY d.requested,d.id`);
      for(const row of rows){
        this.qualify(row.invitee,row.verified_phone,row.online_paid||row.requested||row.last_seen||row.paid_until-DAY);
      }
      for(const row of store.all('SELECT phone,user_id FROM verified_numbers')){
        this.rememberPhone(row.user_id,row.phone);
      }
      store.run("INSERT INTO v3_migrations VALUES ('verified-referrals')");
    });
  }
  fail(status,message){throw new this.Error(status,message);}
  audit(actor,action,target,summary){
    this.s.run('INSERT INTO v3_audit(actor,action,target,summary,created) VALUES (?,?,?,?,?)',
      actor,action,target,summary,this.s.clock());
  }
  role(user){
    if(user.is_owner)return {level:null,suspended:false,permissions:Object.keys(PERMISSIONS)};
    const record=this.s.get('SELECT level,suspended FROM v3_admins WHERE user_id=?',user.id);
    if(!record)return {level:null,suspended:false,permissions:[]};
    return {level:record.level,suspended:!!record.suspended,permissions:record.suspended?[]:
      this.s.all('SELECT permission FROM v3_permissions WHERE level=? ORDER BY permission',record.level).map(row=>row.permission)};
  }
  permit(id,permission){
    const user=this.s.requireActive(id);
    if(permission==='founder'&&!user.is_owner)this.fail(403,'Founder access required.');
    if(permission!=='founder'&&!this.role(user).permissions.includes(permission))
      this.fail(403,'You do not have permission for this action.');
    return user;
  }
  canManageLower(id){
    const user=this.s.requireActive(id);
    const role=this.role(user);
    return !!user.is_owner||(role.level===7&&!role.suspended&&role.permissions.includes('staff.manage.lower'));
  }
  staff(id){
    const actor=this.s.requireActive(id),founder=!!actor.is_owner;
    if(!this.canManageLower(id))this.fail(403,'Staff management access required.');
    return {
      canEditPermissions:founder,
      permissions:founder?PERMISSIONS:{},
      levels:founder?this.s.all('SELECT level,permission FROM v3_permissions ORDER BY level,permission'):[],
      admins:this.s.all(`SELECT a.user_id AS id,a.level,a.suspended,u.name,u.email,u.banned,p.closed_at AS closed
        FROM v3_admins a JOIN users u ON u.id=a.user_id JOIN portal_profiles p ON p.user_id=u.id
        WHERE (? OR a.level<7) ORDER BY a.level DESC,u.name`,Number(founder)),
      audit:this.s.all(`SELECT a.action,a.target,a.summary,a.created,u.name AS actor,u.email AS actorEmail
        FROM v3_audit a JOIN users u ON u.id=a.actor
        WHERE (? OR (a.actor=? AND a.action IN ('admin.level','admin.suspend','admin.restore','admin.remove')))
        ORDER BY a.id DESC LIMIT 100`,Number(founder),id)
    };
  }
  staffSearch(id,query=''){
    if(!this.canManageLower(id))this.fail(403,'Staff management access required.');
    const user=this.s.user(id),q=String(query||'').trim().toLowerCase().slice(0,100);
    if(q.length<2)this.fail(400,'Enter at least two characters to search accounts.');
    return this.s.all(`SELECT u.id,u.name,u.email,a.level,a.suspended
      FROM users u LEFT JOIN v3_admins a ON a.user_id=u.id
      LEFT JOIN portal_profiles p ON p.user_id=u.id
      WHERE u.banned=0 AND p.closed_at IS NULL
        AND u.id NOT IN (SELECT user_id FROM owner)
        AND (? OR a.level IS NULL OR a.level<7)
        AND (lower(u.name) LIKE ? OR lower(u.email) LIKE ?)
      ORDER BY u.created DESC LIMIT 20`,Number(!!user.is_owner),'%'+q+'%','%'+q+'%');
  }
  overview(id){
    const user=this.s.requireActive(id),permissions=this.role(user).permissions;
    if(!user.is_owner&&!permissions.length)this.fail(403,'Administrative access required.');
    const visible=p=>user.is_owner||permissions.includes(p);
    const now=this.s.clock(),out={};
    if(visible('users.view'))out.users=this.s.get('SELECT COUNT(*) AS value FROM users').value;
    if(visible('deployments.view')){
      out.bots=this.s.get("SELECT COUNT(*) AS total,COUNT(CASE WHEN state='online' AND last_seen>? THEN 1 END) AS online FROM deployments WHERE state<>'cancelled'",now-12000);
      out.workerAvailable=this.s.workerSeen!==null&&this.s.workerSeen+15000>now;
    }
    if(visible('tickets.view'))out.tickets=this.s.get('SELECT COUNT(*) AS value FROM v3_tickets WHERE closed=0').value;
    if(visible('coins.view'))out.coins=this.s.get("SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) AS credited FROM ledger WHERE kind='coin_purchase'").credited;
    if(user.is_owner)out.revenue=this.s.get("SELECT COALESCE(SUM(naira),0) AS value FROM v3_payments WHERE status='approved'").value;
    if(visible('vip.view'))out.vip=this.s.get('SELECT COUNT(*) AS value FROM vip_memberships WHERE expiry>?',now).value;
    if(this.canManageLower(id))out.staff=this.s.get('SELECT COUNT(*) AS value FROM v3_admins').value;
    return out;
  }
  setPermissions(id,{level,permissions}={}){
    return this.s.tx(()=>{
      this.permit(id,'founder');
      if(!Number.isInteger(level)||level<1||level>7||!Array.isArray(permissions)||
        permissions.length>Object.keys(PERMISSIONS).length||
        !permissions.every(key=>typeof key==='string'&&Object.hasOwn(PERMISSIONS,key)))
        this.fail(400,'Choose an administrator level and valid permissions.');
      this.s.run('DELETE FROM v3_permissions WHERE level=?',level);
      for(const key of new Set(permissions))this.s.run('INSERT INTO v3_permissions VALUES (?,?)',level,key);
      this.audit(id,'admin.permissions',String(level),permissions.join(', ')||'All permissions cleared');
    });
  }
  setStaff(id,{userId,action,level,reason=''}={}){
    return this.s.tx(()=>{
      const actor=this.s.requireActive(id);
      if(!this.canManageLower(id))this.fail(403,'Staff management access required.');
      const founder=!!actor.is_owner;
      if(typeof reason!=='string'||reason.length>180)this.fail(400,'Enter a reason under 180 characters.');
      if(!founder&&!reason.trim())this.fail(400,'A reason is required for delegated staff changes.');
      const target=this.s.user(typeof userId==='string'?userId:'');
      if(!founder&&target?.id===actor.id)this.fail(403,'Administrators cannot modify their own appointment.');
      if(!target||target.is_owner)this.fail(404,'Select a regular account.');
      const prior=this.s.get('SELECT level,suspended FROM v3_admins WHERE user_id=?',target.id);
      if(!founder&&prior?.level===7)this.fail(403,'Level 7 administrators cannot manage other Level 7 administrators.');
      if(action==='level'){
        if(target.banned||target.closed_at)this.fail(409,'Select an active account.');
        if(!Number.isInteger(level)||level<1||level>(founder?7:6))
          this.fail(403,'You cannot appoint or promote an administrator to this level.');
        this.s.run(`INSERT INTO v3_admins(user_id,level) VALUES (?,?)
          ON CONFLICT(user_id) DO UPDATE SET level=excluded.level`,target.id,level);
      }else{
        if(!prior)this.fail(404,'Administrator not found.');
        if(action==='remove')this.s.run('DELETE FROM v3_admins WHERE user_id=?',target.id);
        else if(action==='suspend'||action==='restore'){
          if(action==='restore'&&(target.banned||target.closed_at))this.fail(409,'This account is inactive.');
          this.s.run('UPDATE v3_admins SET suspended=? WHERE user_id=?',Number(action==='suspend'),target.id);
        }else this.fail(400,'Choose an administrator action.');
      }
      const transition=action==='level'?'Adm Lvl '+(prior?.level||'none')+' → Adm Lvl '+level:
        action==='remove'?'Adm Lvl '+prior.level+' → removed':
        action+' Adm Lvl '+prior.level;
      this.audit(id,'admin.'+action,target.id,transition+' · '+target.email+(reason.trim()?' · Reason: '+reason.trim():''));
    });
  }
  ticketInbox(id,staff,before){
    if(staff){
      this.permit(id,'tickets.view');
      const rank=before?.rank??0,stamp=before?.stamp??null;
      return this.s.all(`WITH ranked AS (
        SELECT t.id,t.subject,t.closed,t.updated,t.created,a.name AS assignee,u.name AS requester,
          COALESCE((SELECT CASE m.tier WHEN 'diamond' THEN 3 WHEN 'gold' THEN 2 WHEN 'silver' THEN 1 ELSE 0 END
            FROM vip_memberships m WHERE m.user_id=t.user_id AND m.expiry>? LIMIT 1),0) AS priorityRank
        FROM v3_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assignee)
        SELECT * FROM ranked WHERE (? IS NULL OR priorityRank<? OR
          (priorityRank=? AND (updated<? OR (updated=? AND id<?))))
        ORDER BY priorityRank DESC,updated DESC,id DESC LIMIT 51`,
        this.s.clock(),stamp,rank,rank,stamp??0,stamp??0,before?.id??'');
    }
    this.s.requireActive(id);
    return this.s.all(`SELECT t.id,t.subject,t.closed,t.updated,t.created,a.name AS assignee,u.name AS requester
      FROM v3_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assignee
      WHERE t.user_id=? AND (? IS NULL OR t.updated<? OR (t.updated=? AND t.id<?))
      ORDER BY t.updated DESC,t.id DESC LIMIT 51`,id,before?.stamp??null,
      before?.stamp??null,before?.stamp??null,before?.id??'');
  }
  ticket(id,ticketId,staff){
    if(staff)this.permit(id,'tickets.view');
    else this.s.requireActive(id);
    const ticket=this.s.get(`SELECT t.*,u.name AS requester,a.name AS assigneeName
      FROM v3_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assignee
      WHERE t.id=? AND (? OR t.user_id=?)`,ticketId,Number(staff),id);
    if(!ticket)this.fail(404,'Ticket not found.');
    return ticket;
  }
  assignees(){
    return this.s.all(`SELECT id FROM users WHERE banned=0 AND
      (id IN (SELECT user_id FROM owner) OR id IN (SELECT user_id FROM v3_admins WHERE suspended=0
        AND level IN (SELECT level FROM v3_permissions WHERE permission='tickets.view')))`)
      .map(({id})=>this.s.user(id)).filter(user=>!user.closed_at)
      .map(user=>({id:user.id,name:user.name}));
  }
  ticketView(id,ticketId,staff){
    const {id:ticket,subject,closed,assignee,assigneeName,requester}=this.ticket(id,ticketId,staff);
    return {id:ticket,subject,closed:!!closed,assignee:staff?assignee:undefined,assigneeName,requester,
      assignees:staff&&this.role(this.s.user(id)).permissions.includes('tickets.assign')?this.assignees():[],
      messages:this.s.all(`SELECT m.id,m.message,m.staff,(m.screenshot IS NOT NULL) AS screenshot,m.created,
        CASE WHEN m.staff THEN 'RAYMON BOT Support' ELSE u.name END AS author
        FROM v3_ticket_messages m JOIN users u ON u.id=m.author WHERE m.ticket_id=? ORDER BY m.rowid`,ticket)};
  }
  ticketAttachment(id,ticketId,messageId,staff){
    this.ticket(id,ticketId,staff);
    const row=this.s.get('SELECT screenshot FROM v3_ticket_messages WHERE ticket_id=? AND id=?',ticketId,messageId);
    if(!row?.screenshot)this.fail(404,'Screenshot not found.');
    return row.screenshot;
  }
  ticketNotice(userId,ticketId,staff,title,description){
    const event=this.s.event(userId,null,title,description);
    this.s.run('INSERT INTO v3_ticket_notices VALUES (?,?,?)',event,ticketId,Number(staff));
  }
  ticketAction(id,staff,data,screenshot){
    return this.s.tx(()=>{
      const {action,ticketId,subject,message,assignee}=data;
      const now=this.s.clock();
      const text=typeof message==='string'?message.trim():'';
      if(action==='create'||action==='reply'){
        if(!text||text.length>4000)this.fail(400,'Enter a message of up to 4,000 characters.');
      }
      if(screenshot){
        const storage=this.s.get('SELECT COALESCE(SUM(length(screenshot)),0) AS used FROM v3_ticket_messages WHERE screenshot IS NOT NULL');
        if(storage.used+screenshot.length>100*1024*1024)
          this.fail(409,'Screenshot storage is full. Send this message without an attachment.');
      }
      if(action==='create'&&!staff){
        this.s.requireActive(id);
        const title=typeof subject==='string'?subject.trim():'';
        if(!title||title.length>120)this.fail(400,'Enter a subject of up to 120 characters.');
        if(this.s.get('SELECT count(*) AS n FROM v3_tickets WHERE user_id=? AND closed=0',id).n>=10)
          this.fail(409,'You already have 10 open tickets. Reply in an existing ticket.');
        const ticket=randomUUID();
        this.s.run('INSERT INTO v3_tickets(id,user_id,subject,created,updated) VALUES (?,?,?,?,?)',ticket,id,title,now,now);
        this.s.run('INSERT INTO v3_ticket_messages VALUES (?,?,?,?,?,?,?)',randomUUID(),ticket,id,0,text,screenshot,now);
        return {id:ticket};
      }
      if(typeof ticketId!=='string')this.fail(400,'Select a ticket.');
      const ticket=this.ticket(id,ticketId,staff);
      if(ticket.closed)this.fail(409,'This ticket is closed.');
      if(action==='reply'){
        if(staff)this.permit(id,'tickets.reply');
        if(this.s.get('SELECT count(*) AS n FROM v3_ticket_messages WHERE ticket_id=?',ticket.id).n>=100)
          this.fail(409,'This ticket has reached its message limit. Open a new ticket if you still need help.');
        this.s.run('INSERT INTO v3_ticket_messages VALUES (?,?,?,?,?,?,?)',randomUUID(),ticket.id,id,Number(staff),text,screenshot,now);
        if(staff)this.ticketNotice(ticket.user_id,ticket.id,false,'New support reply','Read the reply to “'+ticket.subject+'”.');
        else if(ticket.assignee)this.ticketNotice(ticket.assignee,ticket.id,true,'New reply in support inbox','Read the reply to “'+ticket.subject+'”.');
      }else if(action==='assign'&&staff){
        this.permit(id,'tickets.assign');
        if(assignee!==null&&!this.assignees().some(row=>row.id===assignee))this.fail(400,'Choose an active support administrator.');
        this.s.run('UPDATE v3_tickets SET assignee=? WHERE id=?',assignee,ticket.id);
        if(assignee&&assignee!==id&&assignee!==ticket.assignee)
          this.ticketNotice(assignee,ticket.id,true,'Support ticket assigned','Review “'+ticket.subject+'” in the support inbox.');
      }else if(action==='close'&&staff){
        this.permit(id,'tickets.close');
        this.s.run('UPDATE v3_tickets SET closed=1 WHERE id=?',ticket.id);
        this.ticketNotice(ticket.user_id,ticket.id,false,'Support ticket closed','Your ticket “'+ticket.subject+'” was closed.');
      }else this.fail(400,'Choose a ticket action.');
      this.s.run('UPDATE v3_tickets SET updated=? WHERE id=?',now,ticket.id);
      if(staff)this.audit(id,'ticket.'+action,ticket.id,action==='assign'?(assignee||'Unassigned'):ticket.subject);
      return {id:ticket.id};
    });
  }
  packages(id,manage=false){
    if(manage)this.permit(id,'founder');
    else this.s.requireActive(id);
    return this.s.all('SELECT id,naira,coins,active,revision FROM v3_coin_packages WHERE (? OR active=1) ORDER BY coins,naira,id',Number(manage))
      .map(row=>({...row,active:!!row.active}));
  }
  savePackage(id,{packageId,expectedRevision,naira,coins,active}={}){
    return this.s.tx(()=>{
      this.permit(id,'founder');
      if(typeof packageId!=='string'||!packageId||packageId.length>36||
        !Number.isSafeInteger(naira)||naira<1||naira>100_000_000||
        !Number.isSafeInteger(coins)||coins<1||coins>1_000_000||typeof active!=='boolean'||
        expectedRevision!==null&&typeof expectedRevision!=='string')
        this.fail(400,'Enter a whole price in naira, a positive coin amount, and the package status.');
      const existing=this.s.get('SELECT * FROM v3_coin_packages WHERE id=?',packageId);
      if(existing){
        if(existing.naira===naira&&existing.coins===coins&&!!existing.active===active)return {id:existing.id,revision:existing.revision};
        if(expectedRevision!==existing.revision)this.fail(409,'This package changed. Refresh the package list before editing it.');
      }else if(expectedRevision!==null||!/^[a-f0-9-]{36}$/.test(packageId)){
        this.fail(409,'Package not found. Refresh the list and try again.');
      }
      const revision=randomUUID();
      this.s.run(`INSERT INTO v3_coin_packages VALUES (?,?,?,?,?) ON CONFLICT(id)
        DO UPDATE SET naira=excluded.naira,coins=excluded.coins,active=excluded.active,revision=excluded.revision`,
        packageId,naira,coins,Number(active),revision);
      this.audit(id,existing?'package.updated':'package.created',packageId,
        coins+' coins · '+naira+' naira · '+(active?'Active':'Inactive'));
      return {id:packageId,revision};
    });
  }
  paymentRows(id,review,before){
    if(review)this.permit(id,'founder');
    else this.s.requireActive(id);
    const rows=this.s.all(`SELECT p.id,p.package_id AS packageId,p.naira,p.coins,p.reference,p.status,
      p.reason,p.created,p.reviewed,u.name,u.email
      FROM v3_payments p JOIN users u ON u.id=p.user_id
      WHERE (? OR p.user_id=?) AND p.rowid<COALESCE((SELECT rowid FROM v3_payments WHERE id=?),9223372036854775807)
      ORDER BY p.rowid DESC LIMIT 51`,Number(review),id,before||'');
    return {
      bank:'OPay',accountNumber:'8059692394',packages:this.packages(id),
      items:rows.slice(0,50).map(row=>{
        if(review)return row;
        const {name,email,...payment}=row;
        return payment;
      }),
      more:rows.length>50
    };
  }
  payment(id,paymentId,review){
    if(review)this.permit(id,'founder');
    else this.s.requireActive(id);
    const payment=this.s.get('SELECT * FROM v3_payments WHERE id=? AND (? OR user_id=?)',
      paymentId,Number(review),id);
    if(!payment)this.fail(404,'Payment request not found.');
    return payment;
  }
  submitPayment(id,{requestId,packageId,packageRevision,reference}={},screenshot){
    return this.s.tx(()=>{
      this.s.requireActive(id);
      const text=typeof reference==='string'?reference.trim():'';
      const key=text.replace(/[^a-z0-9]/gi,'').toUpperCase();
      if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId)||typeof packageId!=='string'||
        !text||text.length>120||key.length<6||!Buffer.isBuffer(screenshot)||!screenshot.length)
        this.fail(400,'Choose a coin package, enter the bank transaction reference, and upload a payment screenshot.');
      const screenshotHash=createHash('sha256').update(screenshot).digest('hex');
      const prior=this.s.get('SELECT * FROM v3_payments WHERE id=?',requestId);
      if(prior){
        if(prior.user_id!==id||prior.package_id!==packageId||prior.reference_key!==key||prior.screenshot_hash!==screenshotHash)
          this.fail(409,'This request has already been used. Refresh your payment history.');
        return {id:prior.id,status:prior.status};
      }
      const selected=this.s.get('SELECT id,coins,naira,revision,active FROM v3_coin_packages WHERE id=?',packageId);
      if(!selected)this.fail(400,'Choose an available coin package.');
      if(!selected.active)this.fail(409,'This package is unavailable. Refresh the coin packages.');
      if(packageRevision!==undefined&&packageRevision!==selected.revision)
        this.fail(409,'This package changed. Refresh the coin packages before sending a payment.');
      if(this.s.get('SELECT 1 FROM v3_payments WHERE reference_key=? OR screenshot_hash=?',key,screenshotHash))
        this.fail(409,'This transaction reference or payment screenshot has already been submitted.');
      if(this.s.get("SELECT count(*) AS n FROM v3_payments WHERE user_id=? AND status='pending'",id).n>=5)
        this.fail(409,'You already have five payments awaiting review.');
      const used=this.s.get('SELECT COALESCE(sum(length(screenshot)),0) AS bytes FROM v3_payments').bytes;
      if(used+screenshot.length>100*1024*1024)
        this.fail(409,'Receipt storage is full. Contact support for help with your payment.');
      this.s.run(`INSERT INTO v3_payments
        (id,user_id,package_id,naira,coins,reference,reference_key,screenshot,screenshot_hash,created)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        requestId,id,selected.id,selected.naira,selected.coins,text,key,screenshot,screenshotHash,this.s.clock());
      const founder=this.s.get('SELECT user_id FROM owner WHERE singleton=1')?.user_id;
      if(founder)this.s.event(founder,null,'New coin payment to review',
        'A '+selected.naira+' naira payment request is waiting in Founder Dashboard → Coin Payments.');
      return {id:requestId,status:'pending'};
    });
  }
  reviewPayment(id,{paymentId,decision,reason}={}){
    return this.s.tx(()=>{
      this.permit(id,'founder');
      if(typeof paymentId!=='string'||!['approved','rejected'].includes(decision))
        this.fail(400,'Select a payment and review decision.');
      const payment=this.payment(id,paymentId,true);
      if(payment.status!=='pending'){
        if(payment.status===decision)return {status:payment.status};
        this.fail(409,'This payment has already been reviewed.');
      }
      const message=typeof reason==='string'?reason.trim():'';
      if(message.length>500||decision==='rejected'&&!message)
        this.fail(400,'Enter a rejection reason of up to 500 characters.');
      if(decision==='approved'){
        this.s.credit(payment.user_id,payment.coins,'coin_purchase',
          'Bank transfer purchase · '+payment.reference,id,'payment:'+payment.id);
        this.s.vip.purchaseBonus(payment.user_id,payment.coins,payment.id);
      }
      this.s.run('UPDATE v3_payments SET status=?,reason=?,reviewer=?,reviewed=? WHERE id=?',
        decision,message,id,this.s.clock(),payment.id);
      this.s.event(payment.user_id,null,decision==='approved'?'Coin payment approved':'Coin payment rejected',
        decision==='approved'?payment.coins+' coins were added to your balance.':message);
      this.audit(id,'payment.'+decision,payment.id,payment.coins+' coins · '+payment.reference+(message?' · '+message:''));
      return {status:decision};
    });
  }
  promos(id,promo,before,claimBefore=null){
    this.permit(id,'promos.view');
    const codes=this.s.all(`SELECT p.id,p.code,p.amount,p.expires,p.max_claims AS maxClaims,p.active,
      (SELECT count(*) FROM v3_claims c WHERE c.promo_id=p.id) AS claims
      FROM v3_promos p WHERE p.rowid < COALESCE((SELECT rowid FROM v3_promos WHERE id=?),9223372036854775807)
      ORDER BY p.rowid DESC LIMIT 51`,before||'');
    const history=promo?this.s.all(`SELECT u.name,u.email,c.amount,c.created,c.rowid AS cursor FROM v3_claims c
      JOIN users u ON c.user_id=u.id WHERE c.promo_id=? AND c.rowid<COALESCE(?,9223372036854775807)
      ORDER BY c.rowid DESC LIMIT 101`,promo,claimBefore):[];
    return {codes,history};
  }
  normalizedCode(code){
    const value=typeof code==='string'?code.trim().toUpperCase():'';
    if(!/^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(value))this.fail(400,'Enter a code with 4–32 letters, numbers, hyphens, or underscores.');
    return value;
  }
  promoSave(id,{promoId,code,amount,expires,maxClaims,active}={}){
    return this.s.tx(()=>{
      this.permit(id,'founder');
      if(typeof active!=='boolean')this.fail(400,'Set the activation status.');
      const existing=promoId===undefined?null:this.s.get('SELECT * FROM v3_promos WHERE id=?',typeof promoId==='string'?promoId:'');
      if(promoId!==undefined&&!existing)this.fail(404,'Code not found.');
      const now=this.s.clock();
      if(existing&&amount===undefined&&expires===undefined&&maxClaims===undefined){
        if(active&&existing.expires<=now)this.fail(409,'Extend the expiry before activating this code.');
        this.s.run('UPDATE v3_promos SET active=? WHERE id=?',Number(active),existing.id);
        this.audit(id,'promo.activation',existing.id,active?'Activated':'Deactivated');
        return;
      }
      if(!Number.isSafeInteger(amount)||amount<1||amount>100_000||!Number.isSafeInteger(maxClaims)||maxClaims<1||maxClaims>1_000_000||
        !Number.isSafeInteger(expires)||expires<=now||expires>now+3650*DAY)
        this.fail(400,'Choose valid coins, a future expiry, and a redemption limit.');
      if(existing){
        const claims=this.s.get('SELECT count(*) AS n FROM v3_claims WHERE promo_id=?',existing.id).n;
        if(maxClaims<claims)this.fail(409,'The limit cannot be below the number of claims already made.');
        this.s.run('UPDATE v3_promos SET amount=?,expires=?,max_claims=?,active=? WHERE id=?',
          amount,expires,maxClaims,Number(active),existing.id);
        this.audit(id,'promo.updated',existing.id,'Changed reward, expiry or limit');
      }else{
        const value=this.normalizedCode(code);
        if(this.s.get('SELECT 1 FROM v3_promos WHERE code=?',value))this.fail(409,'This code already exists.');
        const promo=randomUUID();
        this.s.run('INSERT INTO v3_promos VALUES (?,?,?,?,?,?,?)',promo,value,amount,expires,maxClaims,Number(active),now);
        this.audit(id,'promo.created',promo,'Created a '+amount+' coin code');
      }
    });
  }
  redeem(id,code){
    const value=this.normalizedCode(code);
    return this.s.tx(()=>{
      const user=this.s.requireActive(id);
      const promo=this.s.get('SELECT * FROM v3_promos WHERE code=?',value);
      if(!promo||!promo.active||promo.expires<=this.s.clock())this.fail(404,'This promo code is unavailable or expired.');
      if(this.s.get('SELECT 1 FROM v3_claims WHERE promo_id=? AND user_id=?',promo.id,id))
        this.fail(409,'You already redeemed this code.');
      if(this.s.get('SELECT count(*) AS n FROM v3_claims WHERE promo_id=?',promo.id).n>=promo.max_claims)
        this.fail(409,'This code has reached its redemption limit.');
      if(user.coins+promo.amount>1_000_000)this.fail(409,'This reward would exceed your balance limit.');
      this.s.run('INSERT INTO v3_claims VALUES (?,?,?,?)',promo.id,id,promo.amount,this.s.clock());
      this.s.credit(id,promo.amount,'promo','Promotional coin reward',null,'promo:'+promo.id+':'+id);
      return {amount:promo.amount};
    });
  }
  onboarding(id){
    return this.s.get('SELECT step FROM v3_onboarding WHERE user_id=?',id)?.step??null;
  }
  saveOnboarding(id,step){
    this.s.requireActive(id);
    if(!Number.isInteger(step)||step< -1||step>4)this.fail(400,'Choose a tutorial step.');
    this.s.run(`INSERT INTO v3_onboarding VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET step=excluded.step`,id,step);
  }
  qualify(invitee,phone,qualified){
    const fingerprint=this.rememberPhone(invitee,phone);
    const first=this.s.get('SELECT first_user FROM v3_referral_phones WHERE fingerprint=?',fingerprint);
    if(first.first_user!==invitee)return;
    const user=this.s.get('SELECT referred_by FROM portal_profiles WHERE user_id=?',invitee);
    if(!user?.referred_by||user.referred_by===invitee)return;
    this.s.run(`INSERT OR IGNORE INTO v3_referrals(invitee,inviter,phone_hash,qualified) VALUES (?,?,?,?)`,
      invitee,user.referred_by,fingerprint,qualified);
  }
  rememberPhone(id,phone){
    const fingerprint=digest('referral-phone:'+phone);
    this.s.run('INSERT OR IGNORE INTO v3_referral_phones VALUES (?,?)',fingerprint,id);
    return fingerprint;
  }
  leaderboard(start,end,limit=50){
    return this.s.all(`SELECT r.inviter AS id,COALESCE(p.username,u.name) AS name,COUNT(*) AS referrals,MAX(r.qualified) AS reached
      FROM v3_referrals r JOIN users u ON u.id=r.inviter JOIN portal_profiles p ON p.user_id=u.id
      JOIN users i ON i.id=r.invitee JOIN portal_profiles ip ON ip.user_id=i.id
      WHERE r.qualified>=? AND r.qualified<? AND r.excluded=0 AND u.banned=0 AND i.banned=0
        AND p.closed_at IS NULL AND ip.closed_at IS NULL
      GROUP BY r.inviter ORDER BY referrals DESC,reached ASC,r.inviter ASC LIMIT ?`,
      start,end||this.s.clock()+1,limit);
  }
  window(period,previous=0){
    if(!PERIODS.includes(period)||!Number.isInteger(previous)||previous<0||previous>366||period==='all'&&previous)
      this.fail(400,'Choose a leaderboard period.');
    return periodWindow(period,this.s.clock(),previous);
  }
  rankings(id,period,previous){
    this.s.requireActive(id);
    const [start,end]=this.window(period,previous);
    const rows=this.leaderboard(start,end);
    const rule=this.s.get('SELECT mode,prizes FROM v3_prizes WHERE period=?',period);
    return {start,end,rows:rows.map(({id:inviter,name,referrals},index)=>({rank:index+1,name,referrals,you:id===inviter})),
      prizes:rule&&rule.mode!=='off'?JSON.parse(rule.prizes):[],mode:rule?.mode??'off'};
  }
  referralAdmin(id,period,previous){
    const user=this.permit(id,'referrals.view');
    const [start,end]=this.window(period,previous);
    const prize=this.s.get('SELECT mode,prizes,next_start AS nextStart FROM v3_prizes WHERE period=?',period);
    const rows=this.s.all(`SELECT r.invitee,r.excluded,r.qualified,u.email AS inviteeEmail,i.email AS inviterEmail
      FROM v3_referrals r JOIN users u ON u.id=r.invitee JOIN users i ON i.id=r.inviter
      WHERE qualified>=? AND qualified<? ORDER BY r.qualified DESC,r.invitee LIMIT 100`,start,end||this.s.clock()+1);
    const award=this.s.get('SELECT mode,awarded,winners FROM v3_awards WHERE period=? AND starts=?',period,start);
    const eligible=prize?.mode==='manual'&&(!end||end<=this.s.clock())&&!award;
    return {rows,prize:prize&&{...prize,prizes:JSON.parse(prize.prizes)},award:award&&{...award,winners:JSON.parse(award.winners)},
      start,end,preview:user.is_owner&&eligible?this.winners(start,end,JSON.parse(prize.prizes)):null};
  }
  winners(start,end,prizes){
    return this.leaderboard(start,end,prizes.length).map((row,index)=>({
      id:row.id,name:row.name,referrals:row.referrals,rank:index+1,amount:prizes[index]
    }));
  }
  referralAction(id,{action,period,previous=0,mode,prizes,invitee,excluded,preview,expectedStart}={}){
    return this.s.tx(()=>{
      if(action==='review'){
        this.permit(id,'referrals.review');
        if(typeof invitee!=='string'||typeof excluded!=='boolean'||
          !this.s.run('UPDATE v3_referrals SET excluded=? WHERE invitee=?',Number(excluded),invitee).changes)
          this.fail(404,'Referral not found.');
        this.audit(id,'referral.review',invitee,excluded?'Excluded from rankings':'Restored to rankings');
        return;
      }
      this.permit(id,'founder');
      const [start,end]=this.window(period,previous);
      if(action==='configure'){
        if(!['off','manual','automatic'].includes(mode)||mode==='automatic'&&period==='all'||
          !Array.isArray(prizes)||prizes.length>10||mode!=='off'&&!prizes.length||
          !prizes.every(value=>Number.isSafeInteger(value)&&value>=1&&value<=100_000))
          this.fail(400,'Enter up to 10 prizes of 1–100,000 coins. All-time awards require manual approval.');
        const prior=this.s.get('SELECT mode,next_start FROM v3_prizes WHERE period=?',period);
        if(prior?.mode==='automatic'&&periodWindow(period,prior.next_start)[1]<=this.s.clock())
          this.fail(409,'An automatic award is due. Wait for it to finish before changing this rule.');
        const cursor=prior?.mode==='automatic'?prior.next_start:periodWindow(period,this.s.clock())[0];
        this.s.run(`INSERT INTO v3_prizes VALUES (?,?,?,?) ON CONFLICT(period)
          DO UPDATE SET mode=excluded.mode,prizes=excluded.prizes,next_start=excluded.next_start`,
          period,mode,JSON.stringify(prizes),cursor);
        this.audit(id,'referral.prizes',period,mode+' · '+prizes.join(', '));
      }else if(action==='approve'){
        const rule=this.s.get('SELECT mode,prizes FROM v3_prizes WHERE period=?',period);
        if(rule?.mode!=='manual'||end>this.s.clock()||expectedStart!==start)
          this.fail(409,'Select a closed period with manual awards enabled and reload the preview.');
        if(this.s.get('SELECT 1 FROM v3_awards WHERE period=? AND starts=?',period,start))
          this.fail(409,'Prizes have already been processed for this period.');
        const winners=this.winners(start,end,JSON.parse(rule.prizes));
        if(!winners.length)this.fail(409,'No qualified winners for this period.');
        if(typeof preview!=='string'||preview!==JSON.stringify(winners))this.fail(409,'The rankings or prizes changed. Reload the preview.');
        this.settle(id,period,start,end,'manual',winners);
      }else this.fail(400,'Choose a referral action.');
    });
  }
  settle(founder,period,start,end,mode,winners){
    const outcomes=winners.map(winner=>{
      this.s.credit(winner.id,winner.amount,'referral_prize','Referral leaderboard prize',founder,
        'referral-prize:'+period+':'+start+':'+winner.id);
      this.s.event(winner.id,null,'Referral leaderboard prize','You earned '+winner.amount+' coins for placing #'+winner.rank+'.');
      return {...winner,paid:true};
    });
    this.s.run('INSERT INTO v3_awards VALUES (?,?,?,?,?,?)',period,start,end,mode,this.s.clock(),JSON.stringify(outcomes));
    this.audit(founder,'referral.awarded',period,mode+' · '+outcomes.filter(row=>row.paid).length+' prizes paid');
  }
  settleAutomatic(){
    const founder=this.s.get('SELECT user_id FROM owner WHERE singleton=1')?.user_id;
    if(!founder)return;
    for(const {period} of this.s.all("SELECT period FROM v3_prizes WHERE mode='automatic'")){
      for(let i=0;i<12;i++){
        const advanced=this.s.tx(()=>{
          const rule=this.s.get("SELECT prizes,next_start FROM v3_prizes WHERE period=? AND mode='automatic'",period);
          if(!rule)return false;
          const start=rule.next_start,end=periodWindow(period,start)[1];
          if(end>this.s.clock())return false;
          if(!this.s.get('SELECT 1 FROM v3_awards WHERE period=? AND starts=?',period,start))
            this.settle(founder,period,start,end,'automatic',this.winners(start,end,JSON.parse(rule.prizes)));
          this.s.run('UPDATE v3_prizes SET next_start=? WHERE period=?',end,period);
          return true;
        });
        if(!advanced)break;
      }
    }
  }
}

module.exports={PortalV3,ACCOUNT_PERMISSIONS,ADMIN_ACTIONS};
