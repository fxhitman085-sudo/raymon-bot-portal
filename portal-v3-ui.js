'use strict';

const v3Path=(page,parameters)=>'/api/v3/'+page+(parameters?'?'+new URLSearchParams(parameters):'');
const can=key=>current?.user?.staff?.permissions.includes(key)||false;
const canAdmin=()=>!!(current?.user?.isOwner||current?.user?.staff?.permissions.length);
const canAccounts=()=>current?.user?.staff?.permissions.some(key=>/^(users|coins|deployments)\./.test(key))||false;
const adminActions=[
  ['grant','Add coins','coins.adjust'],['remove','Remove coins','coins.adjust'],
  ['pause','Pause all bots','deployments.manage'],['ban','Ban user','users.moderate'],['unban','Unban user','users.moderate']
];
let previousRole='';
function renderV3Access(user){
  const roleKey=JSON.stringify([user.email,user.staff]);
  if(roleKey!==previousRole){
    selectedUser=null;
    for(const id of ['staff-inbox','staff-recovery','staff-promos','staff-referrals','founder-staff','founder-audit','founder-payments','founder-packages','payment-history','users','selected-bots','selected-history','selected-audit'])
      $(id).replaceChildren();
    for(const id of ['staff-inbox-panel','staff-recovery-panel','staff-promos-panel','staff-referrals-panel','founder-staff-panel','founder-audit-panel','founder-payments-panel','founder-packages-panel'])
      $(id).open=false;
    $('admin-detail').hidden=true;
    previousRole=roleKey;
  }
  $('founder-payments-panel').hidden=$('founder-packages-panel').hidden=!user.isOwner;
  $('view-owner').hidden=!canAdmin();
  $('view-owner').lastChild.textContent=user.isOwner?'Founder Dashboard':'Admin Dashboard';
  $('owner-heading').textContent=user.isOwner?'Founder Dashboard':'Adm Lvl '+user.staff?.level+' Dashboard';
  $('search-form').hidden=$('staff-accounts').hidden=!canAccounts();
  $('staff-coin-heading').hidden=!can('coins.view');
  $('staff-announcements').hidden=!can('announcements.publish');
  $('founder-rewards').hidden=$('founder-staff-panel').hidden=$('founder-audit-panel').hidden=!user.isOwner;
  $('staff-inbox-panel').hidden=!can('tickets.view');
  $('staff-recovery-panel').hidden=!can('passwords.review');
  $('staff-promos-panel').hidden=!can('promos.view');
  $('staff-referrals-panel').hidden=!can('referrals.view');
  $('onboarding-card').hidden=user.onboarding==null||user.onboarding<0;
  $('continue-guide').textContent=user.onboarding>0?'Continue guide':'Start guide';
}
function renderAdminAccountControls(target){
  const founder=current.user.isOwner;
  const allowed=founder||!target.founder&&!target.staff;
  const actions=adminActions.filter(([key,,permission])=>allowed&&can(permission)&&(!target.founder||!['ban','unban'].includes(key)));
  const select=$('action'), prior=select.value;
  select.replaceChildren(...actions.map(([key,label])=>new Option(label,key)));
  if(actions.some(([key])=>key===prior))select.value=prior;
  $('owner-action').hidden=!actions.length||!!target.closed_at;
  $('amount-field').hidden=!['grant','remove'].includes(select.value);
  $('staff-bots').hidden=!can('deployments.view');
  $('staff-coin-history').hidden=!can('coins.view');
  $('founder-account-audit').hidden=!founder;
  const appoint=$('appoint-area');
  if(appoint.dataset.account!==target.id){
    appoint.querySelector('form')?.remove();
    appoint.dataset.account=target.id;
  }
  appoint.hidden=!founder||!!target.founder||!!target.closed_at||!!target.banned;
}
async function openAdminDashboard(){
  switchView('owner');
  if(canAccounts())await ownerList();
}

function v3Button(label,callback,style='subtle'){
  const button=element('button',label,'button '+style);
  button.type='button';
  button.addEventListener('click',()=>action(button,callback));
  return button;
}
function v3Field(form,label,input){
  const wrapper=element('label',undefined,'v3-field');
  wrapper.append(element('span',label),input);
  form.append(wrapper);
  return input;
}
function v3Input(type,options={}){
  return Object.assign(element('input'),{type,...options});
}
function v3Submit(form,label,callback){
  const button=element('button',label,'button primary');button.type='submit';
  form.append(button);
  form.addEventListener('submit',event=>{
    event.preventDefault();
    action(button,callback);
  });
}
function v3Text(container,message){
  container.replaceChildren(element('p',message,'muted'));
}
function bindPanel(panel,load){
  $(panel).addEventListener('toggle',()=>{
    if($(panel).open)load().catch(error=>note(error.message,true));
  });
}

