'use strict';
const $=id=>document.getElementById(id);
const names={queued:'Requesting code',awaiting_code:'Awaiting link',connecting:'Connecting',online:'Online',paused:'Paused',
  low_balance:'Paused · Low balance',expired:'Code expired',needs_pairing:'Needs pairing',pair_failed:'Pairing failed',suspended:'Suspended'};
const formatDate=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
let current,selectedUser,ownerOpen=false,refreshing=false;
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
  $('landing').hidden=!!user;
  $('dashboard').hidden=!user;
  $('sign-out').hidden=!user;
  if(!user)return;
  $('greeting').textContent='Hi, '+user.name.split(' ')[0];
  $('account-email').textContent=user.email;
  $('view-owner').hidden=!user.isOwner;
  $('balance').textContent=user.coins;
  $('bot-state').textContent=user.banned?'Suspended':(names[d?.state]||'Not linked');
  $('bot-phone').textContent=d?.phone||'No WhatsApp number';
  $('paid-until').textContent=d?.paidUntil>Date.now()?formatDate(d.paidUntil):'—';
  const pending=!!d?.pairingExpires;
  const canLink=!user.banned&&!d?.linked&&!pending;
  $('pair-form').hidden=!canLink;
  if(canLink&&d?.phone&&!$('phone').value)$('phone').value=d.phone;
  $('pair-code-area').hidden=!d?.code;
  $('pair-code').textContent=d?.code||'';
  $('expires').textContent=d?.pairingExpires?'Expires at '+formatDate(d.pairingExpires):'';
  $('bot-actions').hidden=!d?.linked||user.banned;
  $('pause').hidden=!['online','connecting'].includes(d?.state);
  $('resume').hidden=['online','connecting'].includes(d?.state);
  $('resume').disabled=d?.state==='low_balance'&&user.coins<10;
  $('connection-title').textContent=d?.linked?'WhatsApp connection':'Link WhatsApp';
  $('connection-info').textContent=user.banned?'Your account is suspended. Contact the portal owner.':
    d?.state==='low_balance'?'Add at least 10 coins to bring your bot back online.':
    d?.state==='expired'?'The previous code expired. You can request another one.':
    ['needs_pairing','pair_failed'].includes(d?.state)?'WhatsApp could not finish linking. Request a fresh code.':
    d?.linked?'Pausing stops bot activity. Your paid period continues until its expiry.':
    pending&&!d.code?'Waiting for WhatsApp to generate a pairing code…':'Use a WhatsApp account you control.';
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
const loginError=new URLSearchParams(location.search).get('error');
if(loginError){
  note(loginError==='setup'?'Google sign-in is awaiting deployment configuration.':'Google sign-in could not be completed. Please try again.',true);
  history.replaceState({},'',location.pathname);
}
refresh().catch(error=>note(error.message,true));
setInterval(()=>{if(!document.hidden&&current?.user&&!ownerOpen)refresh().catch(()=>{});},2500);
