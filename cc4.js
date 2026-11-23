'use strict';
/* Control Center 4.0: reorganize existing live controls rather than cloning them. */
const cc4Pages=[
  ['overview','Overview','layout-dashboard','Overview & system health','Platform performance and urgent operational status'],
  ['users','Manage Users','users','User Management','Search accounts, balances and moderation'],
  ['bots','Manage Bots','bot','Bot Operations','Connection health and pairing diagnostics'],
  ['finance','Finance','wallet','Financial Center','Payments, packages and approved revenue'],
  ['vip','VIP','crown','VIP Management','Memberships and plan administration'],
  ['support','Support','headset','Support Center','Customer requests and priority tickets'],
  ['staff','Staff','shield-check','Staff Directory','Appointments and staff management'],
  ['roles','Roles','sliders-horizontal','Role Permissions','Configure access for Adm Lvl 1–7'],
  ['marketing','Marketing','megaphone','Marketing Center','Rewards, referrals and announcements'],
  ['recovery','Recovery','key-round','Account Recovery','Verified password reset approvals'],
  ['audit','Audit','scroll-text','Audit & Security','Administration records and accountability']
];
let cc4Page='overview',cc4Ready=false,cc4Seq=0;
function cc4Build(){
  if(cc4Ready)return;
  const area=$('owner-view');
  const shell=element('div',undefined,'cc4-shell');
  shell.id='cc4-shell';
  const sidebar=element('aside',undefined,'cc4-sidebar');
  sidebar.setAttribute('aria-label','Control Center navigation');
  const identity=element('div',undefined,'cc4-brand');
  identity.append(element('span','R','cc4-brand-mark'));
  const identityText=element('div');
  identityText.append(element('strong','RAYMON CONTROL'),element('small','CONTROL CENTER 4.0'));
  identity.append(identityText);sidebar.append(identity);
  const nav=element('nav',undefined,'cc4-nav');
  for(const [key,label,icon] of cc4Pages){
    const button=element('button',undefined,'cc4-link');
    button.id='cc4-tab-'+key;
    button.type='button';button.dataset.cc4Tab=key;
    button.setAttribute('aria-controls','cc4-pane-'+key);
    const glyph=element('span',undefined,'cc4-glyph');
    glyph.textContent=({overview:'▦',users:'♙',bots:'◈',finance:'▣',vip:'♛',support:'☏',staff:'♜',roles:'⚙',marketing:'✦',recovery:'♢',audit:'≡'})[key]||'•';
    const title=element('span',label);
    button.append(glyph,title);
    button.addEventListener('click',()=>cc4Show(key));
    nav.append(button);
  }
  sidebar.append(nav);
  const workspace=element('div',undefined,'cc4-workspace');
  const top=element('div',undefined,'cc4-topbar');
  const topText=element('div');
  const eyebrow=element('p','PLATFORM MANAGEMENT','cc4-eyebrow');
  const heading=element('h2','Overview');heading.id='cc4-section-title';
  const subtitle=element('p','','cc4-subtitle');subtitle.id='cc4-section-subtitle';
  topText.append(eyebrow,heading,subtitle);
  const status=element('div','● Secure administration','cc4-system-status');
  top.append(topText,status);
  workspace.append(top);
  for(const [key] of cc4Pages){
    const pane=element('section',undefined,'cc4-pane');
    pane.id='cc4-pane-'+key;
    pane.setAttribute('aria-labelledby','cc4-section-title');
    pane.hidden=true;
    workspace.append(pane);
  }
  shell.append(sidebar,workspace);
  area.querySelector('.owner-head').insertAdjacentElement('afterend',shell);
  const move=(id,page)=>{
    const item=$(id);
    if(!item)return;
    $('cc4-pane-'+page).append(item);
  };
  for(const id of ['platform-stats'])move(id,'overview');
  for(const id of ['search-form','staff-accounts','admin-detail'])move(id,'users');
  for(const id of ['staff-diagnostic-panel'])move(id,'bots');
  for(const id of ['founder-packages-panel','founder-payments-panel'])move(id,'finance');
  move('staff-vip-panel','vip');
  move('staff-inbox-panel','support');
  move('founder-staff-panel','staff');
  for(const id of ['founder-rewards','staff-promos-panel','staff-referrals-panel','staff-announcements'])move(id,'marketing');
  move('staff-recovery-panel','recovery');
  move('founder-audit-panel','audit');
  const stat=$('platform-stats');
  stat.classList.add('cc4-legacy-stat');
  const metricHost=element('div',undefined,'cc4-metrics');
  metricHost.id='cc4-metrics';
  stat.insertAdjacentElement('beforebegin',metricHost);
  const activity=element('div',undefined,'cc4-overview-bottom');
  activity.append(element('article','Platform health information refreshes when you open the overview.','cc4-information'));
  $('cc4-pane-overview').append(activity);
  const back=element('button','Back to users','button subtle');
  back.type='button';
  back.addEventListener('click',()=>{
    selectedUser=null;
    $('admin-detail').hidden=true;
    $('search').focus();
  });
  $('admin-detail').prepend(back);
  const menu=element('button','Owner menu','button subtle cc4-menu-toggle');
  menu.type='button';
  nav.id='cc4-navigation';
  menu.setAttribute('aria-controls',nav.id);
  menu.setAttribute('aria-expanded','false');
  menu.addEventListener('click',()=>{
    menu.setAttribute('aria-expanded',String(menu.getAttribute('aria-expanded')!=='true'));
  });
  sidebar.insertBefore(menu,nav);
  nav.addEventListener('click',event=>{
    if(event.target.closest('button'))menu.setAttribute('aria-expanded','false');
  });
  cc4Ready=true;
  cc4Show('overview');
}
async function showProfileVip(panel,target){
  panel.replaceChildren(element('p','Loading membership…','muted'));
  try{
    const {tier}=await request('/api/vip/profile?user='+encodeURIComponent(target.id));
    if(!panel.isConnected)return;
    const form=element('form',undefined,'v3-form');
    form.append(element('p','Current membership · '+(tier?vipLabel(tier)+' VIP':'Standard')));
    const choice=element('select');
    for(const key of ['silver','gold','diamond'])choice.append(new Option(vipLabel(key),key));
    if(tier)choice.value=tier;
    v3Field(form,'VIP tier',choice);
    const duration=vipGrantDuration(form);
    const save=async payload=>{
      await request('/api/vip',{...payload,userId:target.id});
      if(panel.isConnected)await showProfileVip(panel,target);
      note('Membership updated for '+target.name+'.');
    };
    v3Submit(form,'Save VIP',()=>save({action:'grant',tier:choice.value,...duration()}));
    panel.replaceChildren(form);
    if(tier)panel.append(v3Button('Remove VIP',async()=>{
      if(window.confirm('Remove VIP from '+target.name+' immediately?'))await save({action:'revoke'});
    }));
  }catch(error){panel.replaceChildren(element('p',error.message,'muted'));}
}
function profileMenu(target){
  const detail=$('admin-detail');
  const menu=$('profile-menu');
  $('profile-vip-controls')?.remove();
  const vipPanel=element('section');
  vipPanel.id='profile-vip-controls';
  vipPanel.hidden=true;
  menu.after(vipPanel);
  const select=$('action');
  const coins=value=>['grant','remove'].includes(value);
  const options=Array.from(select.options);
  const sections=[
    ['coins','Coins',!$('owner-action').hidden&&options.some(o=>coins(o.value))],
    ['account','Account',!$('owner-action').hidden&&options.some(o=>!coins(o.value))],
    ['vip','Manage VIP',can('vip.grant')&&!target.closed_at&&!target.banned],
    ['role','Role',!$('appoint-area').hidden],
    ['bots','Bots',!$('staff-bots').hidden],
    ['history','History',!$('staff-coin-history').hidden||!$('founder-account-audit').hidden]
  ].filter(item=>item[2]);
  const activate=key=>{
    detail.dataset.section=key;
    vipPanel.hidden=key!=='vip';
    if(key==='vip')showProfileVip(vipPanel,target);
    for(const button of menu.children)button.setAttribute('aria-pressed',String(button.value===key));
    if(key==='coins'||key==='account'){
      for(const option of options)option.hidden=coins(option.value)!==(key==='coins');
      if(select.selectedOptions[0]?.hidden)select.value=options.find(o=>!o.hidden).value;
      $('amount-field').hidden=!coins(select.value);
    }
  };
  const prior=detail.dataset.account===target.id?detail.dataset.section:null;
  detail.dataset.account=target.id;
  menu.replaceChildren();
  for(const [key,label] of sections){
    const button=element('button',label,'profile-option');
    button.type='button';button.value=key;
    button.addEventListener('click',()=>activate(key));
    menu.append(button);
  }
  activate(sections.some(([key])=>key===prior)?prior:sections[0]?.[0]||'');
}
function cc4Allowed(key,user){
  const permissions=new Set(user?.staff?.permissions||[]);
  if(user?.isOwner)return true;
  if(!user||!permissions.size)return false;
  const any=(...values)=>values.some(v=>permissions.has(v));
  switch(key){
    case 'overview':return true;
    case 'users':return any('users.view','coins.view','deployments.view','users.moderate','coins.adjust');
    case 'bots':return any('diagnostics.view','deployments.view','deployments.manage');
    case 'finance':return false;
    case 'vip':return any('vip.view','vip.plans','vip.grant');
    case 'support':return any('tickets.view');
    case 'staff':return any('staff.manage.lower');
    case 'roles':return false;
    case 'marketing':return any('promos.view','referrals.view','announcements.publish');
    case 'recovery':return any('passwords.review');
    case 'audit':return any('staff.manage.lower');
    default:return false;
  }
}
function cc4Access(user){
  cc4Build();
  for(const [key] of cc4Pages)$('cc4-tab-'+key).hidden=!cc4Allowed(key,user);
  if(!cc4Allowed(cc4Page,user))cc4Page='overview';
  cc4Show(cc4Page,false);
}
function cc4Show(page,fetchData=true){
  const user=current?.user;
  if(user&&!cc4Allowed(page,user))return;
  cc4Page=page;
  const meta=cc4Pages.find(p=>p[0]===page);
  if(!meta)return;
  const staffPanel=$('founder-staff-panel');
  if(staffPanel&&(page==='staff'||page==='roles')){
    const destination=$('cc4-pane-'+page);
    if(staffPanel.parentElement!==destination)destination.append(staffPanel);
    staffPanel.classList.toggle('cc4-role-mode',page==='roles');
    if(!staffPanel.hidden&&!staffPanel.open)staffPanel.open=true;
  }
  for(const [key] of cc4Pages){
    $('cc4-pane-'+key).hidden=key!==page;
    $('cc4-tab-'+key).setAttribute('aria-current',key===page?'page':'false');
  }
  $('cc4-section-title').textContent=meta[3];
  $('cc4-section-subtitle').textContent=meta[4];
  if(fetchData&&page==='overview')cc4LoadOverview().catch(e=>note(e.message,true));
  if(fetchData&&(page==='users'||(page==='marketing'&&current?.user?.isOwner))&&canAccounts())ownerList().catch(e=>note(e.message,true));
  if(fetchData&&(page==='staff'||page==='roles')&&!staffPanel?.hidden)loadStaff().catch(e=>note(e.message,true));
}
async function cc4LoadOverview(){
  if(!current?.user)return;
  const seq=++cc4Seq,metrics=await request('/api/v3/overview');
  if(seq!==cc4Seq||!current?.user)return;
  const host=$('cc4-metrics');
  host.replaceChildren();
  const cards=[
    ['users','Registered Users','users'],
    ['bots','Total Deployed Bots','bot'],
    ['online','Online Bots','radio'],
    ['revenue','Approved Revenue','wallet'],
    ['tickets','Open Support Tickets','headset'],
    ['vip','Active VIP Members','crown'],
    ['staff','Administrators','shield-check'],
    ['coins','Purchased Coins','coins']
  ];
  for(const [key,title,icon] of cards){
    const value=key==='bots'?metrics.bots?.total:key==='online'?metrics.bots?.online:
      key==='revenue'?metrics.revenue:key==='coins'?metrics.coins:metrics[key];
    if(value===undefined)continue;
    const card=element('article',undefined,'cc4-metric');
    const heading=element('p',title,'cc4-metric-label');
    const number=element('strong',(key==='revenue'?'₦':'')+numberFormat.format(value));
    const footer=element('small',key==='revenue'?'Approved payments only':key==='online'?'Recently connected':'Live platform records');
    const mark=element('span',undefined,'cc4-metric-icon');
    mark.textContent=({users:'♙',bot:'◈',radio:'◉',wallet:'▣',headset:'☏',crown:'♛','shield-check':'♜',coins:'◆'})[icon];
    card.append(mark,heading,number,footer);host.append(card);
  }
  const bottom=$('cc4-pane-overview').querySelector('.cc4-information');
  if(bottom)bottom.textContent=metrics.workerAvailable===undefined?
    'Your overview shows only metrics permitted for your role.':
    metrics.workerAvailable?'● Pairing worker connected.':'● Pairing worker is currently not reporting a recent heartbeat.';
}
document.getElementById('view-owner')?.addEventListener('click',()=>{
  cc4Page='overview';
  if(current?.user)cc4Show('overview');
});
cc4Build();