const ticketContainer=staff=>$(staff?'staff-inbox':'ticket-inbox');
const ticketParams=(staff,extra)=>({staff:Number(staff),...extra});
async function showInbox(staff,cursor=null){
  const host=ticketContainer(staff);
  const token=crypto.randomUUID();
  host.dataset.ticketRead=token;
  if(!cursor)v3Text(host,'Loading tickets…');
  const {items,more}=await request(v3Path('tickets',ticketParams(staff,cursor)));
  if(host.dataset.ticketRead!==token)return;
  if(!cursor)host.replaceChildren();
  host.querySelector('.v3-more')?.remove();
  if(!items.length&&!cursor)v3Text(host,'No tickets yet.');
  for(const ticket of items){
    const button=v3Button(ticket.subject,()=>showTicket(staff,ticket.id));
    button.classList.add('v3-inbox-row');
    button.append(element('small',(ticket.closed?'Closed':'Open')+' · '+formatDate(ticket.updated)+(staff?' · '+ticket.requester:'')));
    host.append(button);
  }
  if(more){
    const last=items.at(-1);
    const button=v3Button('Load more tickets',()=>showInbox(staff,{stamp:last.updated,before:last.id}));
    button.classList.add('v3-more');
    host.append(button);
  }
}
async function openTickets(){
  switchView('tickets');
  await showInbox(false);
}
$('view-tickets').addEventListener('click',()=>action($('view-tickets'),openTickets));
$('support-inbox-button').addEventListener('click',()=>action($('support-inbox-button'),async()=>{
  $('support-dialog').close();
  await openTickets();
}));
bindPanel('staff-inbox-panel',()=>showInbox(true));
async function openTicketNotice(row){
  if(!row.read)await request('/api/notifications',{id:row.id,action:'read'});
  $('notifications-dialog').close();
  if(row.staffTicket){
    switchView('owner');
    const panel=$('staff-inbox-panel');
    if(!panel.open){
      // Wait for the inbox load triggered by opening the panel before drawing the conversation.
      const opening=new Promise(resolve=>panel.addEventListener('toggle',resolve,{once:true}));
      panel.open=true;
      await opening;
    }
  }else switchView('tickets');
  await showTicket(!!row.staffTicket,row.ticketId);
  await refresh();
}

async function screenshotValue(input){
  const file=input.files[0];
  if(!file)return undefined;
  if(file.size>3*1024*1024)throw Error('Choose a screenshot under 3 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  let raw='';
  for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(raw);
}
async function ticketChange(staff,payload){
  const {id}=await request(v3Path('tickets',ticketParams(staff)),payload);
  await showTicket(staff,id);
  await refresh();
}
$('ticket-create').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const {id}=await request(v3Path('tickets',ticketParams(false)),{
      action:'create',subject:$('ticket-subject').value,message:$('ticket-message').value,screenshot:await screenshotValue($('ticket-file'))
    });
    event.target.reset();
    $('new-ticket').open=false;
    await showTicket(false,id);
    note('Support ticket opened.');
  });
});
async function showTicket(staff,id){
  const host=ticketContainer(staff);
  const token=crypto.randomUUID();
  host.dataset.ticketRead=token;
  const ticket=await request(v3Path('ticket',ticketParams(staff,{id})));
  if(host.dataset.ticketRead!==token)return;
  const title=element('h2',ticket.subject);title.tabIndex=-1;
  const conversation=element('article',undefined,'panel v3-ticket');
  conversation.append(title,element('p',(ticket.closed?'Closed':'Open')+
    (staff?' · '+ticket.requester:'')+(ticket.assigneeName?' · Assigned to '+ticket.assigneeName:''),'small'));
  for(const item of ticket.messages){
    const message=element('article',undefined,'v3-message');
    message.append(element('strong',item.author),element('time',formatDate(item.created),'small'),element('p',item.message));
    if(item.screenshot){
      const attachment=v3Path('ticket',ticketParams(staff,{id,attachment:item.id}));
      const link=element('a',undefined,'v3-attachment');
      Object.assign(link,{href:attachment,target:'_blank',rel:'noopener',ariaLabel:'Open screenshot'});
      const photo=element('img');Object.assign(photo,{src:attachment,alt:'Attached screenshot',loading:'lazy'});
      link.append(photo);
      message.append(link);
    }
    conversation.append(message);
  }
  if(!ticket.closed&&(!staff||can('tickets.reply'))){
    const form=element('form');
    const text=v3Field(form,'Reply',Object.assign(element('textarea'),{required:true,maxLength:4000,rows:3}));
    const screenshot=v3Field(form,'Screenshot (optional, up to 3 MB)',v3Input('file',{accept:'image/jpeg,image/png,image/webp'}));
    v3Submit(form,'Send reply',async()=>ticketChange(staff,{action:'reply',ticketId:id,message:text.value,screenshot:await screenshotValue(screenshot)}));
    conversation.append(form);
  }
  if(staff&&!ticket.closed&&can('tickets.assign')){
    const form=element('form'),select=element('select');
    select.append(new Option('Unassigned',''),...ticket.assignees.map(person=>new Option(person.name,person.id)));
    select.value=ticket.assignee||'';
    v3Field(form,'Assign to',select);
    v3Submit(form,'Save assignment',()=>ticketChange(true,{action:'assign',ticketId:id,assignee:select.value||null}));
    conversation.append(form);
  }
  if(staff&&!ticket.closed&&can('tickets.close')){
    conversation.append(v3Button('Close ticket',async()=>{
      if(window.confirm('Close this support ticket?'))await ticketChange(true,{action:'close',ticketId:id});
    },'danger'));
  }
  host.replaceChildren(v3Button('Back to inbox',()=>showInbox(staff)),conversation);
  title.focus();
}

