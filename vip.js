'use strict';
const {randomUUID}=require('node:crypto');
const DAY=86400000;
const WEEK=7*DAY,MONTH=30*DAY;
const defaults=[
  ['silver','Silver',50,180,10,2,1,2,7,2,2,1],
  ['gold','Gold',150,550,20,5,2,5,30,5,5,2],
  ['diamond','Diamond',400,1500,30,10,3,20,90,10,10,3]
];
const tiers=['silver','gold','diamond'];
const premiumThemes=['midnight','silver','gold','ocean','royal','diamond','graphite'];
function tierRank(tier){return tiers.indexOf(tier)+1;}
function cleanBrand(x){
  if(typeof x!=='string'||x.length>60||!x.trim()||/[\x00-\x1f<>]/.test(x))
    return null;
  return x.trim();
}
class Vip {
  constructor(store,ErrorType){
    this.s=store;this.Error=ErrorType;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS vip_plans (
        tier TEXT PRIMARY KEY, title TEXT NOT NULL,
        weekly INTEGER NOT NULL, monthly INTEGER NOT NULL,
        discount INTEGER NOT NULL, daily INTEGER NOT NULL,
        slots INTEGER NOT NULL, themes INTEGER NOT NULL,
        analytics_days INTEGER NOT NULL, backups INTEGER NOT NULL,
        bonus_percent INTEGER NOT NULL, early INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vip_memberships (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        tier TEXT NOT NULL, expiry INTEGER NOT NULL,
        started INTEGER NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 0,
        duration TEXT NOT NULL, snapshot TEXT NOT NULL,
        branding TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS vip_purchases (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        tier TEXT NOT NULL, duration TEXT NOT NULL, cost INTEGER NOT NULL,
        credited INTEGER NOT NULL DEFAULT 0, actor TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vip_claims (
        user_id TEXT NOT NULL REFERENCES users(id), local_day INTEGER NOT NULL,
        PRIMARY KEY(user_id,local_day)
      );
      CREATE TABLE IF NOT EXISTS vip_backups (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        deployment_id TEXT NOT NULL REFERENCES deployments(id),
        contents TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vip_backups_user ON vip_backups(user_id,created DESC);
    `);
    for(const row of defaults){
      this.s.run(`INSERT OR IGNORE INTO vip_plans
        (tier,title,weekly,monthly,discount,daily,slots,themes,analytics_days,backups,bonus_percent,early,active,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,...row,this.s.clock());
    }
  }
  fail(status,message){throw new this.Error(status,message);}
  config(tier){return this.s.get('SELECT * FROM vip_plans WHERE tier=?',tier);}
  plans(){return this.s.all('SELECT * FROM vip_plans ORDER BY CASE tier WHEN \'silver\' THEN 1 WHEN \'gold\' THEN 2 WHEN \'diamond\' THEN 3 END');}
  membership(userId){
    const row=this.s.get('SELECT * FROM vip_memberships WHERE user_id=?',userId);
    if(!row||row.expiry<=this.s.clock())return null;
    return {...row,benefits:JSON.parse(row.snapshot)};
  }
  themeAllowed(userId,theme){
    if(['dark','light'].includes(theme))return true;
    const membership=this.membership(userId);
    return !!membership&&premiumThemes.slice(0,membership.benefits.themes).includes(theme);
  }
  status(userId){
    const m=this.membership(userId);
    const total=this.s.get("SELECT COUNT(*) AS count FROM deployments WHERE user_id=? AND state<>'cancelled'",userId).count;
    return {tier:m?.tier||null,expires:m?.expiry||null,autoRenew:!!m?.auto_renew,
      duration:m?.duration||null,benefits:m?.benefits||null,branding:m&&tierRank(m.tier)>=2?m.branding:'',
      allowedThemes:premiumThemes.slice(0,m?.benefits.themes||0),
      activeSlots:total,slotLimit:Math.min(this.s.maxBots,8+(m?.benefits.slots||0)),
      claimed:!!this.s.get('SELECT 1 FROM vip_claims WHERE user_id=? AND local_day=?',userId,this.day()),
      plans:this.plans().filter(p=>p.active).map(p=>({...p,badge:'/vip-'+p.tier+'.svg'}))};
  }
  day(){return Math.floor((this.s.clock()+3600000)/DAY);}
  rate(userId){const m=this.membership(userId);return Math.max(1,10-Math.floor((m?.benefits.discount||0)/10));}
  slotLimit(userId){return Math.min(this.s.maxBots,8+(this.membership(userId)?.benefits.slots||0));}
  snapshot(plan){
    return {discount:plan.discount,daily:plan.daily,slots:plan.slots,themes:plan.themes,
      analyticsDays:plan.analytics_days,backups:plan.backups,bonusPercent:plan.bonus_percent,
      early:plan.early,supportRank:tierRank(plan.tier)};
  }
  configure(actor,{tier,weekly,monthly,discount,daily,slots,themes,analyticsDays,backups,bonusPercent,early,active}){
    return this.s.tx(()=>{
      this.s.v3.permit(actor,'vip.plans');
      if(!tiers.includes(tier)||![[weekly,1,200000],[monthly,1,600000],[discount,0,80],
        [daily,0,100],[slots,0,20],[themes,0,20],[analyticsDays,1,365],
        [backups,0,20],[bonusPercent,0,30],[early,0,5]].every(([x,min,max])=>Number.isInteger(x)&&x>=min&&x<=max)||
        typeof active!=='boolean')this.fail(400,'Enter valid VIP prices and benefit limits.');
      this.s.run(`UPDATE vip_plans SET weekly=?,monthly=?,discount=?,daily=?,slots=?,themes=?,analytics_days=?,backups=?,
        bonus_percent=?,early=?,active=?,updated=? WHERE tier=?`,
        weekly,monthly,discount,daily,slots,themes,analyticsDays,backups,bonusPercent,early,Number(active),this.s.clock(),tier);
      this.s.v3.audit(actor,'vip.plan',tier,'Updated VIP plan settings');
      return {ok:true};
    });
  }
  buy(userId,{tier,duration,autoRenew=false}){
    return this.s.tx(()=>{
      const user=this.s.requireActive(userId),plan=this.config(tier);
      if(!plan||!plan.active||!['weekly','monthly'].includes(duration)||typeof autoRenew!=='boolean')
        this.fail(400,'Choose an available VIP package and duration.');
      const now=this.s.clock(),existing=this.membership(userId);
      if(existing&&existing.tier===tier)this.fail(409,'You already have this tier. Change renewal settings or renew after expiration.');
      const full=duration==='weekly'?plan.weekly:plan.monthly;
      const credit=existing?Math.min(full,Math.floor((existing.expiry-now)/(existing.duration==='weekly'?WEEK:MONTH)*
        (this.config(existing.tier)?.[existing.duration]||0))):0;
      const cost=Math.max(0,full-credit);
      if(user.coins<cost)this.fail(409,'Not enough coins to purchase this VIP membership.');
      const snap=this.snapshot(plan),expiry=now+(duration==='weekly'?WEEK:MONTH);
      if(cost)this.s.credit(userId,-cost,'vip_membership','VIP '+tier+' '+duration);
      this.s.run(`INSERT INTO vip_memberships (user_id,tier,expiry,started,auto_renew,duration,snapshot,branding)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
        tier=excluded.tier,expiry=excluded.expiry,started=excluded.started,
        auto_renew=excluded.auto_renew,duration=excluded.duration,snapshot=excluded.snapshot`,
        userId,tier,expiry,now,Number(autoRenew),duration,JSON.stringify(snap),existing?.branding||'');
      this.s.run('INSERT INTO vip_purchases VALUES (?,?,?,?,?,?,?,?)',
        randomUUID(),userId,tier,duration,cost,credit,null,now);
      this.s.event(userId,null,'VIP membership activated',plan.title+' VIP is active until '+new Date(expiry).toUTCString()+'.');
      return {tier,expiry,cost,credit};
    });
  }
  setRenewal(userId,enabled){
    this.s.requireActive(userId);
    if(typeof enabled!=='boolean'||!this.membership(userId))this.fail(409,'An active membership is required.');
    this.s.run('UPDATE vip_memberships SET auto_renew=? WHERE user_id=?',Number(enabled),userId);
    return {ok:true};
  }
  tick(){
    const now=this.s.clock();
    const rows=this.s.all('SELECT * FROM vip_memberships WHERE auto_renew=1 AND expiry<=? ORDER BY expiry LIMIT 100',now);
    for(const row of rows){
      try{this.s.tx(()=>{
        const member=this.s.get('SELECT * FROM vip_memberships WHERE user_id=?',row.user_id);
        if(!member||!member.auto_renew||member.expiry>now)return;
        const user=this.s.user(row.user_id),plan=this.config(member.tier);
        if(!user||user.banned||user.closed_at||!plan||!plan.active){this.s.run('UPDATE vip_memberships SET auto_renew=0 WHERE user_id=?',row.user_id);return;}
        const cost=member.duration==='weekly'?plan.weekly:plan.monthly;
        if(user.coins<cost){
          this.s.run('UPDATE vip_memberships SET auto_renew=0 WHERE user_id=?',row.user_id);
          this.s.event(row.user_id,null,'VIP renewal not completed','Add coins and renew your VIP package manually.');
          return;
        }
        this.s.credit(row.user_id,-cost,'vip_membership','VIP automatic renewal');
        const expiry=now+(member.duration==='weekly'?WEEK:MONTH);
        this.s.run('UPDATE vip_memberships SET expiry=?,started=?,snapshot=? WHERE user_id=?',
          expiry,now,JSON.stringify(this.snapshot(plan)),row.user_id);
        this.s.run('INSERT INTO vip_purchases VALUES (?,?,?,?,?,?,?,?)',randomUUID(),row.user_id,member.tier,member.duration,cost,0,null,now);
        this.s.event(row.user_id,null,'VIP renewed','Your membership renewed successfully.');
      });}catch(error){console.error('VIP renewal failed:',error.message);}
    }
  }
  claim(userId){
    return this.s.tx(()=>{
      const user=this.s.requireActive(userId),m=this.membership(userId);
      if(!m)this.fail(409,'An active VIP membership is required.');
      const day=this.day(),amount=m.benefits.daily;
      if(!amount)this.fail(409,'This membership has no daily VIP bonus.');
      if(this.s.get('SELECT 1 FROM vip_claims WHERE user_id=? AND local_day=?',userId,day))
        this.fail(409,'VIP daily bonus already claimed.');
      if(user.coins+amount>1000000)this.fail(409,'Wallet limit reached.');
      this.s.run('INSERT INTO vip_claims VALUES (?,?)',userId,day);
      this.s.credit(userId,amount,'vip_bonus','VIP daily reward');
      return {amount};
    });
  }
  purchaseBonus(userId,coins,paymentId){
    const m=this.membership(userId);
    if(!m)return 0;
    let bonus=Math.floor(coins*m.benefits.bonusPercent/100);
    const day=new Date(this.s.clock()+3600000);
    const month=day.toISOString().slice(0,7);
    const since=Date.parse(month+'-01T00:00:00Z')-3600000;
    const paid=this.s.get("SELECT COALESCE(SUM(delta),0) AS amount FROM ledger WHERE user_id=? AND kind='vip_purchase_bonus' AND created>=?",userId,since).amount;
    bonus=Math.max(0,Math.min(bonus,500-paid,1000000-this.s.user(userId).coins));
    if(bonus>0)this.s.credit(userId,bonus,'vip_purchase_bonus','VIP coin purchase bonus',null,'vip-payment:'+paymentId);
    return bonus;
  }
  branding(userId,title){
    this.s.requireActive(userId);
    const m=this.membership(userId);
    if(!m||tierRank(m.tier)<2)this.fail(403,'Gold or Diamond VIP is required for custom branding.');
    if(title!==''&&!cleanBrand(title))this.fail(400,'Enter up to 60 safe characters for your bot branding.');
    this.s.run('UPDATE vip_memberships SET branding=? WHERE user_id=?',title?cleanBrand(title):'',userId);
    return {branding:title};
  }
  backup(userId,deploymentId){
    this.s.requireActive(userId);
    const m=this.membership(userId);
    if(!m||m.benefits.backups<1)this.fail(403,'An active VIP membership with backups is required.');
    const bot=this.s.deployment(userId,deploymentId);
    if(!bot)this.fail(404,'Bot not found.');
    return this.s.tx(()=>{
      const list=this.s.all('SELECT id FROM vip_backups WHERE user_id=? ORDER BY created,id',userId);
      while(list.length>=m.benefits.backups)this.s.run('DELETE FROM vip_backups WHERE id=?',list.shift().id);
      const values=this.s.settingsView(bot.id).values,id=randomUUID();
      this.s.run('INSERT INTO vip_backups VALUES (?,?,?,?,?)',id,userId,bot.id,JSON.stringify(values),this.s.clock());
      return {id};
    });
  }
  backups(userId){
    this.s.requireActive(userId);
    return this.s.all('SELECT id,deployment_id AS deploymentId,created FROM vip_backups WHERE user_id=? ORDER BY created DESC LIMIT 30',userId);
  }
  restore(userId,backupId){
    this.s.requireActive(userId);
    const m=this.membership(userId);
    if(!m||!m.benefits.backups)this.fail(403,'An active VIP membership is required.');
    const row=this.s.get('SELECT * FROM vip_backups WHERE id=? AND user_id=?',backupId,userId);
    if(!row||!this.s.deployment(userId,row.deployment_id))this.fail(404,'Backup or bot not found.');
    this.s.saveSettings(userId,row.deployment_id,JSON.parse(row.contents));
    return {ok:true};
  }
  analytics(userId,botId){
    this.s.requireActive(userId);
    const m=this.membership(userId);
    if(!m)this.fail(403,'VIP membership required for detailed analytics.');
    if(!this.s.deployment(userId,botId))this.fail(404,'Bot not found.');
    const since=this.s.clock()-m.benefits.analyticsDays*DAY;
    const events=this.s.all('SELECT title,created FROM portal_events WHERE user_id=? AND deployment_id=? AND created>=? ORDER BY created DESC LIMIT 200',userId,botId,since);
    return {days:m.benefits.analyticsDays,events,connections:events.filter(e=>e.title==='Bot connected').length,
      interruptions:events.filter(e=>e.title==='Connection interrupted'||e.title==='WhatsApp connection failed').length};
  }
  members(actor){
    const account=this.s.requireActive(actor);
    if(!this.s.v3.role(account).permissions.some(p=>['vip.view','vip.plans','vip.grant'].includes(p)))
      this.fail(403,'VIP administration access required.');
    return this.s.all(`SELECT m.user_id AS id,u.email,u.name,m.tier,m.expiry,m.auto_renew AS autoRenew
      FROM vip_memberships m JOIN users u ON u.id=m.user_id WHERE m.expiry>? ORDER BY m.expiry DESC LIMIT 200`,this.s.clock());
  }
  grant(actor,{userId,tier,days}){
    return this.s.tx(()=>{
      this.s.v3.permit(actor,'vip.grant');
      if(!tiers.includes(tier)||!Number.isInteger(days)||days<1||days>365)this.fail(400,'Choose tier and 1–365 days.');
      const user=this.s.requireActive(userId),plan=this.config(tier);
      if(!plan)this.fail(404,'VIP tier unavailable.');
      const now=this.s.clock(),current=this.membership(userId);
      const expires=Math.max(now,current?.expiry||now)+days*DAY;
      this.s.run(`INSERT INTO vip_memberships(user_id,tier,expiry,started,auto_renew,duration,snapshot,branding)
        VALUES (?,?,?,?,0,'monthly',?,?) ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier,expiry=excluded.expiry,
        snapshot=excluded.snapshot,auto_renew=0`,
        user.id,tier,expires,now,JSON.stringify(this.snapshot(plan)),current?.branding||'');
      this.s.v3.audit(actor,'vip.grant',user.id,tier+' for '+days+' days');
      this.s.event(user.id,null,'VIP granted','Your '+tier+' membership is active.');
      return {ok:true};
    });
  }
  revoke(actor,userId){
    return this.s.tx(()=>{
      this.s.v3.permit(actor,'vip.grant');
      const m=this.s.get('SELECT 1 FROM vip_memberships WHERE user_id=?',userId);
      if(!m)this.fail(404,'Membership not found.');
      this.s.run('UPDATE vip_memberships SET expiry=?,auto_renew=0 WHERE user_id=?',this.s.clock(),userId);
      this.s.v3.audit(actor,'vip.revoke',userId,'VIP membership revoked');
      return {ok:true};
    });
  }
}
module.exports={Vip};
