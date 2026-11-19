'use strict';
let vipVersion=0;
const vipLabel=tier=>(tier||'standard').replace(/^./,c=>c.toUpperCase());
const vipStamp=timestamp=>timestamp?new Date(timestamp).toLocaleString():'—';
function vipBadge(tier){
  const image=element('img');
  image.src='/vip-'+tier+'.svg';
  image.alt=vipLabel(tier)+' VIP';
  image.className='vip-badge';
  return image;
}
function renderVipAccess(user){
  $('staff-vip-panel').hidden=!can('vip.view')&&!can('vip.plans')&&!can('vip.grant');
  $('staff-diagnostic-panel').hidden=!can('diagnostics.view');
  const old=document.querySelector('#profile-heading .vip-badge');
  if(old)old.remove();
  if(user.vip?.tier)$('profile-heading').append(vipBadge(user.vip.tier));
}
async function loadVip(){
  if(!current?.user)return;
  const stamp=++vipVersion;
  const info=await request('/api/vip');
  if(stamp!==vipVersion||!current?.user)return;
  current.user.vip=info;
  const summary=$('vip-account-status');
  summary.replaceChildren();
  summary.append(element('p',info.tier?vipLabel(info.tier)+' VIP · Active until '+vipStamp(info.expires):
    'Standard membership · Upgrade anytime with coins.'));
  if(info.tier)summary.append(vipBadge(info.tier));
  summary.append(element('p','Used bot slots: '+info.activeSlots+' / '+info.slotLimit,'small'));
  $('vip-claim').hidden=!info.tier||info.claimed||!info.benefits?.daily;
  $('vip-auto-renew').hidden=!info.tier;
  $('vip-auto-renew').textContent=info.autoRenew?'Turn off auto renewal':'Enable auto renewal';
  $('vip-extras-panel').hidden=!info.tier;
  $('vip-branding-form').hidden=!info.tier||!['gold','diamond'].includes(info.tier);
  $('vip-branding').value=info.branding||'';
  const host=$('vip-plan-list');host.replaceChildren();
  for(const plan of info.plans){
    const card=element('article',undefined,'panel vip-plan');
    card.append(vipBadge(plan.tier),element('h2',vipLabel(plan.tier)+' VIP'));
    card.append(element('p','Hosting discount '+plan.discount+'% · Daily bonus '+plan.daily+' coins · Extra slots +'+plan.slots,'small'));
    const features=element('p','Priority support · '+plan.analytics_days+' days analytics · '+plan.backups+' backup snapshots · '+plan.bonus_percent+'% coin purchase bonus','small');
    card.append(features);
    const actions=element('div',undefined,'actions');
    for(const duration of ['weekly','monthly']){
      const price=plan[duration];
      const button=element('button',duration==='weekly'?'7 days · '+price+' coins':'30 days · '+price+' coins','button '+(duration==='monthly'?'primary':'subtle'));
      button.type='button';
      if(info.tier===plan.tier){button.disabled=true;button.textContent=vipLabel(plan.tier)+' active';}
      else if(info.tier&&['silver','gold','diamond'].indexOf(plan.tier)<['silver','gold','diamond'].indexOf(info.tier)){
        button.disabled=true;button.textContent='After current VIP expires';
      }
      button.addEventListener('click',()=>action(button,async()=>{
        if(!window.confirm('Purchase '+vipLabel(plan.tier)+' VIP for '+duration+'? Price '+price+' coins. Any unused membership credit is applied at checkout.'))return;
        const result=await request('/api/vip',{action:'buy',tier:plan.tier,duration,autoRenew:false});
        await refresh();await loadVip();
        note(vipLabel(plan.tier)+' activated. Charged '+result.cost+' coins.');
      }));
      actions.append(button);
    }
    card.append(actions);host.append(card);
  }
}
$('vip-claim').addEventListener('click',()=>action($('vip-claim'),async()=>{
  const claim=await request('/api/vip',{action:'claim'});
  await refresh();await loadVip();note(claim.amount+' VIP bonus coins claimed.');
}));
$('vip-auto-renew').addEventListener('click',()=>action($('vip-auto-renew'),async()=>{
  const enabled=!current.user.vip.autoRenew;
  await request('/api/vip',{action:'renewal',enabled});
  await refresh();await loadVip();note(enabled?'VIP auto-renewal enabled.':'VIP auto-renewal disabled.');
}));
$('vip-branding-form').addEventListener('submit',event=>{
  event.preventDefault();action(event.submitter,async()=>{
    await request('/api/vip',{action:'branding',title:$('vip-branding').value});
    await refresh();await loadVip();note('Custom dashboard bot branding saved.');
  });
});
$('vip-view-backups').addEventListener('click',()=>action($('vip-view-backups'),async()=>{
  const host=$('vip-tools-results');host.replaceChildren(element('h3','Settings backups'));
  const {backups}=await request('/api/vip/backups');
  const bots=current.deployments||[];
  if(!bots.length)host.append(element('p','Add a bot first.','muted'));
  for(const bot of bots){
    const btn=element('button','Back up settings for '+maskPhone(bot.phone),'button subtle');
    btn.type='button';
    btn.addEventListener('click',()=>action(btn,async()=>{
      await request('/api/vip',{action:'backup',deploymentId:bot.id});
      note('Settings snapshot saved. Authentication secrets are not included.');
      $('vip-view-backups').click();
    }));
    host.append(btn);
  }
  if(!backups.length)host.append(element('p','No backup snapshots yet.','muted'));
  for(const backup of backups){
    const item=element('div',undefined,'v3-record');
    item.append(element('p','Saved '+vipStamp(backup.created),'small'));
    const button=element('button','Restore settings','button subtle');button.type='button';
    button.addEventListener('click',()=>action(button,async()=>{
      if(!window.confirm('Restore this bot settings snapshot? Current settings will be updated.'))return;
      await request('/api/vip',{action:'restore',backupId:backup.id});
      await refresh();note('Backup restored to bot settings.');
    }));
    item.append(button);host.append(item);
  }
}));
$('vip-view-analytics').addEventListener('click',()=>action($('vip-view-analytics'),async()=>{
  const host=$('vip-tools-results');
  host.replaceChildren(element('h3','Bot connection analytics'));
  if(!current.deployments?.length){host.append(element('p','No deployed bots.','muted'));return;}
  for(const bot of current.deployments){
    const report=await request('/api/vip/analytics?'+new URLSearchParams({botId:bot.id}));
    const item=element('article',undefined,'v3-record');
    item.append(element('h3',maskPhone(bot.phone)),element('p','Past '+report.days+' days · '+report.connections+' connections · '+report.interruptions+' interruptions','small'));
    for(const entry of report.events.slice(0,10))item.append(element('p',entry.title+' · '+vipStamp(entry.created),'small'));
    host.append(item);
  }
}));
$('diagnose-bot').addEventListener('click',()=>action($('diagnose-bot'),async()=>{
  const bot=selectedBotId||current?.deployments?.[0]?.id;
  if(!bot)throw Error('Select a bot first.');
  const report=await request('/api/diagnostics?'+new URLSearchParams({botId:bot}));
  const host=$('diagnostic-report');host.replaceChildren();
  host.append(element('h3',report.issue.title),element('p',report.issue.description,'small'),
    element('p','Reference '+report.reference+' · Worker '+(report.workerAvailable?'connected':'unavailable'),'small'));
  const list=element('ul');
  for(const step of report.issue.steps)list.append(element('li',step));
  host.append(list);
  for(const event of report.events.slice(0,4))host.append(element('p',event.title+' · '+vipStamp(event.created),'small'));
  $('diagnose-support').hidden=false;
}));
$('diagnose-support').addEventListener('click',()=>{const support=$('support-button');if(support)support.click();});
async function loadVipStaff(){
  const host=$('staff-vip');
  host.replaceChildren(element('p','Loading VIP memberships…','small'));
  const {members,plans}=await request('/api/vip/members');
  host.replaceChildren();
  if(can('vip.plans')){
    host.append(element('h3','VIP tiers and configurable benefits'));
    for(const plan of plans){
      const details=element('details',undefined,'v3-record');
      details.append(element('summary',vipLabel(plan.tier)+' · '+plan.weekly+' coins/week · '+plan.monthly+' coins/month'));
      const form=element('form',undefined,'v3-form');
      const fields={};
      for(const [key,label,min,max] of [
        ['weekly','Weekly price',1,200000],['monthly','Monthly price',1,600000],
        ['discount','Hosting discount (%)',0,80],['daily','Daily bonus coins',0,100],
        ['slots','Extra bot slots',0,20],['themes','Premium theme allowance',0,20],
        ['analyticsDays','Analytics history (days)',1,365],['backups','Backups allowed',0,20],
        ['bonusPercent','Coin purchase bonus (%)',0,30],['early','Early feature access level',0,5]]){
        const db={analyticsDays:'analytics_days',bonusPercent:'bonus_percent'}[key]||key;
        const input=v3Input('number',{min,max,step:1,required:true,value:plan[db]});
        fields[key]=input;v3Field(form,label,input);
      }
      const checked=v3Input('checkbox',{checked:!!plan.active});
      const label=element('label','Tier is available to buy','reward-toggle');label.prepend(checked);form.append(label);
      v3Submit(form,'Save '+vipLabel(plan.tier),async()=>{
        const payload=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,Number(input.value)]));
        await request('/api/vip',{action:'configure',tier:plan.tier,...payload,active:checked.checked});
        await loadVipStaff();note('VIP plan updated.');
      });
      details.append(form);host.append(details);
    }
  }
  if(can('vip.grant')){
    host.append(element('h3','Grant or extend VIP'));
    const form=element('form',undefined,'v3-form');
    const id=v3Field(form,'User ID (from Manage User)',v3Input('text',{required:true,maxLength:36,placeholder:'Select Manage on a user first',value:selectedUser?.id||''}));
    const tier=element('select');
    for(const key of ['silver','gold','diamond'])tier.append(new Option(vipLabel(key),key));
    v3Field(form,'VIP tier',tier);
    const days=v3Field(form,'Duration in days',v3Input('number',{min:1,max:365,value:30,required:true}));
    v3Submit(form,'Grant VIP',async()=>{
      await request('/api/vip',{action:'grant',userId:id.value,tier:tier.value,days:Number(days.value)});
      await loadVipStaff();note('VIP granted.');
    });host.append(form);
  }
  host.append(element('h3','Active members'));
  if(!members.length)host.append(element('p','No active VIP members.','muted'));
  for(const member of members){
    const item=element('div',undefined,'v3-record');
    item.append(element('strong',member.name+' · '+vipLabel(member.tier)),
      element('p',member.email+' · User ID '+member.id,'small'),element('p','Expires '+vipStamp(member.expiry),'small'));
    if(can('vip.grant'))item.append(v3Button('Revoke VIP',async()=>{
      if(!window.confirm('Revoke this VIP membership immediately?'))return;
      await request('/api/vip',{action:'revoke',userId:member.id});
      await loadVipStaff();note('VIP revoked.');
    }));
    host.append(item);
  }
}
bindPanel('staff-vip-panel',loadVipStaff);
async function loadPairingStaff(){
  const host=$('staff-diagnostic');host.replaceChildren(element('p','Checking worker health…','small'));
  const report=await request('/api/owner/diagnostics');host.replaceChildren();
  host.append(element('h3',report.workerAvailable?'Pairing worker online':'Pairing worker unavailable'));
  for(const item of report.states)host.append(element('p',item.state+': '+item.count+' bots','small'));
  host.append(element('h3','Recent pairing problems'));
  if(!report.problems.length)host.append(element('p','No unresolved pairing errors.','muted'));
  for(const item of report.problems){
    const entry=element('div',undefined,'v3-record');
    entry.append(element('strong',item.state),element('p','Account '+item.email+' · Ref '+item.id.slice(0,8),'small'));
    host.append(entry);
  }
}
bindPanel('staff-diagnostic-panel',loadPairingStaff);
