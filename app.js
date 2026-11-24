'use strict';
const $=id=>document.getElementById(id);
const names={queued:'Requesting code',awaiting_code:'Waiting for pairing',connecting:'Connecting',reconnecting:'Reconnecting',online:'Online',paused:'Paused',
  low_balance:'Out of coins',expired:'Code expired',needs_pairing:'Needs pairing',pair_failed:'Pairing failed',pair_no_code:'No pairing code received',suspended:'Suspended'};
const formatDate=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
let recoveryId=sessionStorage.getItem('raymonRecoveryId');
let current,selectedUser,selectedBotId,addingBot=false,botListView,pendingTransfer,workspaceView='home',manageOpen=false,refreshing=false,registering=false,recovering=!!recoveryId;
let resetToken=null;
if(location.hash.startsWith('#reset='))history.replaceState(null,'',location.pathname+location.search);
const referral=new URLSearchParams(location.search).get('ref');
let authOpen=!!recoveryId,profileUser=null;
const numberFormat=new Intl.NumberFormat();
const note=(message,error=false)=>{
  $('notice').textContent=message;
  $('notice').classList.toggle('error',error);
  $('notice').hidden=!message;
};
async function request(path,data){
  const options=data===undefined?{cache:'no-store'}:data instanceof Blob?{method:'POST',body:data}:
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
  const response=await fetch(path,{...options,signal:AbortSignal.timeout(15000)}).catch(error=>{
    if(error.name==='TimeoutError')throw new Error('The request timed out. Try again.');
    throw new Error('Could not reach the portal. Check your connection.');
  });
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'Request failed. Try again.');
  return value;
}
function element(tag,text,className){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  if(className)node.className=className;
  return node;
}
function fillHistory(list,rows){
  list.replaceChildren();
  if(!rows.length)list.append(element('li','No activity yet.','muted'));
  for(const row of rows){
    const line=element('li'), text=element('span',row.reason);
    text.append(element('time',formatDate(row.created)));
    line.append(text,row.delta!==undefined?element('strong',(row.delta>0?'+':'')+row.delta,row.delta>0?'plus':'minus'):element('strong',row.action));
    list.append(line);
  }
}
const settingsSections=[
  ['General',[['mode','Who can use the bot',['private','public']],['prefix','Command prefix','text',4],
    ['commandReaction','Command reaction emoji (blank turns it off)','text',40]]],
  ['Status',[['statusView','Automatically view statuses','checkbox'],['statusReact','Automatically react to statuses','checkbox'],
    ['statusReactionStyle','Reaction style',['heart','emoji']],['statusEmojiMode','Emoji choice',['random','fixed']],
    ['statusEmoji','Fixed emoji','text',40],['statusEmojis','Custom emoji list','text',840],
    ['statusExclusions','Excluded numbers (with country codes)','textarea',8500]]],
  ['Replies',[['autoReply','AI auto-reply','checkbox'],['awayEnabled','Enable away replies','checkbox'],
    ['awayActive','Away now','checkbox'],['awayAutomatic','Go away after 15 minutes of inactivity','checkbox'],
    ['awayMessage','Away message','textarea',1000]]],
  ['Updates',[['updateAlerts','Automatic update alerts','checkbox']]]
];
const emojiSegments=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function buildSettings(container,variant,values){
  container.replaceChildren();
  const inputs=new Map(),rows=new Map();
  for(const [name,fields] of settingsSections){
    const section=element('details',undefined,'settings-section');
    section.open=name==='General';
    section.append(element('summary',name));
    for(const [key,label,type,limit] of fields){
      if(variant==='setup'&&key==='awayActive')continue;
      const toggle=type==='checkbox',row=element('div',undefined,toggle?'settings-toggle':'');
      const field=element(Array.isArray(type)?'select':type==='textarea'?'textarea':'input');
      const caption=element('label',label);
      field.id=variant+'-'+key;
      caption.htmlFor=field.id;
      if(Array.isArray(type)){
        for(const choice of type){
          const option=element('option',choice[0].toUpperCase()+choice.slice(1));
          option.value=choice;field.append(option);
        }
      }else if(field.tagName==='INPUT')field.type=type;
      else field.rows=3;
      if(limit)field.maxLength=limit;
      if(toggle){field.setAttribute('role','switch');field.checked=values[key];}
      else field.value=Array.isArray(values[key])?values[key].join(key==='statusExclusions'?'\n':' '):values[key];
      row.append(caption,field);section.append(row);
      inputs.set(key,field);rows.set(key,row);
    }
    container.append(section);
  }
  const update=()=>{
    const react=inputs.get('statusReact').checked;
    const custom=react&&inputs.get('statusReactionStyle').value==='emoji';
    const fixed=inputs.get('statusEmojiMode').value==='fixed';
    rows.get('statusReactionStyle').hidden=!react;
    rows.get('statusEmojiMode').hidden=!custom;
    rows.get('statusEmoji').hidden=!custom||!fixed;
    rows.get('statusEmojis').hidden=!custom||fixed;
    if(rows.has('awayActive'))rows.get('awayActive').hidden=!inputs.get('awayEnabled').checked;
  };
  for(const input of inputs.values())input.addEventListener('change',update);
  update();
  return ()=>{
    const patch={};
    for(const [key,input] of inputs){
      if(rows.get(key).hidden)continue;
      let value=input.type==='checkbox'?input.checked:input.value.trim();
      if(key==='statusEmojis')value=[...new Set([...emojiSegments.segment(value)].map(part=>part.segment).filter(item=>item.trim()))];
      if(key==='statusExclusions')value=[...new Set(value.split(/[\s,]+/).filter(Boolean).map(phone=>phone.replace(/^\+/,'')))];
      if(JSON.stringify(value)!==JSON.stringify(values[key]))patch[key]=value;
    }
    return patch;
  };
}