$('redeem-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const result=await request(v3Path('redeem'),{code:$('redeem-code').value});
    event.target.reset();
    await refresh();
    note(numberFormat.format(result.amount)+' coins added to your balance.');
  });
});

function lagosInput(stamp){
  return new Date(stamp+3_600_000).toISOString().slice(0,16);
}
function lagosDate(stamp){
  return new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium'}).format(stamp);
}
function lagosDateTime(stamp){
  return new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium',timeStyle:'short'}).format(stamp);
}
function promoForm(code=null){
  const form=element('form',undefined,'v3-form');
  const label=code?null:v3Field(form,'Code',
    v3Input('text',{required:true,minLength:4,maxLength:32,pattern:'[A-Za-z0-9][A-Za-z0-9_\\-]{3,31}',autocomplete:'off'}));
  const amount=v3Field(form,'Coin reward',v3Input('number',{required:true,min:1,max:100000,value:code?.amount||''}));
  const expires=v3Field(form,'Expiry (Nigeria time)',v3Input('datetime-local',{required:true,value:code?lagosInput(code.expires):''}));
  const maxClaims=v3Field(form,'Redemption limit',v3Input('number',{required:true,min:1,max:1000000,value:code?.maxClaims||''}));
  const active=v3Input('checkbox',{checked:code?!!code.active:true});
  const toggle=element('label','Active','reward-toggle');toggle.prepend(active);form.append(toggle);
  v3Submit(form,code?'Save code':'Create code',async()=>{
    await request(v3Path('promos'),{promoId:code?.id,code:label?.value,amount:Number(amount.value),
      expires:Date.parse(expires.value+'+01:00'),maxClaims:Number(maxClaims.value),active:active.checked});
    await loadPromos();
    note(code?'Promo code updated.':'Promo code created.');
  });
  return form;
}
async function showPromoHistory(code,host,cursor){
  const data=await request(v3Path('promos',{promo:code.id,...(cursor?{claimBefore:cursor}:{})}));
  if(!cursor)host.replaceChildren();
  host.querySelector('.v3-more')?.remove();
  if(!data.history.length&&!cursor)v3Text(host,'No redemptions yet.');
  for(const entry of data.history.slice(0,100)){
    host.append(element('p',entry.name+' · '+entry.email+' · +'+entry.amount+' coins · '+lagosDateTime(entry.created),'small'));
  }
  if(data.history.length>100){
    const more=v3Button('Load more redemptions',()=>showPromoHistory(code,host,data.history[99].cursor));
    more.classList.add('v3-more');host.append(more);
  }
}
async function loadPromos(before=null){
  const host=$('staff-promos');
  const {codes}=await request(v3Path('promos',before?{before}:null));
  const founder=current.user.isOwner;
  if(!before){
    host.replaceChildren();
    if(founder)host.append(promoForm());
    if(!codes.length)host.append(element('p','No promo codes yet.','muted'));
  }
  host.querySelector(':scope > .v3-more')?.remove();
  for(const code of codes.slice(0,50)){
    const card=element('details',undefined,'v3-record');
    card.append(element('summary',code.code+' · '+(code.expires<=Date.now()?'Expired':code.active?'Active':'Inactive')));
    card.append(element('p',code.amount+' coins · '+code.claims+' / '+code.maxClaims+' redeemed · Expires '+lagosDateTime(code.expires),'small'));
    if(founder){
      card.append(promoForm(code));
      if(code.active||code.expires>Date.now())card.append(v3Button(code.active?'Deactivate':'Activate',async()=>{
        await request(v3Path('promos'),{promoId:code.id,active:!code.active});
        await loadPromos();
      }));
    }
    const history=element('div',undefined,'v3-history');
    card.append(v3Button('View redemptions',()=>showPromoHistory(code,history)),history);
    host.append(card);
  }
  if(codes.length>50){
    const button=v3Button('Load more codes',()=>loadPromos(codes[49].id));
    button.classList.add('v3-more');host.append(button);
  }
}
bindPanel('staff-promos-panel',loadPromos);

