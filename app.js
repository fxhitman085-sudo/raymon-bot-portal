'use strict';
const $=id=>document.getElementById(id);
const names={queued:'Requesting code',awaiting_code:'Waiting for pairing',connecting:'Connecting',reconnecting:'Reconnecting',online:'Online',paused:'Paused',
  low_balance:'Out of coins',expired:'Code expired',needs_pairing:'Needs pairing',pair_failed:'Pairing failed',suspended:'Suspended'};
const formatDate=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
let current,selectedUser,selectedBotId,addingBot=false,botListView,pendingTransfer,workspaceView='bots',manageOpen=false,refreshing=false,registering=false,recovering=false;
let resetToken=new URLSearchParams(location.hash.slice(1)).get('reset');
if(resetToken)history.replaceState(null,'',location.pathname+location.search);
const note=(message,error=false)=>{
  $('notice').textContent=message;
  $('notice').classList.toggle('error',error);
  $('notice').hidden=!message;
};
async function request(path,data){
  const response=await fetch(path,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
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
  $('dashboard').hidden=!user||!!resetToken;
  $('sign-out').hidden=!user||!!resetToken;
  $('sign-in-link').hidden=!!user||!!resetToken;
  $('site-footer').hidden=!!user&&!resetToken;
  $('landing-hero').hidden=!!resetToken;
  $('show-recovery').hidden=registering||!data.recoveryAvailable;
  if(!user||resetToken)return;
  $('greeting').textContent=user.name;
  $('account-email').textContent=user.email;
  $('view-owner').hidden=!user.isOwner;
  $('password-setup').hidden=!user.needsPassword||user.banned;
  $('balance').textContent=new Intl.NumberFormat().format(user.coins);
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
      const heading=element('h2',bot.phone);
      const title=element('div',undefined,'deployment-title');
      const state=user.banned?'suspended':bot.state;
      const status=element('span',names[state]||state,'bot-status');
      status.dataset.state=state;
      title.append(heading,status);
      const info=element('div',undefined,'deployment-info');
      info.append(title,element('p',bot.nextRenewal?'Renews '+formatDate(bot.nextRenewal):data.price+' coins per 24 hours'));
      const manage=element('button','Manage','button subtle');
      manage.type='button';
      manage.setAttribute('aria-label','Manage bot '+bot.phone);
      manage.addEventListener('click',()=>{
        addingBot=false;
        selectedBotId=bot.id;
        $('phone').value='';
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
  if(!d&&!addingBot)manageOpen=false;
  renderNavigation();
  $('bot-state').textContent=d?(user.banned?'Suspended':(names[d.state]||'Not linked')):'';
  $('bot-state').hidden=!d;
  $('bot-state').dataset.state=user.banned?'suspended':d?.state||'';
  $('manage-title').textContent=addingBot?'Add WhatsApp bot':d?.phone||'Manage bot';
  $('bot-renewal').hidden=!d?.linked;
  $('connection-panel').classList.toggle('pairing',!d?.linked);
  $('paid-until').textContent=d?.nextRenewal?formatDate(d.nextRenewal):'—';
  $('renewal-detail').textContent=d?.state==='paused'&&d.paidUntil>Date.now()
    ?'Paused · paid through '+formatDate(d.paidUntil):data.price+' coins per 24 hours';
  const low=deployments.filter(bot=>bot.lowBalanceAlert);
  const alert=low.length?'Low balance for '+low.length+' upcoming bot renewal(s). Each renewal costs '+data.price+' coins.':'';
  if($('low-balance-alert').textContent!==alert)$('low-balance-alert').textContent=alert;
  $('low-balance-alert').hidden=!alert;
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
  $('resume').hidden=running;
  $('resume').disabled=d?.state==='low_balance'&&user.coins<data.price;
  $('connection-title').textContent=d?.linked?'WhatsApp connection':'Link WhatsApp';
  $('connection-info').textContent=user.banned?'Your account is suspended. Contact the portal owner.':
    d?.state==='low_balance'?(user.coins<data.price?'Your paid time ended. Add '+(data.price-user.coins)+' coins or more to resume.':'Your paid time ended. Resume the bot to start a new period.'):
    d?.state==='expired'?'The previous code expired. You can request another one.':
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
  fillHistory($('history'),data.history);
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
  try{note('');await callback();}
  catch(error){note(error.message,true);}
  finally{button.disabled=false;}
}
$('add-bot').addEventListener('click',()=>{
  addingBot=true;
  manageOpen=true;
  resetSetup();
  $('phone').value='';
  draw(current);
  navigateTo('manage-title');
  $('phone').focus({preventScroll:true});
});
const normalizedPhone=()=>$('phone').value.trim().replace(/[ ()-]/g,'');
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
for(const command of ['pause','resume','cancel']){
  const button=$(command==='cancel'?'cancel-bot':command);
  button.addEventListener('click',()=>{
    const bot=current?.deployments.find(item=>item.id===selectedBotId);
    if(!bot||command==='cancel'&&!window.confirm('Cancel '+bot.phone+'? This stops the bot and future charges. To use the number again, pair it as a new bot.'))return;
    action(button,async()=>{
      await request('/api/control',{action:command,deploymentId:bot.id});
      draw(await request('/api/me'));
      if(command==='cancel'){
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
async function ownerList(){
  const params=new URLSearchParams({search:$('search').value});
  if(selectedUser)params.set('user',selectedUser.id);
  const data=await request('/api/owner?'+params), table=$('users');
  table.replaceChildren();
  for(const user of data.users){
    const row=element('tr'), identity=element('td',user.name);
    identity.append(element('span',user.email,'small'));
    const button=element('button','Manage','button subtle');
    button.type='button';
    button.addEventListener('click',()=>action(button,async()=>{
      selectedUser=user;
      $('selected-user').textContent='Manage '+user.name;
      $('admin-detail').hidden=false;
      await ownerList();
      $('action').focus();
    }));
    const controls=element('td');controls.append(button);
    row.append(identity,element('td',user.coins),element('td',user.banned?'Suspended':'Active'),controls);
    table.append(row);
  }
  if(!data.users.length){
    const row=element('tr'),cell=element('td','No matching users.','muted');
    cell.colSpan=4;row.append(cell);table.append(row);
  }
  if(selectedUser){
    const cards=$('selected-bots'),target=selectedUser;
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
      card.append(element('strong',bot.phone),element('span',names[bot.state]||bot.state),cancel);
      cards.append(card);
    }
    if(!data.deployments.length)cards.append(element('p','No bots deployed.','muted'));
    fillHistory($('selected-history'),data.history);
    fillHistory($('selected-audit'),data.audit);
  }
}
function renderNavigation(){
  if(!current?.user?.isOwner&&workspaceView==='owner')workspaceView='bots';
  $('bot-view').hidden=workspaceView!=='bots';
  $('wallet-view').hidden=workspaceView!=='wallet';
  $('owner-view').hidden=workspaceView!=='owner';
  $('deployments-view').hidden=manageOpen;
  $('manage-view').hidden=!manageOpen;
  for(const [view,id] of [['bots','view-bot'],['wallet','view-wallet'],['owner','view-owner']]){
    if(workspaceView===view)$(id).setAttribute('aria-current','page');
    else $(id).removeAttribute('aria-current');
  }
}
function navigateTo(id){
  window.scrollTo(0,0);
  $(id).focus({preventScroll:true});
}
function switchView(view){
  workspaceView=view;
  renderNavigation();
  navigateTo(view==='owner'?'owner-heading':view==='wallet'?'wallet-heading':'bots-heading');
}
function showBots(){
  manageOpen=false;
  addingBot=false;
  resetSetup();
  switchView('bots');
}
$('view-bot').addEventListener('click',showBots);
$('back-to-bots').addEventListener('click',showBots);
$('view-wallet').addEventListener('click',()=>switchView('wallet'));
$('view-owner').addEventListener('click',()=>action($('view-owner'),async()=>{
  await ownerList();switchView('owner');
}));
$('deploy-cta').addEventListener('click',()=>{
  authMode(true);
  $('account').scrollIntoView({block:'start'});
  $('auth-name').focus({preventScroll:true});
});
$('sign-in-link').addEventListener('click',()=>{
  if(resetToken)return;
  recovering=false;
  authMode(false);
  authView();
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
    await request('/api/owner',{userId:selectedUser.id,action:$('action').value,amount:Number($('amount').value),reason:$('reason').value.trim()});
    $('reason').value='';
    await ownerList();
    await refresh();
    note('Owner action recorded.');
  });
});
function authMode(register){
  registering=register;
  $('auth-name-field').hidden=!register;
  $('auth-name').required=register;
  $('auth-name').disabled=!register;
  $('auth-owner').hidden=!register;
  $('auth-owner-token').disabled=!register;
  $('auth-password-hint').hidden=!register;
  $('auth-password').autocomplete=register?'new-password':'current-password';
  $('auth-password').minLength=register?12:1;
  $('auth-submit').textContent=register?'Create account':'Sign in';
  $('show-recovery').hidden=register||!current?.recoveryAvailable;
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
$('auth-login').addEventListener('click',()=>authMode(false));
$('auth-register').addEventListener('click',()=>authMode(true));
$('show-recovery').addEventListener('click',()=>{
  $('recovery-email').value=$('auth-email').value;
  recovering=true;note('');authView();$('recovery-email').focus();
});
$('cancel-recovery').addEventListener('click',()=>{recovering=false;note('');authView();$('auth-email').focus();});
$('recovery-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    await request('/api/auth/forgot-password',{email:$('recovery-email').value});
    note('If that address has a portal account, a reset link will arrive by email.');
  });
});
$('reset-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    await request('/api/auth/reset-password',{token:resetToken,password:$('reset-password').value});
    event.target.reset();
    resetToken=null;recovering=false;
    authMode(false);authView();
    await refresh();
    note('Password updated. Sign in with your new password.');
    $('auth-email').focus();
  });
});
$('auth-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{
    const data={email:$('auth-email').value,password:$('auth-password').value};
    if(registering){
      data.name=$('auth-name').value;
      data.ownerToken=$('auth-owner-token').value;
    }
    const view=await request(registering?'/api/auth/register':'/api/auth/login',data);
    event.target.reset();
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
refresh().catch(error=>note(error.message,true));
setInterval(()=>{if(!document.hidden&&current?.user&&workspaceView!=='owner')refresh().catch(()=>{});},2500);