let customize=false,readSetup,readEdit,editorBot,editorSnapshot,editingDirty=false,pairBusy=false;
function resetSetup(){
  customize=false;
  $('number-step').hidden=false;
  $('customize-step').hidden=true;
}
function drawSettings(data,bot){
  const panel=$('bot-settings-panel');
  panel.hidden=data.user.banned||!bot?.linked;
  if(panel.hidden||editorBot!==bot.id){
    panel.open=false;
    editorBot=bot?.id;
    editingDirty=false;
    editorSnapshot=undefined;
    clearGroups();
  }
  if(panel.hidden)return;
  const snapshot=JSON.stringify(bot.settings.values);
  if(!editingDirty&&snapshot!==editorSnapshot){
    editorSnapshot=snapshot;
    readEdit=buildSettings($('edit-settings'),'edit',bot.settings.values);
  }
  const message=bot.settings.pending?'Saved · waiting for the bot to apply changes.':
    !bot.settings.synced?'Waiting for the bot to share its current settings.':'';
  if($('settings-status').textContent!==message)$('settings-status').textContent=message;
}
function draw(data){
  current=data;
  const {user,deployments=[]}=data;
  const d=addingBot?null:(deployments.find(bot=>bot.id===selectedBotId)||deployments[0]||null);
  if(!addingBot)selectedBotId=d?.id;

  $('landing').hidden=!!user&&!resetToken;
  $('landing-hero').hidden=authOpen||!!resetToken;
  $('account').hidden=!authOpen&&!resetToken;
  $('landing-features').hidden=!!user||authOpen;
  $('notifications-button').hidden=!user;
  $('avatar-button').hidden=!user;
  document.body.classList.toggle('signed-in',!!user);
  $('dashboard').hidden=!user||!!resetToken;
  $('sign-out').hidden=!user||!!resetToken;
  $('sign-in-link').hidden=!!user||!!resetToken;
  $('site-footer').hidden=!!user&&!resetToken;
  $('show-recovery').hidden=registering;
  if(!user||resetToken){
    $('guide-dialog').close();
    return;
  }
  $('greeting').textContent=user.name;
  $('account-email').textContent=user.email;
  renderV3Access(user);

  $('password-setup').hidden=!user.needsPassword||user.banned;
  $('balance').textContent=numberFormat.format(user.coins);
  renderOverview(data,deployments);
  renderProfile(user);
  if(typeof renderVipAccess==='function')renderVipAccess(user);
  setUnread(data.unread||0);
  $('dashboard-deploy').hidden=user.banned;
  $('first-deploy').hidden=user.banned;
  $('add-bot').hidden=user.banned;
  const listView=JSON.stringify([deployments.map(({id,phone,state,nextRenewal})=>({id,phone,state,nextRenewal})),user.banned,data.price]);
  if(listView!==botListView){
    botListView=listView;
    const cards=$('bot-list');
    cards.replaceChildren();
    for(const bot of deployments){
      const card=element('article',undefined,'deployment');
      const icon=element('span',undefined,'deployment-icon');
      icon.setAttribute('aria-hidden','true');
      const heading=element('h2',user.vip?.branding||'RAYMON BOT');
      const title=element('div',undefined,'deployment-title');
      const state=user.banned?'suspended':bot.state;
      const status=element('span',names[state]||state,'bot-status');
      status.dataset.state=state;
      title.append(heading,status);
      const info=element('div',undefined,'deployment-info');
            info.append(title,element('p',maskPhone(bot.phone)));
      const detail=bot.nextRenewal?'Renews '+formatDate(bot.nextRenewal):bot.requested?'Requested '+formatDate(bot.requested):'';
      if(detail)info.append(element('p',detail));
      const manage=element('button',user.name,'directory-name');
      manage.type='button';
      manage.setAttribute('aria-label','Manage bot '+maskPhone(bot.phone));
      manage.addEventListener('click',()=>{
        addingBot=false;
        selectedBotId=bot.id;
        $('phone').value='';
        $('country-code').value='';
        resetSetup();
        manageOpen=true;
        draw(current);
        navigateTo('manage-title');
      });
      card.append(icon,info,manage);
      cards.append(card);
    }
    if(!deployments.length){
      const empty=element('div',undefined,'empty-state');
      empty.append(element('h2','No bots yet'),element('p',user.banned?
        'Your account is suspended. Contact the portal owner.':'Add a WhatsApp number to deploy your first bot.'));
      cards.append(empty);
    }
  }
  if(!d&&!addingBot&&workspaceView==='bots')manageOpen=false;
  renderNavigation();
  $('bot-state').textContent=d?(user.banned?'Suspended':(names[d.state]||'Not linked')):'';
  $('bot-state').hidden=!d;
  $('bot-state').dataset.state=user.banned?'suspended':d?.state||'';
  $('manage-title').textContent=workspaceView==='deploy'?'Deploy Your WhatsApp Bot':d?maskPhone(d.phone):'Manage bot';
  $('deploy-description').hidden=workspaceView!=='deploy';
  $('bot-renewal').hidden=!d?.linked;
  $('connection-panel').classList.toggle('pairing',!d?.linked);
  $('paid-until').textContent=d?.nextRenewal?formatDate(d.nextRenewal):'—';
  $('renewal-detail').textContent=d?.state==='paused'&&d.paidUntil>Date.now()
    ?'Paused · paid through '+formatDate(d.paidUntil):data.price+' coins per 24 hours';
  const low=deployments.filter(bot=>bot.lowBalanceAlert);
  const alert=low.length?'Low balance for '+low.length+' upcoming bot renewal(s). Each renewal costs '+data.price+' coins.':'';
  if($('low-balance-alert').textContent!==alert)$('low-balance-alert').textContent=alert;
  $('low-balance-alert').hidden=!alert;
  $('dashboard-low-balance').textContent=alert;
  $('dashboard-low-balance').hidden=!alert;
  $('transfer-panel').hidden=user.banned;
  const pending=!!d?.pairingExpires;
  const canLink=!user.banned&&!d?.linked&&!pending;
  $('pair-form').hidden=!canLink;
  drawSettings(data,d);
  if(canLink&&d?.phone&&!$('phone').value)$('phone').value=d.phone;
  $('pair-code-area').hidden=!d?.code;
  $('pair-code').textContent=d?.code||'';
  $('expires').textContent=d?.pairingExpires?'Expires at '+formatDate(d.pairingExpires):'';
  $('bot-actions').hidden=!d?.linked||user.banned;
  $('bot-access').hidden=!d||user.banned;
  const running=['online','connecting','reconnecting'].includes(d?.state);
  $('pause').hidden=!running;
  $('restart-bot').hidden=!running||!d?.linked;
  $('resume').hidden=running;
  $('resume').disabled=d?.state==='low_balance'&&user.coins<data.price;
  $('connection-title').textContent=d?.linked?'WhatsApp connection':'Link WhatsApp';
  $('connection-info').textContent=user.banned?'Your account is suspended. Contact the portal owner.':
    d?.state==='low_balance'?(user.coins<data.price?'Your paid time ended. Add '+(data.price-user.coins)+' coins or more to resume.':'Your paid time ended. Resume the bot to start a new period.'):
    d?.state==='expired'?'The previous code expired. You can request another one.':
    d?.state==='pair_no_code'?'WhatsApp did not issue a code in time. Check your country code and number, then request a fresh code.':
    ['needs_pairing','pair_failed'].includes(d?.state)?'WhatsApp could not finish linking. Request a fresh code.':
    d?.state==='reconnecting'?'Trying to reconnect your existing WhatsApp session.':
    d?.linked?'Pausing stops bot activity. Your paid period continues until it expires.':
    pending&&!d.code?'Waiting for WhatsApp to generate a pairing code…':
    pending?'Enter the code below in WhatsApp to finish linking.':'Use a WhatsApp account you control.';
  const details=[];
  if(d&&!user.banned&&(pending||running)&&!d.workerAvailable)details.push('Pairing worker is not responding.');
  if(d?.lastSeen&&!user.banned)details.push('Last connected '+formatDate(d.lastSeen)+'.');
  if(pending&&!d.code)details.push('Request expires '+formatDate(d.pairingExpires)+'.');
  $('connection-diagnostics').textContent=details.join(' ');
  $('connection-diagnostics').hidden=!details.length;
  $('bot-diagnostics-panel').hidden=!d?.id;
  $('diagnostic-report').replaceChildren();
  const historyKey=JSON.stringify(data.history);
  if($('history').dataset.rendered!==historyKey){
    fillHistory($('history'),data.history);
    $('history').dataset.rendered=historyKey;
  }
}
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try{draw(await request('/api/me'));}
  finally{refreshing=false;}
}
async function action(button,callback){
  if(button.disabled)return;
  button.disabled=true;
  button.setAttribute('aria-busy','true');
  try{note('');await callback();}
  catch(error){note(error.message,true);}
  finally{button.disabled=false;button.removeAttribute('aria-busy');}
}
function beginDeployment(){
  if(!current?.user||current.user.banned)return;
  addingBot=true;
  manageOpen=true;
  resetSetup();
  $('phone').value='';
  $('country-code').value='+234';
  workspaceView='deploy';
  draw(current);
  closeDrawer();
  navigateTo('manage-title');
}
for(const id of ['add-bot','view-deploy','dashboard-deploy','first-deploy'])$(id).addEventListener('click',beginDeployment);
function normalizedPhone(){
  const phone=$('phone').value.trim().replace(/[ ()-]/g,'');
  const prefix=$('country-code').value.trim();
  if(phone.startsWith('+'))return phone;
  if(!/^\+?[1-9]\d{0,2}$/.test(prefix))return '';
  const country=prefix.replace(/^\+/,'');
  return '+'+country+(country==='234'?phone.replace(/^0/,''):phone);
}
async function requestPair(button,settings){
  if(pairBusy)return;
  pairBusy=true;
  try{
    await action(button,async()=>{
      const phone=normalizedPhone(),add=addingBot||!selectedBotId;
      const target=add?{phone,add:true}:{phone,deploymentId:selectedBotId};
      await request('/api/pair',{...target,...(settings&&{settings})});
      const view=await request('/api/me');
      selectedBotId=view.deployments.find(bot=>bot.phone===phone)?.id;
      addingBot=false;
      resetSetup();
      $('phone').value='';
      draw(view);
    });
  }finally{pairBusy=false;}
}
$('pair-form').addEventListener('submit',event=>{
  event.preventDefault();
  const phone=normalizedPhone();
  if(!/^\+[1-9][0-9]{7,14}$/.test(phone)){
    note('Enter your WhatsApp number with its country code, such as +234.',true);
    $('phone').focus();
    return;
  }
  if(customize){void requestPair(event.submitter,readSetup());return;}
  note('');
  const existing=addingBot?null:current?.deployments.find(bot=>bot.id===selectedBotId);
  readSetup=buildSettings($('setup-settings'),'setup',existing?.settings.values||current.settingsDefaults);
  $('setup-number').textContent=phone;
  $('skip-settings').textContent=existing?'Use current settings':'Use defaults';
  customize=true;
  $('number-step').hidden=true;
  $('customize-step').hidden=false;
  $('setup-mode').focus();
});
$('back-number').addEventListener('click',()=>{resetSetup();$('phone').focus();});
$('skip-settings').addEventListener('click',()=>void requestPair($('skip-settings')));
$('edit-settings-form').addEventListener('input',()=>{editingDirty=true;});
$('edit-settings-form').addEventListener('submit',event=>{
  event.preventDefault();
  const deploymentId=editorBot,settings=readEdit();
  action(event.submitter,async()=>{
    await request('/api/bot-settings',{deploymentId,settings});
    if(editorBot===deploymentId){editingDirty=false;editorSnapshot=undefined;}
    draw(await request('/api/me'));
    note('Bot settings saved.');
  });
});
let groupList=[];
function clearGroups(){
  groupList=[];
  $('group-form').hidden=true;
  $('groups-status').textContent='';
  $('load-groups').closest('details').open=false;
}
async function groupRequest(id,values){
  const {token}=await request('/api/group-settings',{deploymentId:id,...values});
  const query=new URLSearchParams({bot:id,token});
  for(let attempt=0;attempt<15&&editorBot===id;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1250));
    const result=await request('/api/group-settings?'+query);
    if(result.error)throw Error(result.error);
    if(!result.pending)return result;
  }
  if(editorBot===id)throw Error('The bot did not respond in time. Try again.');
  return null;
}
function selectGroup(){
  const group=groupList.find(item=>item.id===$('group-select').value);
  if(!group)return;
  $('group-welcome').checked=group.welcome;
  $('group-goodbye').checked=group.goodbye;
  $('group-rules').value=group.rules;
}
$('group-select').addEventListener('change',selectGroup);
$('load-groups').addEventListener('click',event=>action(event.currentTarget,async()=>{
  const id=editorBot;
  $('groups-status').textContent='Loading groups…';
  $('group-form').hidden=true;
  try{
    const result=await groupRequest(id,{action:'list'});
    if(!result||editorBot!==id)return;
    groupList=result.groups;
    const select=$('group-select');
    select.replaceChildren();
    for(const group of groupList){
      const option=element('option',group.name);
      option.value=group.id;
      select.append(option);
    }
    $('group-form').hidden=!groupList.length;
    $('groups-status').textContent=groupList.length?'':'No groups with admin access were found.';
    selectGroup();
  }catch(error){if(editorBot===id)$('groups-status').textContent=error.message;}
}));
$('group-form').addEventListener('submit',event=>{
  event.preventDefault();
  const id=editorBot,group=$('group-select').value;
  const values={welcome:$('group-welcome').checked,goodbye:$('group-goodbye').checked,rules:$('group-rules').value};
  action(event.submitter,async()=>{
    $('groups-status').textContent='Applying group settings…';
    try{
      const result=await groupRequest(id,{action:'save',group,values});
      if(!result||editorBot!==id)return;
      const item=groupList.find(row=>row.id===group);
      if(item)Object.assign(item,values);
      $('groups-status').textContent='Group settings applied.';
    }catch(error){if(editorBot===id)$('groups-status').textContent=error.message;}
  });
});
for(const command of ['pause','resume','restart','cancel']){
  const button=$(['cancel','restart'].includes(command)?command+'-bot':command);
  button.addEventListener('click',()=>{
    const bot=current?.deployments.find(item=>item.id===selectedBotId);
    if(!bot||command==='cancel'&&!window.confirm('Cancel '+bot.phone+'? This stops the bot and future charges. To use the number again, pair it as a new bot.'))return;
    action(button,async()=>{
      await request('/api/control',{action:command,deploymentId:bot.id});
      draw(await request('/api/me'));
      if(command==='restart')note('Restart requested. Watch the connection status for confirmation.');
      if(command==='cancel'){
        workspaceView='bots';
        manageOpen=false;
        renderNavigation();
        navigateTo('bots-heading');
        note('Bot cancelled.');
      }
    });
  });
}
$('copy-code').addEventListener('click',()=>action($('copy-code'),async()=>{
  const code=current?.deployments.find(bot=>bot.id===selectedBotId)?.code;
  if(addingBot||!code)return;
  if(!navigator.clipboard)throw new Error('Select and copy the code shown on screen.');
  await navigator.clipboard.writeText(code);
  note('Pairing code copied.');
}));
$('sign-out').addEventListener('click',()=>action($('sign-out'),async()=>{await request('/api/logout',{});location.assign('/');}));
$('transfer-form').addEventListener('submit',event=>{
  event.preventDefault();
  pendingTransfer={email:$('transfer-email').value.trim(),amount:Number($('transfer-amount').value),requestId:crypto.randomUUID()};
  $('transfer-description').textContent='Send '+pendingTransfer.amount+' coins to '+pendingTransfer.email+'?';
  $('transfer-form').hidden=true;
  $('transfer-review').hidden=false;
  $('confirm-transfer').focus();
});
function editTransfer(){
  pendingTransfer=null;
  $('transfer-review').hidden=true;
  $('transfer-form').hidden=false;
}
$('edit-transfer').addEventListener('click',()=>{editTransfer();$('transfer-email').focus();});
$('confirm-transfer').addEventListener('click',()=>action($('confirm-transfer'),async()=>{
  $('edit-transfer').disabled=true;
  try{
    await request('/api/transfers',pendingTransfer);
    editTransfer();
    $('transfer-form').reset();
    note('Coins sent.');
    refresh().catch(()=>{});
  }finally{$('edit-transfer').disabled=false;}
}));
let ownerListVersion=0;
async function ownerList(){
  const version=++ownerListVersion;
  const params=new URLSearchParams({search:$('search').value});
  if(selectedUser)params.set('user',selectedUser.id);
  const data=await request('/api/owner?'+params), table=$('users');
  if(version!==ownerListVersion)return;
  if(data.rewards)renderRewardSettings(data.rewards);
  table.replaceChildren();
  const stats=data.stats;
  $('platform-stats').textContent=stats?stats.users+' users · '+stats.deployments+' deployments · '+stats.online+' online · '+stats.charges+' maintenance charges':'';
  for(const user of data.users){
    const row=element('tr'), identity=element('td');

    const button=element('button',user.name,'directory-name');
    button.type='button';
    button.addEventListener('click',()=>action(button,async()=>{
      selectedUser=user;
      $('admin-detail').hidden=true;
      await ownerList();
      if(selectedUser?.id===user.id)$('selected-user').focus();
    }));
    identity.append(button,element('span',user.email,'small'));
    row.append(identity);
    if(can('coins.view'))row.append(element('td',user.coins??''));
    row.append(element('td',user.closed_at?'Closed':user.banned?'Suspended':user.founder?'Founder':user.staff?'Administrator':'Active'));
    table.append(row);
  }
  if(!data.users.length){
    const row=element('tr'),cell=element('td','No matching users.','muted');
    cell.colSpan=4;row.append(cell);table.append(row);
  }
  if(selectedUser){
    selectedUser=data.users.find(user=>user.id===selectedUser.id)||selectedUser;
    const cards=$('selected-bots'),target=selectedUser;
    $('selected-user').textContent=target.name;
    $('profile-summary').textContent=[target.email,target.founder?'Founder':target.staff?'Administrator':'User',target.closed_at?'Closed':target.banned?'Banned':'Active',can('coins.view')?numberFormat.format(target.coins)+' coins':''].filter(Boolean).join(' · ');
    $('admin-detail').hidden=false;
    renderAdminAccountControls(target);
    profileMenu(target);
    cards.replaceChildren();
    for(const bot of data.deployments){
      const card=element('div',undefined,'bot-card');
      const cancel=element('button','Cancel bot','button subtle');
      cancel.type='button';
      cancel.addEventListener('click',()=>{
        if(!window.confirm('Cancel '+bot.phone+' for '+target.name+' and stop future charges?'))return;
        action(cancel,async()=>{
          await request('/api/owner',{userId:target.id,deploymentId:bot.id,action:'cancel',reason:'Cancelled from the owner dashboard.'});
          await ownerList();
          await refresh();
          note('Bot cancelled.');
        });
      });
      card.append(element('strong',bot.phone),element('span',names[bot.state]||bot.state));
      if(can('deployments.manage')&&(current.user.isOwner||!target.founder&&!target.staff))card.append(cancel);
      cards.append(card);
    }
    if(!data.deployments.length)cards.append(element('p','No bots deployed.','muted'));
    fillHistory($('selected-history'),data.history);
    fillHistory($('selected-audit'),data.audit);
  }
}
const workspacePages={
  home:['home-view','view-home','home-heading'],bots:['bot-view','view-bot','bots-heading'],
  deploy:['bot-view','view-deploy','manage-title'],wallet:['wallet-view','view-wallet','wallet-heading'],
  buy:['buy-view','view-buy','buy-heading'],chat:['chat-view','view-chat','chat-heading'],community:['community-view','view-community','community-heading'],
  profile:['profile-view','view-profile','profile-heading'],vip:['vip-view','view-vip','vip-heading'],owner:['owner-view','view-owner','owner-heading'],
  rankings:['rankings-view','view-rankings','rankings-heading'],tickets:['tickets-view','view-tickets','tickets-heading']
};
function renderNavigation(){
  if(!canAdmin()&&workspaceView==='owner')workspaceView='home';
  for(const [view,[panel,nav]] of Object.entries(workspacePages)){
    if(view!=='deploy'&&view!=='bots')$(panel).hidden=view!==workspaceView;
    if(view===workspaceView)$(nav).setAttribute('aria-current','page');
    else $(nav).removeAttribute('aria-current');
  }
  $('view-deploy').hidden=!!current?.user?.banned;
  $('bot-view').hidden=!['bots','deploy'].includes(workspaceView);
  $('deployments-view').hidden=manageOpen||workspaceView==='deploy';
  $('manage-view').hidden=!manageOpen&&workspaceView!=='deploy';
}
function navigateTo(id){
  window.scrollTo(0,0);
  $(id).focus({preventScroll:true});
}
function closeDrawer({restoreFocus=false}={}){
  const wasOpen=document.body.classList.contains('drawer-open');
  document.body.classList.remove('drawer-open');
  $('open-menu').setAttribute('aria-expanded','false');
  $('drawer-overlay').hidden=true;
  $('public-menu').hidden=true;
  if(wasOpen&&restoreFocus)$('open-menu').focus();
}
function switchView(view){
  workspaceView=view;
  if(view==='vip'&&typeof loadVip==='function')loadVip().catch(error=>note(error.message,true));
  closeDrawer();
  renderNavigation();
  navigateTo(workspacePages[view][2]);
}
function showBots(){
  manageOpen=false;
  addingBot=false;
  resetSetup();
  switchView('bots');
}
function openAuth(register){
  authOpen=true;
  recovering=false;
  authMode(register);
  authView();
  closeDrawer();
  draw(current||{});
  $('auth-heading').scrollIntoView({block:'start'});
  $(register?'auth-name':'auth-email').focus({preventScroll:true});
}
$('open-menu').addEventListener('click',()=>{
  const user=current?.user;
  if(document.body.classList.contains('drawer-open')){closeDrawer({restoreFocus:true});return;}
  $('public-menu').hidden=!!user;
  $('drawer-overlay').hidden=false;
  document.body.classList.add('drawer-open');
  $('open-menu').setAttribute('aria-expanded','true');
  $(user?'close-menu':'close-public-menu').focus();
});
for(const id of ['close-menu','close-public-menu','drawer-overlay'])$(id).addEventListener('click',()=>closeDrawer({restoreFocus:true}));
document.addEventListener('keydown',event=>{
  if(!document.body.classList.contains('drawer-open'))return;
  if(event.key==='Escape'){closeDrawer({restoreFocus:true});return;}
  if(event.key==='Tab'){
    const drawer=$(current?.user?'workspace-nav':'public-menu');
    const fields=[...drawer.querySelectorAll('button:not([hidden]),a[href]')];
    const first=fields[0],last=fields.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
$('view-bot').addEventListener('click',showBots);
$('back-to-bots').addEventListener('click',showBots);
for(const [id,view] of [['view-vip','vip'],['view-home','home'],['view-wallet','wallet'],['dashboard-wallet','wallet'],['view-buy','buy'],['wallet-buy','buy'],['buy-back','home'],['view-profile','profile'],['avatar-button','profile']]){
  $(id).addEventListener('click',()=>switchView(view));
}
$('view-owner').addEventListener('click',()=>action($('view-owner'),async()=>{
  await openAdminDashboard();
}));
for(const id of ['deploy-cta','public-signup'])$(id).addEventListener('click',()=>openAuth(true));
for(const id of ['sign-in-link','hero-login','public-login'])$(id).addEventListener('click',event=>{
  event.preventDefault();openAuth(false);
});
for(const id of ['public-home','auth-back'])$(id).addEventListener('click',event=>{
  event.preventDefault();closeDrawer();authOpen=false;recovering=false;resetToken=null;authView();draw(current||{});window.scrollTo(0,0);
});
$('toggle-password').addEventListener('click',()=>{
  const button=$('toggle-password'), input=$('auth-password');
  const show=input.type==='password';
  input.type=show?'text':'password';
  button.textContent=show?'Hide':'Show';
  button.setAttribute('aria-pressed',String(show));
});
$('search-form').addEventListener('submit',event=>{
  event.preventDefault();action(event.submitter,ownerList);
});
$('action').addEventListener('change',()=>{
  $('amount-field').hidden=!['grant','remove'].includes($('action').value);
});
$('owner-action').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    if(!selectedUser)return;
    const operation=$('action').value;
    if(['ban','grant','remove'].includes(operation)){
      const description=operation==='ban'?'Ban '+selectedUser.name:($('action').selectedOptions[0].text+' ('+$('amount').value+') for '+selectedUser.name);
      if(!window.confirm(description+'?'))return;
    }
    await request('/api/owner',{userId:selectedUser.id,action:$('action').value,amount:Number($('amount').value),reason:$('reason').value.trim()});
    $('reason').value='';
    await ownerList();
    await refresh();
    note('Owner action recorded.');
  });
});
function authMode(register){
  registering=register;
  $('auth-heading').textContent=register?'Create Account':'Welcome Back';
  $('auth-email-label').textContent=register?'Email address':'Username or email';
  $('auth-email').type=register?'email':'text';
  $('auth-email').autocomplete=register?'email':'username';
  $('remember-field').hidden=register;
  for(const key of ['username','confirm']){
    $(`auth-${key}-field`).hidden=!register;
    $(`auth-${key}`).disabled=!register;
    $(`auth-${key}`).required=register;
  }
  $('auth-name-field').hidden=!register;
  $('auth-name').required=register;
  $('auth-name').disabled=!register;
  $('auth-password-hint').hidden=!register;
  $('auth-password').autocomplete=register?'new-password':'current-password';
  $('auth-password').minLength=register?12:1;
  $('auth-submit').textContent=register?'Create account':'Sign in';
  $('show-recovery').hidden=register;
  for(const [id,active] of [['auth-login',!register],['auth-register',register]]){
    $(id).classList.toggle('selected',active);
    $(id).setAttribute('aria-pressed',String(active));
  }
  note('');
}
function authView(){
  $('auth-form').hidden=recovering||!!resetToken;
  $('recovery-form').hidden=!recovering||!!resetToken;
  $('reset-form').hidden=!resetToken;
  $('auth-login').closest('.tabs').hidden=recovering||!!resetToken;
}
authView();
function showRecoveryId(){
  $('recovery-tracker').hidden=!recoveryId;
  $('recovery-id').textContent=recoveryId||'';
  if(recoveryId)$('recovery-status').textContent='Awaiting administrator approval. Check again after support verifies your linked number.';
}
async function checkRecovery(){
  if(!recoveryId)return;
  const status=await request('/api/auth/recovery-status?'+new URLSearchParams({requestId:recoveryId}));
  if(status.state==='approved'){
    resetToken='approved';recovering=false;authOpen=true;
    $('reset-code-display').textContent=status.code;
    $('reset-code').value=status.code;
    authView();$('reset-password').focus();
    note('Approved. Enter a new password before your reset code expires.');
  }else if(status.state==='expired'||status.state==='used'||status.state==='rejected'){
    $('recovery-status').textContent=status.state==='rejected'?'Request declined. Contact support or start a new request.':'Request expired or completed. Start another request if needed.';
    sessionStorage.removeItem('raymonRecoveryId');recoveryId=null;
    $('recovery-email').disabled=false;
  }else{
    $('recovery-status').textContent='Awaiting administrator approval.';
  }
}
showRecoveryId();
if(recoveryId)checkRecovery().catch(()=>{});
$('check-recovery').addEventListener('click',()=>action($('check-recovery'),checkRecovery));
$('auth-login').addEventListener('click',()=>authMode(false));
$('auth-register').addEventListener('click',()=>authMode(true));
$('show-recovery').addEventListener('click',()=>{
  $('recovery-email').value=$('auth-email').value;
  recovering=true;note('');authView();showRecoveryId();$('recovery-email').focus();
});
$('cancel-recovery').addEventListener('click',()=>{recovering=false;note('');authView();$('auth-email').focus();});
$('recovery-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const result=await request('/api/auth/forgot-password',{email:$('recovery-email').value});
    recoveryId=result.requestId;
    sessionStorage.setItem('raymonRecoveryId',recoveryId);
    showRecoveryId();
    note('Request created. Send the ID to WhatsApp support from your linked phone number.');
  });
});
$('reset-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    await request('/api/auth/reset-password',{
      requestId:recoveryId,code:$('reset-code').value.trim().toUpperCase(),
      password:$('reset-password').value,confirmation:$('reset-confirm').value
    });
    event.target.reset();
    sessionStorage.removeItem('raymonRecoveryId');
    recoveryId=null;resetToken=null;recovering=false;authOpen=true;
    authMode(false);authView();
    await refresh();
    note('Password updated. Sign in with your new password.');
    $('auth-email').focus();
  });
});
$('auth-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const data={email:$('auth-email').value,password:$('auth-password').value,remember:$('remember-session').checked};
    if(registering){
      data.name=$('auth-name').value;
      data.username=$('auth-username').value;
      data.confirmation=$('auth-confirm').value;
      data.referral=referral;
    }
    const view=await request(registering?'/api/auth/register':'/api/auth/login',data);
    event.target.reset();
    closeDrawer();
    workspaceView='home';
    draw(view);
    window.scrollTo(0,0);
  });
});
$('set-password-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const view=await request('/api/auth/set-password',{password:$('new-password').value});
    event.target.reset();
    draw(view);
    note('Password saved. You can now sign in with your email and password.');
  });
});
function maskPhone(phone){
  return phone.length>6?phone.slice(0,3)+' ••• •• '+phone.slice(-4):phone;
}
function referralUrl(code){
  if(!code)return '';
  const url=new URL('/',location.origin);
  url.searchParams.set('ref',code);
  return url.href;
}
function setValue(id,value){
  $(id).textContent=String(value);
}
function renderOverview({user,capacity,price,workerAvailable,dailyBonus,referralProgram},bots){
  const active=bots.filter(bot=>bot.state==='online').length;
  const renewals=bots.map(bot=>bot.nextRenewal).filter(Boolean);
  const renewal=renewals.length?formatDate(Math.min(...renewals)):'No renewal scheduled';
  setValue('home-heading','Welcome Back, '+user.name);
  setValue('home-wallet',numberFormat.format(user.coins)+' coins');
  setValue('home-coins',numberFormat.format(user.coins));
  setValue('total-bots',bots.length);
  setValue('active-bots',active);
  setValue('inactive-bots',bots.length-active);
  if(capacity){
    setValue('slots-usage',capacity.accountUsed===1?'1 of your bots is using a slot':capacity.accountUsed+' of your bots are using slots');
    setValue('slots-available',Math.max(0,capacity.total-capacity.used)+' shared platform slots available');
  }
  setValue('home-maintenance',price+' coins per bot every 24 hours · '+(workerAvailable?'Worker connected':'Worker unavailable'));
  setValue('home-renewal',renewals.length?'Next deduction '+renewal:renewal);
  setValue('wallet-renewal',renewals.length?'Next deduction '+renewal:renewal);
  $('dashboard-empty').hidden=!!bots.length||user.banned;
  $('home-referral').value=referralUrl(user.referralCode);
  $('claim-daily').hidden=!dailyBonus.enabled||dailyBonus.claimed;
  setValue('daily-bonus-status',!dailyBonus.enabled?'The daily bonus is turned off.':
    dailyBonus.claimed?'Claimed today. Next bonus opens at midnight Nigeria time.':
    'Claim '+dailyBonus.amount+' coins today. Resets at midnight Nigeria time.');
  setValue('referral-reward',!referralProgram.enabled?'Referral rewards are currently paused.':
    'Share your link. You earn '+referralProgram.inviterAmount+' coins and your friend earns '+referralProgram.inviteeAmount+
    (referralProgram.trigger==='signup'?' coins after signup.':' coins when their first bot goes online.'));
  setValue('referral-stats',referralProgram.pending+' pending · '+referralProgram.completed+' completed · '+numberFormat.format(referralProgram.earned)+' coins earned');
  const welcome=referralProgram.ownBonus;
  $('referral-welcome').hidden=!welcome?.amount;
  if(welcome?.amount)setValue('referral-welcome',welcome.paidAt===null?
    'Your '+welcome.amount+'-coin welcome referral bonus is pending.':
    'Your '+welcome.amount+'-coin welcome referral bonus was paid.');
}
function initials(name){
  return name.trim().split(/\s+/).slice(0,2).map(word=>[...word][0]).join('').toUpperCase();
}
function renderProfile(user){
  for(const option of $('theme-select').options){
    option.disabled=!['dark','light'].includes(option.value)&&!user.vip?.allowedThemes?.includes(option.value);
    option.hidden=option.disabled;
  }
  const stamp=JSON.stringify([user.name,user.username,user.email,user.theme]);
  if(stamp!==profileUser){
    profileUser=stamp;
    $('profile-name').value=user.name;
    $('profile-username').value=user.username||'';
    $('profile-address').value=user.email;
    $('theme-select').value=user.theme||'dark';
    document.documentElement.dataset.theme=user.theme||'dark';
  }
  for(const id of ['avatar-button','profile-avatar']){
    const avatar=$(id),key=user.email+':'+(user.avatarVersion||user.name);
    if(avatar.dataset.photo===key)continue;
    avatar.dataset.photo=key;
    avatar.textContent=initials(user.name);
    if(user.avatarVersion){
      const img=element('img');
      img.alt='';
      img.src='/api/profile/avatar?v='+encodeURIComponent(user.avatarVersion);
      img.addEventListener('error',()=>{if(avatar.dataset.photo===key)avatar.textContent=initials(user.name);},{once:true});
      avatar.replaceChildren(img);
    }
  }
  $('remove-avatar').hidden=!user.avatarVersion;
  setValue('profile-heading',user.name);
  let badges=$('profile-member-badges');
  if(!badges){badges=element('span');badges.id='profile-member-badges';$('profile-heading').after(badges);}
  const level=user.staff?.suspended?0:user.staff?.level;
  const role=user.isOwner?'FOUNDER':level===7?'CHIEF ADMIN':level>=5?'SENIOR ADMIN':level>=1?'ADMIN':null;
  badges.replaceChildren(memberBadges({role,vip:user.vip?.tier}));
  setValue('profile-email',user.email);
  setValue('profile-status',user.banned?'Suspended':user.isOwner?'Founder':user.staff?.level?'Adm Lvl '+user.staff.level+(user.staff.suspended?' · Suspended':''):'Active account');
  setValue('profile-balance',numberFormat.format(user.coins)+' coins');
  setValue('profile-code',user.referralCode||'Unavailable');
  setValue('profile-since',user.created?new Date(user.created).toLocaleDateString(undefined,{month:'short',year:'numeric'}):'Unavailable');
  $('profile-referral').value=referralUrl(user.referralCode);
  $('close-account-form').hidden=user.isOwner||user.banned||user.needsPassword;
  if(user.isOwner)setValue('close-account-info','The designated portal owner account is protected.');
  $('password-change-form').hidden=user.needsPassword||user.banned;
}
for(const button of document.querySelectorAll('.copy-referral'))button.addEventListener('click',()=>action(button,async()=>{
  const link=referralUrl(current?.user?.referralCode);
  if(!link)throw new Error('No referral link available.');
  await navigator.clipboard.writeText(link);
  note('Referral link copied.');
}));
function profileTab(name){
  for(const button of document.querySelectorAll('[data-profile-tab]')){
    const key=button.dataset.profileTab;
    button.setAttribute('aria-pressed',String(key===name));
    $('profile-'+key).hidden=key!==name;
  }
}
for(const button of document.querySelectorAll('[data-profile-tab]'))button.addEventListener('click',()=>profileTab(button.dataset.profileTab));
profileTab('information');
$('avatar-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const file=$('avatar-file').files[0];
    if(!file||file.size>3*1024*1024)throw new Error('Choose a JPG, PNG, or WebP photo under 3 MB.');
    draw(await request('/api/profile/avatar',file));
    event.target.reset();
    note('Profile photo updated.');
  });
});
$('remove-avatar').addEventListener('click',()=>action($('remove-avatar'),async()=>{
  draw(await request('/api/profile/avatar',{remove:true}));
  note('Profile photo removed.');
}));
$('claim-daily').addEventListener('click',()=>action($('claim-daily'),async()=>{
  const data=await request('/api/rewards/daily',{});
  draw(data);
  note('Daily bonus claimed. '+data.claimedAmount+' coins added.');
}));
const rewardFields=[['daily-enabled','dailyEnabled'],['daily-amount','dailyAmount'],
  ['referral-enabled','referralEnabled'],['inviter-amount','inviterAmount'],['invitee-amount','inviteeAmount'],
  ['referral-trigger','referralTrigger']];