const periodNames={daily:'Daily',weekly:'Weekly',monthly:'Monthly',all:'All time'};
let rankRequest=0;
async function loadRanks(){
  const sequence=++rankRequest,period=$('rank-period').value;
  $('rank-previous').disabled=period==='all';
  const previous=period==='all'?0:Number($('rank-previous').value);
  v3Text($('rank-list'),'Loading rankings…');
  const data=await request(v3Path('rankings',{period,previous}));
  if(sequence!==rankRequest)return;
  const end=data.end;
  setValue('rank-range',end?lagosDate(data.start)+' – '+lagosDate(end-1):'All time');
  setValue('rank-prizes',data.prizes.length?'Configured prizes · '+data.prizes.map((amount,index)=>'#'+(index+1)+' '+amount+' coins').join(' · '):'');
  const list=$('rank-list');
  list.replaceChildren();
  if(!data.rows.length)list.append(element('li','No qualified referrals for this period.','muted'));
  for(const row of data.rows){
    const entry=element('li',undefined,'v3-rank');
    entry.append(element('strong','#'+row.rank),element('span',row.name+(row.you?' (you)':'')),element('span',row.referrals+' qualified'));
    list.append(entry);
  }
}
for(const id of ['view-rankings','home-rankings'])$(id).addEventListener('click',()=>action($(id),async()=>{
  switchView('rankings');
  await loadRanks();
}));
for(const id of ['rank-period','rank-previous'])$(id).addEventListener('change',()=>loadRanks().catch(error=>note(error.message,true)));

let referralPeriod='daily',referralPrevious=0;
async function loadReferralAdmin(){
  const host=$('staff-referrals'),period=referralPeriod,previous=referralPrevious;
  const data=await request(v3Path('referrals',{period,previous:period==='all'?0:previous}));
  if(period!==referralPeriod||previous!==referralPrevious)return;
  const controls=element('div',undefined,'v3-fields');
  const select=element('select');
  select.append(...Object.entries(periodNames).map(([key,name])=>new Option(name,key)));
  select.value=period;
  select.addEventListener('change',()=>{
    referralPeriod=select.value;referralPrevious=0;loadReferralAdmin().catch(error=>note(error.message,true));
  });
  v3Field(controls,'Ranking period',select);
  if(period!=='all'){
    const count=v3Input('number',{min:0,max:366,step:1,value:previous});
    count.addEventListener('change',()=>{
      if(!count.reportValidity())return;
      referralPrevious=Number(count.value);loadReferralAdmin().catch(error=>note(error.message,true));
    });
    v3Field(controls,'Periods ago (0 is current)',count);
  }
  host.replaceChildren(controls,element('p',data.end?lagosDate(data.start)+' – '+lagosDate(data.end-1):'All time','small'));
  if(current.user.isOwner){
    const form=element('form',undefined,'v3-form');
    const mode=element('select');
    mode.append(new Option('Off','off'),new Option('Founder approval','manual'));
    if(period!=='all')mode.append(new Option('Award automatically','automatic'));
    mode.value=data.prize?.mode||'off';
    v3Field(form,'Prize mode',mode);
    const prizes=v3Field(form,'Coins by finishing rank (comma-separated)',v3Input('text',{
      value:data.prize?.prizes.join(', ')||'',maxLength:100,placeholder:'100, 50, 25'
    }));
    v3Submit(form,'Save '+periodNames[period].toLowerCase()+' prize settings',async()=>{
      const amounts=prizes.value.trim()?prizes.value.split(',').map(value=>Number(value.trim())):[];
      await request(v3Path('referrals'),{action:'configure',period,mode:mode.value,prizes:amounts});
      await loadReferralAdmin();note('Prize settings saved.');
    });
    host.append(form);
  }
  if(data.preview?.length){
    host.append(element('h3','Review proposed winners'));
    const list=element('ol',undefined,'v3-list');
    for(const row of data.preview)list.append(element('li','#'+row.rank+' '+row.name+' · '+row.amount+' coins'));
    host.append(list,v3Button('Approve and award prizes',async()=>{
      if(!window.confirm('Credit these leaderboard prizes?'))return;
      await request(v3Path('referrals'),{action:'approve',period,previous,expectedStart:data.start,preview:JSON.stringify(data.preview)});
      await loadReferralAdmin();note('Leaderboard prizes processed.');
    },'primary'));
  }else if(data.preview)host.append(element('p','There are no qualified winners to approve.','muted'));
  if(data.award){
    host.append(element('h3','Prize history'));
    host.append(element('p','Processed '+lagosDateTime(data.award.awarded)+' · '+data.award.mode,'small'));
    for(const row of data.award.winners)host.append(element('p','#'+row.rank+' '+row.name+' · '+(row.paid?row.amount+' coins paid':row.reason),'small'));
  }
  host.append(element('h3','Qualified referrals'));
  if(!data.rows.length)host.append(element('p','No entries in this period.','muted'));
  for(const row of data.rows){
    const item=element('div',undefined,'v3-record');
    item.append(element('strong',row.inviteeEmail),element('p','Invited by '+row.inviterEmail+' · '+lagosDate(row.qualified)+(row.excluded?' · Excluded':''),'small'));
    if(can('referrals.review'))item.append(v3Button(row.excluded?'Restore entry':'Exclude entry',async()=>{
      await request(v3Path('referrals'),{action:'review',invitee:row.invitee,excluded:!row.excluded});
      await loadReferralAdmin();
    }));
    host.append(item);
  }
}
bindPanel('staff-referrals-panel',loadReferralAdmin);

