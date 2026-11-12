'use strict';
const $=id=>document.getElementById(id);
const names={queued:'Requesting code',awaiting_code:'Waiting for pairing',connecting:'Connecting',reconnecting:'Reconnecting',online:'Online',paused:'Paused',
  low_balance:'Out of coins',expired:'Code expired',needs_pairing:'Needs pairing',pair_failed:'Pairing failed',suspended:'Suspended'};
const formatDate=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
let current,selectedUser,pendingTransfer,ownerOpen=false,refreshing=false,registering=false,recovering=false;
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
function draw(data){
  current=data;
  const {user,deployment:d}=data;
  $('landing').hidden=!!user&&!resetToken;
  $('dashboard').hidden=!user||!!resetToken;
  $('sign-out').hidden=!user||!!resetToken;
  $('show-recovery').hidden=registering||!data.recoveryAvailable;
  if(!user||resetToken)return;
  $('greeting').textContent='Hi, '+user.name.split(' ')[0];
  $('account-email').textContent=user.email;
  $('view-owner').hidden=!user.isOwner;
  $('password-setup').hidden=!user.needsPassword||user.banned;
  $('balance').textContent=user.coins;
  $('bot-state').textContent=user.banned?'Suspended':(names[d?.state]||'Not linked');
  $('bot-phone').textContent=d?.phone||'No WhatsApp number';
  $('paid-until').textContent=d?.nextRenewal?formatDate(d.nextRenewal):'—';
  $('renewal-detail').textContent=d?.state==='paused'&&d.paidUntil>Date.now()
    ?'Paused · paid through '+formatDate(d.paidUntil):data.price+' coins per 24 hours';
  const alert=d?.lowBalanceAlert?'Your bot will pause at '+formatDate(d.nextRenewal)+
    ' unless your balance reaches '+data.price+' coins. You have '+user.coins+'.':'';
  if($('low-balance-alert').textContent!==alert)$('low-balance-alert').textContent=alert;
  $('low-balance-alert').hidden=!alert;
  $('transfer-panel').hidden=user.banned;
  const pending=!!d?.pairingExpires;
  const canLink=!user.banned&&!d?.linked&&!pending;
  $('pair-form').hidden=!canLink;
  if(canLink&&d?.phone&&!$('phone').value)$('phone').value=d.phone;
  $('pair-code-area').hidden=!d?.code;
  $('pair-code').textContent=d?.code||'';
  $('expires').textContent=d?.pairingExpires?'Expires at '+formatDate(d.pairingExpires):'';
  $('bot-actions').hidden=!d?.linked||user.banned;
  const running=['online','connecting','reconnecting'].includes(d?.state);
  $('pause').hidden=!running;
  $('resume').hidden=running;
  $('resume').disabled=d?.state==='low_balance'&&user.coins<data.price;
  $('connection-title').textContent=d?.linked?'WhatsApp connection':'Link WhatsApp';
  $('connection-info').textContent=user.banned?'Your account is suspended. Contact the portal owner.':
    d?.state==='low_balance'?'Your paid time ended. Add '+(data.price-user.coins)+' coins or more to resume.':
    d?.state==='expired'?'The previous code expired. You can request another one.':
    ['needs_pairing','pair_failed'].includes(d?.state)?'WhatsApp could not finish linking. Request a fresh code.':
    d?.state==='reconnecting'?'Trying to reconnect your existing WhatsApp session.':
    d?.linked?'Pausing stops bot activity. Your paid period continues until its expiry.':
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
$('pair-form').addEventListener('submit',event=>{
  event.preventDefault();
  action(event.submitter,async()=>{await request('/api/pair',{phone:$('phone').value});await refresh();});
});
for(const command of ['pause','resume']){
  $(command).addEventListener('click',()=>action($(command),async()=>{
    await request('/api/control',{action:command});
    await refresh();
  }));
}
$('copy-code').addEventListener('click',()=>action($('copy-code'),async()=>{
  if(!current?.deployment?.code)return;
  if(!navigator.clipboard)throw new Error('Select and copy the code shown on screen.');
  await navigator.clipboard.writeText(current.deployment.code);
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
    row.append(identity,element('td',user.phone||'—'),element('td',user.coins),
      element('td',user.banned?'Suspended':(names[user.state]||'Not linked')),controls);
    table.append(row);
  }
  if(!data.users.length){
    const row=element('tr'),cell=element('td','No matching users.','muted');
    cell.colSpan=5;row.append(cell);table.append(row);
  }
  if(selectedUser){
    fillHistory($('selected-history'),data.history);
    fillHistory($('selected-audit'),data.audit);
  }
}
function switchView(owner){
  ownerOpen=owner;
  $('bot-view').hidden=owner;
  $('owner-view').hidden=!owner;
  $('view-bot').classList.toggle('selected',!owner);
  $('view-owner').classList.toggle('selected',owner);
}
$('view-bot').addEventListener('click',()=>switchView(false));
$('view-owner').addEventListener('click',()=>action($('view-owner'),async()=>{
  await ownerList();switchView(true);
}));
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
setInterval(()=>{if(!document.hidden&&current?.user&&!ownerOpen)refresh().catch(()=>{});},2500);