function renderRewardSettings({settings,daily,referrals}){
  const form=$('rewards-form'),stamp=JSON.stringify(settings);
  if(form.dataset.settings!==stamp){
    form.dataset.settings=stamp;
    for(const [id,key] of rewardFields){
      const field=$(id);
      if(field.type==='checkbox')field.checked=!!settings[key];
      else field.value=settings[key];
    }
  }
  setValue('owner-daily-stats',daily.claims+' claims · '+numberFormat.format(daily.paid)+' coins paid');
  setValue('owner-referral-stats',referrals.pending+' pending · '+referrals.completed+' completed · '+numberFormat.format(referrals.earned)+' coins paid');
}
$('rewards-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const settings=Object.fromEntries(rewardFields.map(([id,key])=>{
      const field=$(id);
      return [key,field.type==='checkbox'?field.checked:field.type==='number'?field.valueAsNumber:field.value];
    }));
    await request('/api/owner/rewards',settings);
    await Promise.all([ownerList(),refresh()]);
    note('Reward settings saved.');
  });
});
for(const [id,route,payload] of [
  ['profile-form','/api/profile',()=>({name:$('profile-name').value,...($('profile-username').value?{username:$('profile-username').value}:{})})],
  ['appearance-form','/api/profile',()=>({theme:$('theme-select').value})],
  ['password-change-form','/api/auth/change-password',()=>({currentPassword:$('password-current').value,password:$('password-new').value,confirmation:$('password-confirm').value})],
  ['close-account-form','/api/auth/close-account',()=>({password:$('close-password').value,confirmation:$('close-confirm').value})]
]){
  $(id).addEventListener('submit',event=>{
    event.preventDefault();
    action(event.submitter,async()=>{
      const data=await request(route,payload());
      if(route.endsWith('/close-account')){location.assign('/');return;}
      draw(data);
      if(id==='password-change-form')event.target.reset();
      note(id==='password-change-form'?'Password changed. Other sessions were signed out.':'Changes saved.');
    });
  });
}
function setUnread(count){
  const badge=$('unread-count');
  badge.hidden=count===0;
  badge.textContent=count>99?'99+':String(count);
  $('notifications-button').setAttribute('aria-label',count?'Notifications ('+count+' unread)':'Notifications');
}
function drawEvents(id,rows,empty,noticeActions=false){
  const list=$(id);
  list.replaceChildren();
  if(!rows.length){list.append(element('p',empty,'muted'));return;}
  for(const row of rows){
    const entry=element('article',undefined,'event');
    entry.append(element('h3',row.title),element('p',row.description,'muted'),element('time',formatDate(row.created)));
    if(noticeActions){
      entry.classList.toggle('unread',!row.read);
      const controls=element('div',undefined,'actions');
      if(row.chatMessageId)controls.append(v3Button('Open message',()=>openChatMention(row.chatMessageId),'primary'));
      if(row.ticketId&&(!row.staffTicket||can('tickets.view')))
        controls.append(v3Button('Open ticket',()=>openTicketNotice(row),'primary'));
      for(const [command,label] of [['read','Mark as read'],['dismiss','Dismiss']]){
        if(command==='read'&&row.read)continue;
        const button=element('button',label,'button quiet');
        button.type='button';
        button.addEventListener('click',()=>action(button,async()=>{
          const data=await request('/api/notifications',{id:row.id,action:command});
          drawEvents(id,data.notices,empty,true);
          setUnread(data.notices.filter(item=>!item.read).length);
          list.setAttribute('tabindex','-1');
          list.focus();
        }));
        controls.append(button);
      }
      entry.append(controls);
    }
    list.append(entry);
  }
}
function openDialog(id){
  closeDrawer();
  if(!$(id).open)$(id).showModal();
}
$('notifications-button').addEventListener('click',()=>action($('notifications-button'),async()=>{
  openDialog('notifications-dialog');
  setValue('notifications-list','Loading notifications…');
  try{
    const {notices}=await request('/api/notifications');
    drawEvents('notifications-list',notices,'No notifications yet.',true);
    setUnread(notices.filter(row=>!row.read).length);
  }catch(error){setValue('notifications-list',error.message);}
}));
$('event-logs').addEventListener('click',()=>action($('event-logs'),async()=>{
  openDialog('events-dialog');
  setValue('events-list','Loading deployment events…');
  try{
    const query=new URLSearchParams({deploymentId:selectedBotId});
    const {events}=await request('/api/bot-events?'+query);
    drawEvents('events-list',events,'No recorded events for this deployment.');
  }catch(error){setValue('events-list',error.message);}
}));
$('view-community').addEventListener('click',async()=>{
  switchView('community');
  setValue('community-feed','Loading announcements…');
  try{
    const {announcements,community}=await request('/api/community');
    $('community-link').hidden=!community;
    if(community)$('community-link').href=community;
    drawEvents('community-feed',announcements,'No announcements yet.');
  }catch(error){setValue('community-feed',error.message);}
});
$('announcement-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    await request('/api/owner/announcements',{title:$('announcement-title').value,description:$('announcement-body').value});
    event.target.reset();
    note('Announcement published.');
  });
});

window.addEventListener('DOMContentLoaded',()=>refresh().catch(error=>note(error.message,true)),{once:true});
let ticks=0;
setInterval(()=>{
  if(document.hidden||!current?.user)return;
  ticks++;
  const waiting=(current.deployments||[]).some(bot=>bot.pairingExpires>Date.now());
  if(waiting||ticks%5===0)refresh().catch(()=>{});
},2500);