async function loadRecoveryApprovals(){
  const host=$('staff-recovery');
  v3Text(host,'Loading recovery requests…');
  const {items}=await request('/api/owner/recovery');
  host.replaceChildren(element('p','Approve only after the requester sends this ID from their linked WhatsApp number. Compare the full phone number; never ask for their password or reset code.','small'));
  if(!items.length)host.append(element('p','No pending recovery requests.','muted'));
  for(const item of items){
    const card=element('div',undefined,'v3-record');
    card.append(element('strong',item.name+' · '+item.email),
      element('p','Request ID: '+item.id+' · '+(item.phoneLinked?'Linked WhatsApp number available':'No verified phone on file'),'small'));
    if(!item.phoneLinked){
      card.append(element('p','Do not approve until the account has been securely verified through a separate recovery procedure.','small'));
    }
    const number=v3Input('tel',{placeholder:'Full WhatsApp number with country code',maxLength:18,autocomplete:'off'});
    const form=element('form',undefined,'v3-form');
    v3Field(form,'Verify linked WhatsApp number',number);
    const controls=element('div',undefined,'actions');
    controls.append(v3Button('Approve request',async()=>{
      if(!window.confirm('Confirm that this person contacted support from the linked WhatsApp number and the ID matches?'))return;
      await request('/api/owner/recovery',{requestId:item.id,action:'approve',phone:number.value.trim()});
      await loadRecoveryApprovals();note('Password reset approved.');
    },'primary'),v3Button('Reject',async()=>{
      if(!window.confirm('Reject this password reset request?'))return;
      await request('/api/owner/recovery',{requestId:item.id,action:'reject'});
      await loadRecoveryApprovals();note('Request rejected.');
    }));
    form.append(controls);card.append(form);host.append(card);
  }
}
bindPanel('staff-recovery-panel',loadRecoveryApprovals);

let editLevel=1;
function levelSelect(value){
  const select=element('select');
  for(let level=1;level<=7;level++)select.append(new Option('Adm Lvl '+level,String(level)));
  select.value=String(value);
  return select;
}
async function staffChange(id,command,level){
  await request(v3Path('staff'),{userId:id,action:command,level});
  await loadStaff();
  if(canAccounts())await ownerList();
  note('Administrator updated.');
}
function appointForm(id,name,level=1){
  const form=element('form');
  const select=v3Field(form,'Administrator level for '+name,levelSelect(level));
  v3Submit(form,'Save administrator level',()=>staffChange(id,'level',Number(select.value)));
  return form;
}
$('appoint-from-user').addEventListener('click',()=>{
  if(!selectedUser)return;
  const target=selectedUser;
  $('appoint-area').querySelector('form')?.remove();
  $('appoint-area').append(appointForm(target.id,target.name,1));
  $('appoint-area').querySelector('select').focus();
});
async function loadStaff(){
  const {levels,permissions,admins,audit}=await request(v3Path('staff'));
  const host=$('founder-staff'),auditHost=$('founder-audit');
  const form=element('form',undefined,'v3-form');
  const select=v3Field(form,'Level to configure',levelSelect(editLevel));
  const options=element('fieldset',undefined,'v3-permissions');
  options.append(element('legend','Permissions for this level'));
  const description=element('p','Each level has its own permissions. Ticket replies, assignment, and closing also require inbox access.','small');
  const checkboxes={};
  for(const [key,label] of Object.entries(permissions)){
    const box=v3Input('checkbox');
    const wrapper=element('label',label,'reward-toggle');wrapper.prepend(box);options.append(wrapper);checkboxes[key]=box;
  }
  function selectLevel(){
    editLevel=Number(select.value);
    const assigned=new Set(levels.filter(row=>row.level===editLevel).map(row=>row.permission));
    for(const [key,box] of Object.entries(checkboxes))box.checked=assigned.has(key);
  }
  select.addEventListener('change',selectLevel);selectLevel();
  form.append(description,options);
  v3Submit(form,'Save level permissions',async()=>{
    await request(v3Path('permissions'),{level:Number(select.value),permissions:Object.keys(checkboxes).filter(key=>checkboxes[key].checked)});
    await loadStaff();note('Level permissions saved.');
  });
  host.replaceChildren(form,element('h3','Appointed administrators'),element('p','To appoint someone, find their account above and choose Manage.','small'));
  if(!admins.length)host.append(element('p','No administrators appointed.','muted'));
  for(const admin of admins){
    const card=element('details',undefined,'v3-record');
    card.append(element('summary',admin.name+' · Adm Lvl '+admin.level+(admin.suspended?' · Suspended':'')));
    card.append(element('p',admin.email,'small'));
    if(!admin.closed&&!admin.banned)card.append(appointForm(admin.id,admin.name,admin.level));
    const actions=element('div',undefined,'actions');
    if(!admin.suspended||!admin.closed&&!admin.banned)
      actions.append(v3Button(admin.suspended?'Restore administrator':'Suspend administrator',()=>staffChange(admin.id,admin.suspended?'restore':'suspend')));
    actions.append(v3Button('Remove administrator',async()=>{
      if(window.confirm('Remove administrator access for '+admin.name+'?'))await staffChange(admin.id,'remove');
    },'danger'));
    card.append(actions);host.append(card);
  }
  auditHost.replaceChildren();
  if(!audit.length)v3Text(auditHost,'No admin activity recorded.');
  for(const row of audit){
    const entry=element('article',undefined,'v3-record');
    entry.append(element('strong',row.action.replaceAll('.',' · ')),element('p',row.summary,'v3-copy'),
      element('p',row.actor+' · '+row.actorEmail+' · '+lagosDateTime(row.created),'small'),
      element('p','Target '+row.target,'small'));
    auditHost.append(entry);
  }
}
bindPanel('founder-staff-panel',loadStaff);
bindPanel('founder-audit-panel',loadStaff);

const guide=[
  ['Create your account','Use your email address and password to register. Your portal account manages your balances and deployed bots.'],
  ['Your welcome coins','New accounts start with 10 coins. Each running bot costs 10 coins for 24 hours. Check your balance and daily bonus from the dashboard.','View my coins','wallet'],
  ['Link WhatsApp','Choose Deploy Bot and enter your WhatsApp number. When the portal shows a pairing code, open WhatsApp → Linked devices → Link a device → Link with phone number and enter that code.','Go to deployment','deploy'],
  ['Check your deployment','Once WhatsApp connects, your bot appears in My Bots. From there you can view its status, adjust settings, pause it, or reconnect it.','View my bots','bots'],
  ['Use your dashboard','Check your bot status and renewal, claim your daily bonus, copy your referral link, or open a support ticket from the menu.','View dashboard','home']
];
let guideStep=0;
function drawGuide(){
  const [title,copy,jump]=guide[guideStep];
  setValue('guide-progress','Step '+(guideStep+1)+' of '+guide.length);
  setValue('guide-title',title);
  setValue('guide-copy',copy);
  setValue('guide-jump',jump||'');
  $('guide-jump').hidden=!jump;
  $('guide-back').hidden=!guideStep;
  setValue('guide-next',guideStep===guide.length-1?'Finish':'Next');
}
async function saveGuide(step){
  await request(v3Path('onboarding'),{step});
  current.user.onboarding=step;
  renderV3Access(current.user);
}
$('continue-guide').addEventListener('click',()=>{
  guideStep=Math.max(0,current.user.onboarding);
  drawGuide();
  openDialog('guide-dialog');
});
$('restart-guide').addEventListener('click',()=>action($('restart-guide'),async()=>{
  await saveGuide(0);
  guideStep=0;drawGuide();openDialog('guide-dialog');
}));
for(const id of ['skip-guide','guide-skip'])$(id).addEventListener('click',()=>action($(id),async()=>{
  await saveGuide(-1);
  $('guide-dialog').close();
}));
for(const [id,delta] of [['guide-back',-1],['guide-next',1]])$(id).addEventListener('click',()=>action($(id),async()=>{
  const step=guideStep+delta;
  await saveGuide(step===guide.length?-1:step);
  if(step===guide.length){$('guide-dialog').close();return;}
  guideStep=step;drawGuide();
}));
$('guide-jump').addEventListener('click',()=>{
  $('guide-dialog').close();
  const view=guide[guideStep][3];
  if(view==='bots')showBots();
  else if(view==='deploy')beginDeployment();
  else switchView(view);
});

let pendingPayment=null,paymentAccount='',availablePackages=[];
let packageLoad=0,packagesLoading=false;
const paymentLoads={mine:0,review:0};
function paymentListRow(payment,review){
  const card=element('article',undefined,'v3-record payment-record');
  card.append(element('h3',payment.coins+' coins · ₦'+numberFormat.format(payment.naira)));
  const state=element('span',payment.status[0].toUpperCase()+payment.status.slice(1),'payment-status');
  state.dataset.status=payment.status;
  card.append(state,element('p',payment.reference,'small'),element('time',formatDate(payment.created),'small'));
  if(review)card.append(element('p',payment.name+' · '+payment.email,'small'));
  if(payment.reason)card.append(element('p',payment.reason,'v3-copy'));
  if(payment.reviewed)card.append(element('p','Reviewed '+formatDate(payment.reviewed),'small'));
  const attachment=element('a','View payment screenshot','button subtle');
  Object.assign(attachment,{
    href:v3Path('payments',{attachment:payment.id,...(review?{review:1}:{})}),
    target:'_blank',rel:'noopener noreferrer'
  });
  card.append(attachment);
  if(review&&payment.status==='pending'){
    const form=element('form');
    const decision=element('select');
    decision.append(new Option('Approve payment','approved'),new Option('Reject payment','rejected'));
    v3Field(form,'Decision',decision);
    const reason=v3Field(form,'Review note (required when rejecting)',Object.assign(element('textarea'),{maxLength:500,rows:2}));
    decision.addEventListener('change',()=>{reason.required=decision.value==='rejected';});
    const hint=element('p','Check that the transfer reached your OPay account before approving.','small');
    form.append(hint);
    v3Submit(form,'Confirm review',async()=>{
      if(!window.confirm(decision.value==='approved'?
        'Confirm you received ₦'+numberFormat.format(payment.naira)+' and credit '+payment.coins+' coins?':
        'Reject this payment request?'))return;
      await request(v3Path('payments'),{action:'review',paymentId:payment.id,decision:decision.value,reason:reason.value});
      await loadPayments(true);
      await refresh();
      note('Payment '+decision.value+'.');
    });
    card.append(form);
  }
  return card;
}
async function loadPayments(review=false,before=null){
  const host=$(review?'founder-payments':'payment-history');
  const scope=review?'review':'mine';
  const version=++paymentLoads[scope],account=current?.user?.email;
  if(!account)return;
  if(!before)v3Text(host,'Loading payments…');
  try{
    const data=await request(v3Path('payments',{...(review?{review:1}:{}),...(before?{before}:{})}));
    if(version!==paymentLoads[scope]||current?.user?.email!==account)return;
    if(!before){
      host.replaceChildren();
      if(review)host.append(v3Button('Refresh payments',()=>loadPayments(true)));
    }
    host.querySelector(':scope > .v3-more')?.remove();
    if(!data.items.length&&!before)host.append(element('p',review?'No payment requests yet.':'Your payment requests will appear here.','muted'));
    for(const payment of data.items)host.append(paymentListRow(payment,review));
    if(data.more){
      const button=v3Button('Load more payments',()=>loadPayments(review,data.items.at(-1).id));
      button.classList.add('v3-more');
      host.append(button);
    }
  }catch(error){
    if(version===paymentLoads[scope]&&!before)v3Text(host,error.message);
    throw error;
  }
}
for(const id of ['view-buy','wallet-buy'])$(id).addEventListener('click',()=>action($(id),async()=>{
  if(paymentAccount!==current?.user?.email){
    pendingPayment=null;
    $('payment-form').reset();
    paymentAccount=current?.user?.email||'';
    availablePackages=[];
    showPaymentTotal();
  }
  await Promise.all([loadCoinPackages(),loadPayments()]);
}));
$('refresh-payments').addEventListener('click',()=>action($('refresh-payments'),()=>loadPayments()));
bindPanel('founder-payments-panel',()=>loadPayments(true));
function selectedCoinPackage(){
  const selected=$('payment-form').querySelector('input[name="coin-package"]:checked')?.value;
  return availablePackages.find(item=>item.id===selected);
}
function showPaymentTotal(){
  const selected=selectedCoinPackage();
  $('submit-payment').disabled=packagesLoading||!selected;
  if(packagesLoading)return;
  setValue('payment-total',selected?
    'Transfer ₦'+numberFormat.format(selected.naira)+' for '+numberFormat.format(selected.coins)+' coins.':
    'No coin packages are currently available. Contact support.');
}
async function loadCoinPackages(){
  const version=++packageLoad,account=current?.user?.email;
  const selected=selectedCoinPackage();
  packagesLoading=true;
  $('submit-payment').disabled=true;
  $('payment-packages').disabled=true;
  setValue('payment-total','Loading coin packages…');
  try{
    const {packages}=await request(v3Path('packages'));
    if(version!==packageLoad||current?.user?.email!==account)return;
    availablePackages=packages;
    pendingPayment=null;
    const fieldset=$('payment-packages');
    fieldset.replaceChildren(element('legend','Choose a coin package'));
    const keep=packages.some(item=>item.id===selected?.id)?selected.id:packages[0]?.id;
    for(const item of packages){
      const label=element('label'),input=v3Input('radio',{name:'coin-package',value:item.id,required:true,checked:item.id===keep,defaultChecked:item.id===keep});
      const text=element('span');
      text.append(element('strong',numberFormat.format(item.coins)+' coins'),element('small','₦'+numberFormat.format(item.naira)));
      label.append(input,text);fieldset.append(label);
    }
    fieldset.disabled=!packages.length;
    packagesLoading=false;
    showPaymentTotal();
  }catch(error){
    if(version===packageLoad){
      availablePackages=[];
      packagesLoading=false;
      setValue('payment-total','Could not load packages. Press Refresh packages to try again.');
    }
    throw error;
  }
}
$('refresh-packages').addEventListener('click',()=>action($('refresh-packages'),loadCoinPackages));
$('payment-form').addEventListener('change',()=>{
  pendingPayment=null;
  showPaymentTotal();
});
$('copy-payment-account').addEventListener('click',()=>action($('copy-payment-account'),async()=>{
  await navigator.clipboard.writeText('8059692394');
  note('Account number copied.');
}));
$('payment-form').addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.currentTarget;
  action(event.submitter,async()=>{
    const account=current?.user?.email;
    const selected=selectedCoinPackage();
    if(!selected)throw Error('Choose an available coin package.');
    const screenshot=await screenshotValue($('payment-screenshot'));
    if(!screenshot)throw Error('Upload a payment screenshot.');
    const payload={
      action:'submit',packageId:selected.id,packageRevision:selected.revision,
      reference:$('payment-reference').value.trim(),screenshot
    };
    if(!pendingPayment||pendingPayment.account!==account||
      pendingPayment.packageId!==payload.packageId||pendingPayment.packageRevision!==payload.packageRevision||
      pendingPayment.reference!==payload.reference||
      pendingPayment.screenshot!==payload.screenshot)
      pendingPayment={...payload,account,requestId:crypto.randomUUID()};
    const result=await request(v3Path('payments'),pendingPayment);
    pendingPayment=null;
    form.reset();
    showPaymentTotal();
    await loadPayments();
    note(result.status==='pending'?'Payment evidence submitted. Awaiting review.':'This payment has already been reviewed.');
  });
});

function coinPackageForm(item=null){
  const form=element('form',undefined,'v3-form');
  const packageId=item?.id||crypto.randomUUID();
  const coins=v3Field(form,'Coins',v3Input('number',{
    min:1,max:1000000,step:1,required:true,value:item?.coins??''
  }));
  const naira=v3Field(form,'Price (₦)',v3Input('number',{
    min:1,max:100000000,step:1,required:true,value:item?.naira??''
  }));
  const active=v3Input('checkbox',{checked:item?item.active:true});
  const toggle=element('label','Available to buy','reward-toggle');
  toggle.prepend(active);form.append(toggle);
  v3Submit(form,item?'Save package':'Add package',async()=>{
    await request(v3Path('packages'),{
      packageId,expectedRevision:item?.revision??null,coins:Number(coins.value),naira:Number(naira.value),active:active.checked
    });
    await loadFounderPackages();
    note(item?'Coin package updated.':'Coin package added.');
  });
  return form;
}
let founderPackageLoad=0;
async function loadFounderPackages(){
  const version=++founderPackageLoad,account=current?.user?.email;
  const host=$('founder-packages');
  v3Text(host,'Loading coin packages…');
  const {packages}=await request(v3Path('packages',{manage:1}));
  if(version!==founderPackageLoad||!current?.user?.isOwner||current?.user?.email!==account)return;
  host.replaceChildren(element('h3','Add a package'),coinPackageForm(),element('h3','Your packages'),
    v3Button('Refresh package list',loadFounderPackages));
  if(!packages.length)host.append(element('p','No packages configured yet.','muted'));
  for(const item of packages){
    const card=element('details',undefined,'v3-record');
    card.append(element('summary',numberFormat.format(item.coins)+' coins · ₦'+numberFormat.format(item.naira)+' · '+(item.active?'Active':'Inactive')),
      coinPackageForm(item));
    host.append(card);
  }
}
bindPanel('founder-packages-panel',loadFounderPackages);
