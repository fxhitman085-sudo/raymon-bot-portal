'use strict';
/* V5 controls use existing authenticated request(), element(), and VIP asset URLs. */
let v5LastMessage=0,v5ChatBusy=false,v5ChatReply=null,v5MenuState=null,v5MenuBot=null,v5ChatInitialized=false;
function memberAvatar(row){
 const avatar=element('span',initials(row.name),'member-photo');
 if(row.avatarVersion){
  const img=element('img');img.alt='';img.loading='lazy';
  img.src='/api/v5/member-avatar?'+new URLSearchParams({user:row.userId,v:row.avatarVersion});
  img.addEventListener('error',()=>img.remove(),{once:true});avatar.append(img);
 }
 return avatar;
}
function openMemberProfile(row){
 const dialog=element('dialog',undefined,'member-profile');
 dialog.setAttribute('aria-label','Member profile');
 const close=element('button','Close','button subtle');
 close.addEventListener('click',()=>dialog.close());
 dialog.append(memberAvatar(row),element('h2',row.name),memberBadges(row),close);
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});
 document.body.append(dialog);dialog.showModal();
}
function v5ChatBadge(row){
 const group=element('span',undefined,'v5-chat-head');
 const person=element('button',undefined,'member-link');person.type='button';
 person.setAttribute('aria-label','View profile of '+row.name);
 person.append(memberAvatar(row),element('strong',row.name));
 person.addEventListener('click',()=>openMemberProfile(row));
 group.append(person,memberBadges(row));return group;
}
function memberBadges(row){
 const group=element('span',undefined,'member-badges');
 const allowed=['FOUNDER','ADMIN','SENIOR ADMIN','CHIEF ADMIN'];
 if(allowed.includes(row.role)){
  const badge=element('span',row.role,'v5-staff-badge v5-role-'+row.role.replaceAll(' ','-'));
  badge.setAttribute('aria-label',row.role);
  group.append(badge);
 }
 if(['silver','gold','diamond'].includes(row.vip)){
  const img=element('img');
  img.src='/vip-'+row.vip+'.svg';img.alt=row.vip+' VIP';img.className='v5-chat-vip';
  img.width=70;img.height=21;img.loading='lazy';
  group.append(img);
 }
 return group;
}
function v5ChatTime(row){
 const clock=element('time',new Date(row.created).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
 clock.dateTime=new Date(row.created).toISOString();
 return clock;
}
function v5RenderChat(rows){
 const host=$('v5-chat-messages');
 const currentNearBottom=host.scrollHeight-host.scrollTop-host.clientHeight<90;
 const signature=JSON.stringify([current.user.id,rows]);
 if(host.dataset.signature===signature)return;
 host.dataset.signature=signature;
 const top=host.scrollTop;
 const anchor=[...host.querySelectorAll('article')].find(n=>n.getBoundingClientRect().bottom>host.getBoundingClientRect().top);
 const offset=anchor?.getBoundingClientRect().top;
 host.replaceChildren();
 let previousDay;
 for(const row of rows){
  const day=new Date(row.created).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
  if(day!==previousDay){host.append(element('span',day,'chat-day'));previousDay=day;}
  const item=element('article',undefined,'v5-chat-entry');
  item.dataset.id=row.id;
  item.classList.toggle('chat-own',row.userId===current.user.id);
  item.append(v5ChatBadge(row));
  if(row.replyTo)item.append(element('div','↳ Reply to a previous message','v5-chat-reply'));
  item.append(element('p',row.deleted?'Message deleted':row.message,row.deleted?'muted':''));
  if(row.edited&&!row.deleted)item.append(element('span','Edited','small muted'));
  if(row.pinned&&!row.deleted)item.append(element('span','📌 Pinned','small muted'));
  if(!row.deleted){
   const tools=element('div',undefined,'v5-chat-actions');
   function control(label,callback){
    const b=element('button',label,'button subtle');b.type='button';
    b.addEventListener('click',callback);tools.append(b);
   }
   control('Reply',()=>{
    v5ChatReply=row.id;
    $('v5-chat-input').placeholder='Replying to '+row.name+' — type message…';
    $('v5-chat-input').focus();
   });
   const me=current?.user;
   const own=row.name===me?.name&&row.userId===me?.id;
   if(own){
    control('Edit',async()=>{
     const text=window.prompt('Edit your message',row.message);
     if(text===null||text===row.message)return;
     try{await request('/api/v5/chat-action',{action:'edit',messageId:row.id,text});await v5LoadChat(true);}
     catch(e){note(e.message,true);}
    });
    control('Delete',async()=>{
     if(!window.confirm('Delete this community message?'))return;
     try{await request('/api/v5/chat-action',{action:'delete',messageId:row.id});await v5LoadChat(true);}
     catch(e){note(e.message,true);}
    });
   }else control('Report',async()=>{
    const reason=window.prompt('Why are you reporting this message?');
    if(!reason)return;
    try{await request('/api/v5/chat-action',{action:'report',messageId:row.id,reason});note('Message reported for review.');}
    catch(e){note(e.message,true);}
   });
   const moderator=me?.isOwner||me?.staff?.permissions?.includes('users.moderate');
   if(moderator){
    control(row.pinned?'Unpin':'Pin',async()=>{
     try{await request('/api/v5/moderate',{action:row.pinned?'unpin':'pin',messageId:row.id});await v5LoadChat(true);}
     catch(e){note(e.message,true);}
    });
    control('Remove',async()=>{
     if(!window.confirm('Remove this message as a moderator?'))return;
     try{await request('/api/v5/moderate',{action:'delete',messageId:row.id});await v5LoadChat(true);}
     catch(e){note(e.message,true);}
    });
    if(!own)control('Mute',async()=>{
     if(!window.confirm('Mute this user from community chat for one hour?'))return;
     try{await request('/api/v5/moderate',{action:'mute',targetId:row.userId,minutes:60,reason:'Moderator action'});note('User muted for one hour.');}
     catch(e){note(e.message,true);}
    });
   }
   const actions=element('details',undefined,'chat-options');
   const summary=element('summary','•••');summary.setAttribute('aria-label','Message actions');
   actions.append(summary,tools);item.append(actions);
  }
  item.append(v5ChatTime(row));host.append(item);
 }
 if(currentNearBottom||!v5ChatInitialized)host.scrollTop=host.scrollHeight;
 else{
  host.scrollTop=top;
  const replacement=[...host.querySelectorAll('article')].find(n=>n.dataset.id===anchor?.dataset.id);
  if(replacement)host.scrollTop+=replacement.getBoundingClientRect().top-offset;
 }
 if(!rows.length)host.append(element('p','No messages yet.','muted'));
 $('chat-latest').hidden=host.scrollHeight-host.scrollTop-host.clientHeight<90;
 v5ChatInitialized=true;
}
async function v5LoadChat(force=false){
 if(v5ChatBusy||!current?.user||workspaceView!=='chat')return;
 v5ChatBusy=true;
 try{
  const response=await request('/api/v5/chat');
  $('v5-chat-status').textContent=response.enabled?'Group chat':'Community chat is not currently enabled for your account.';
  $('v5-chat-form').hidden=!response.enabled;
  if(response.enabled){
   v5RenderChat(response.messages||[]);

  }else {delete $('v5-chat-messages').dataset.signature;$('v5-chat-messages').replaceChildren(element('p','Community chat is unavailable or in private beta.','muted'));}
 }catch(error){$('v5-chat-status').textContent=error.message;}
 finally{v5ChatBusy=false;}
}
async function v5LoadMyBetas(){
 if(!current?.user)return;
 const host=$('v5-my-betas'),panel=$('v5-beta-panel');
 const {betas}=await request('/api/v5/my-betas');
 panel.hidden=!betas.length;host.replaceChildren();
 for(const release of betas){
  const form=element('form',undefined,'v5-release-card v5-form');
  form.append(element('strong',release.version+' · '+release.title),
    element('p',release.description,'small muted'));
  const label=element('label','Send beta feedback');
  const input=element('textarea');input.maxLength=1200;input.required=true;input.rows=3;
  label.append(input);form.append(label);
  const button=element('button','Submit Feedback','button subtle');button.type='submit';form.append(button);
  form.addEventListener('submit',event=>{
   event.preventDefault();action(button,async()=>{
    await request('/api/v5/feedback',{releaseId:release.id,text:input.value});
    input.value='';note('Feedback submitted. Thank you for helping test this update.');
   });
  });
  host.append(form);
 }
}
$('view-community').addEventListener('click',()=>{void v5LoadMyBetas().catch(()=>{});});
$('view-chat').addEventListener('click',()=>{switchView('chat');void v5LoadChat(true);});
const chatList=$('v5-chat-messages');
chatList.addEventListener('scroll',()=>{$('chat-latest').hidden=chatList.scrollHeight-chatList.scrollTop-chatList.clientHeight<90;});
$('chat-latest').addEventListener('click',()=>{chatList.scrollTop=chatList.scrollHeight;});
$('v5-chat-refresh').addEventListener('click',()=>void v5LoadChat(true));
$('v5-chat-form').addEventListener('submit',event=>{
 event.preventDefault();
 action(event.submitter,async()=>{
  const text=$('v5-chat-input').value.trim();
  if(!text)return;
  await request('/api/v5/chat',{text,replyTo:v5ChatReply});
  $('v5-chat-input').value='';v5ChatReply=null;$('v5-chat-input').placeholder='Message';
  await v5LoadChat(true);
 });
});
setInterval(()=>{if(!document.hidden&&workspaceView==='chat'&&current?.user)v5LoadChat().catch(()=>{});},5500);

function v5MenuOptions(){
 const select=$('v5-menu-bot'),bots=current?.deployments||[];
 const original=select.value||v5MenuBot;
 select.replaceChildren();
 for(const bot of bots){
  const option=new Option(bot.phone,bot.id);select.append(option);
 }
 if(bots.some(b=>b.id===original))select.value=original;
 v5MenuBot=select.value;
 return v5MenuBot;
}
async function v5LoadMenu(){
 const bot=v5MenuOptions();
 if(!bot){
  $('v5-menu-status').textContent='Deploy a bot to customize its .menu image.';
  $('v5-menu-upload-form').hidden=$('v5-menu-settings-form').hidden=true;
  $('v5-menu-grid').replaceChildren();
  return;
 }
 const state=await request('/api/v5/menu?'+new URLSearchParams({bot}));
 v5MenuState=state;
 $('v5-menu-status').textContent=!state.enabled?
   (state.tier?'Menu customization is not enabled for your account yet.':'An active Silver, Gold, or Diamond VIP membership is required.'):
   state.tier.toUpperCase()+' VIP · '+state.images.length+'/'+state.limit+' images · Upload images from your device.';
 $('v5-menu-upload-form').hidden=!state.enabled||state.images.length>=state.limit;
 $('v5-menu-settings-form').hidden=!state.enabled||!state.images.length;
 $('v5-menu-mode').value=state.mode;
 for(const option of $('v5-menu-mode').options)option.disabled=state.tier!=='diamond'&&option.value!=='fixed';
 const host=$('v5-menu-grid');host.replaceChildren();
 for(const img of state.images){
  const card=element('article',undefined,'v5-menu-card');
  card.dataset.imageId=img.id;
  const image=element('img');
  image.src='/api/v5/menu-image?'+new URLSearchParams({bot,image:img.id,v:state.revision||''});
  image.alt='Uploaded menu image';image.loading='lazy';
  const label=element('label'),input=element('input');
  input.type='checkbox';input.checked=!!img.enabled;input.value=img.id;
  label.append(input,element('span','Use in .menu'));
  const remove=element('button','Remove','button subtle');remove.type='button';
  remove.addEventListener('click',async()=>{
   if(!window.confirm('Delete this menu image?'))return;
   try{await request('/api/v5/menu',{action:'remove',bot,image:img.id});await v5LoadMenu();}
   catch(error){note(error.message,true);}
  });
  card.append(image,label);
  if(state.tier==='diamond'&&state.images.length>1){
   const order=element('div',undefined,'actions');
   for(const [text,delta] of [['↑ Earlier',-1],['↓ Later',1]]){
    const button=element('button',text,'button subtle');button.type='button';
    button.addEventListener('click',()=>{
     const items=[...host.children],index=items.indexOf(card),next=index+delta;
     if(next<0||next>=items.length)return;
     if(delta<0)host.insertBefore(card,items[next]);
     else host.insertBefore(items[next],card);
    });
    order.append(button);
   }
   card.append(order);
  }
  card.append(remove);host.append(card);
 }
}
$('v5-menu-bot').addEventListener('change',()=>void v5LoadMenu().catch(error=>note(error.message,true)));
$('view-vip').addEventListener('click',()=>void v5LoadMenu().catch(error=>note(error.message,true)));
$('v5-menu-upload-form').addEventListener('submit',event=>{
 event.preventDefault();
 action(event.submitter,async()=>{
  const file=$('v5-menu-file').files[0];
  if(!file||file.size>3*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Choose a JPG, PNG or WebP file under 3 MB.');
  await request('/api/v5/menu-upload?'+new URLSearchParams({bot:$('v5-menu-bot').value}),file);
  event.target.reset();await v5LoadMenu();note('Menu image uploaded.');
 });
});
$('v5-menu-settings-form').addEventListener('submit',event=>{
 event.preventDefault();
 action(event.submitter,async()=>{
  const active=[...$('v5-menu-grid').querySelectorAll('input:checked')].map(input=>input.value);
  const order=[...$('v5-menu-grid').children].map(card=>card.dataset.imageId);
  await request('/api/v5/menu',{action:'configure',bot:$('v5-menu-bot').value,mode:$('v5-menu-mode').value,active,order});
  await v5LoadMenu();note('Menu gallery settings saved.');
 });
});

function v5MakeField(label,tag='input'){
 const wrap=element('label',label,'v5-form-field');
 const input=element(tag);input.required=true;
 wrap.append(input);return {wrap,input};
}
async function v5LoadReleases(){
 if(!current?.user?.isOwner)return;
 const host=$('cc4-pane-releases');
 host.replaceChildren();
 const limitPanel=element('article',undefined,'panel');
 limitPanel.append(element('h3','VIP Menu Gallery Limits'),element('p','Silver and Gold can keep one fixed picture. Configure how many pictures Diamond can store per bot.','small muted'));
 const limits=await request('/api/v5/gallery-limits');
 const diamond=limits.tiers.find(t=>t.tier==='diamond');
 const limitForm=element('form',undefined,'v5-release-form');
 const limitField=v5MakeField('Diamond images per bot (1–10)');
 limitField.input.type='number';limitField.input.min='1';limitField.input.max='10';limitField.input.step='1';
 limitField.input.value=String(diamond?.maximum||10);
 const limitButton=element('button','Save Diamond Image Limit','button subtle');
 limitButton.type='submit';limitForm.append(limitField.wrap,limitButton);
 limitForm.addEventListener('submit',event=>{
  event.preventDefault();action(limitButton,async()=>{
   await request('/api/v5/gallery-limits',{tier:'diamond',maximum:Number(limitField.input.value)});
   note('Diamond gallery limit saved.');
  });
 });
 limitPanel.append(limitForm);host.append(limitPanel);
 const panel=element('article',undefined,'panel');
 panel.append(element('h3','Create an upcoming release'),element('p','Only features already shipped in this portal can be activated through these controls. New code still requires a successful deployment.','small muted'));
 const form=element('form',undefined,'v5-release-form');
 const ver=v5MakeField('Version (example: v5.1.0-beta)'),title=v5MakeField('Release title'),
  desc=v5MakeField('Public release notes','textarea'),feature=v5MakeField('Shipped feature','select');
 for(const [label,value] of [['Community Chat','community_chat'],['VIP .menu Gallery','vip_menu_gallery']])feature.input.append(new Option(label,value));
 for(const f of [ver,title,desc,feature])form.append(f.wrap);
 ver.input.placeholder='v5.1.0-beta';title.input.maxLength=90;desc.input.maxLength=1600;
 const create=element('button','Create Draft','button primary');create.type='submit';form.append(create);
 form.addEventListener('submit',ev=>{
  ev.preventDefault();action(create,async()=>{
   await request('/api/v5/releases',{action:'create',version:ver.input.value,title:title.input.value,description:desc.input.value,feature:feature.input.value});
   await v5LoadReleases();note('Release draft created.');
  });
 });
 panel.append(form);host.append(panel);
 const response=await request('/api/v5/releases');
 const versions=element('section',undefined,'v5-release-list');
 versions.append(element('h3','Release History & Beta Audiences'));
 for(const release of response.releases){
  const card=element('article',undefined,'v5-release-card');
  card.append(element('strong',release.version+' — '+release.title),element('p',release.description,'small'),
    element('p',release.feature.replaceAll('_',' ')+' · '+release.state.toUpperCase()+' · '+release.feedback+' feedback entries','small muted'));
  const label=element('p','Beta Testers: '+release.audience.map(x=>x.kind==='tier'?x.value.toUpperCase()+' VIP':'Selected user').join(', ')||'None','small');
  card.append(label);
  let editor;
  if(['draft','beta','paused'].includes(release.state)){
   const audienceForm=element('form',undefined,'v5-release-form');
   audienceForm.append(element('p','Select VIP tiers (or search for specific users).','small'));
   const all=element('input');all.type='checkbox';
   const allLabel=element('label');allLabel.append(all,element('span','All VIP members'));audienceForm.append(allLabel);
   const checks=[];
   for(const tier of ['silver','gold','diamond']){
    const input=element('input');input.type='checkbox';input.checked=release.audience.some(x=>x.kind==='tier'&&x.value===tier);
    const box=element('label');box.append(input,element('span',tier.toUpperCase()+' VIP'));checks.push([tier,input]);audienceForm.append(box);
   }
   const syncAll=()=>{all.checked=checks.every(([,c])=>c.checked);all.indeterminate=!all.checked&&checks.some(([,c])=>c.checked);};
   syncAll();for(const [,c] of checks)c.addEventListener('change',syncAll);
   all.addEventListener('change',()=>{for(const [,c] of checks)c.checked=all.checked;syncAll();});
   const selected=new Set(release.audience.filter(x=>x.kind==='user').map(x=>x.value));
   const chips=element('div');
   function renderChips(){
    chips.replaceChildren();
    for(const id of selected){
     const chip=element('span',id.slice(0,8)+'…','v5-selected-user');
     const remove=element('button','×','button subtle');remove.type='button';remove.addEventListener('click',()=>{selected.delete(id);renderChips();});
     chip.append(remove);chips.append(chip);
    }
   }renderChips();
   audienceForm.append(chips);
   const search=v5MakeField('Find users by name or email');
   search.input.required=false;search.input.placeholder='Enter at least 2 characters';audienceForm.append(search.wrap);
   const searchResults=element('div',undefined,'v5-form');audienceForm.append(searchResults);
   const find=element('button','Search Users','button subtle');find.type='button';audienceForm.append(find);
   find.addEventListener('click',async()=>{
    searchResults.replaceChildren();
    try{
     const data=await request('/api/v3/staff-search?'+new URLSearchParams({search:search.input.value.trim()}));
     for(const account of data.accounts){
      const button=element('button',account.name+' · '+account.email,'button subtle');
      button.type='button';button.addEventListener('click',()=>{selected.add(account.id);renderChips();});
      searchResults.append(button);
     }
    }catch(error){note(error.message,true);}
   });
   const save=element('button','Save Beta Audience','button primary');save.type='submit';audienceForm.append(save);
   audienceForm.addEventListener('submit',event=>{
    event.preventDefault();
    const submit=event.submitter||save;
    action(submit,async()=>{
     const resume=submit.dataset.resume==='yes';
     if(resume&&!selected.size&&!checks.some(([,c])=>c.checked))throw Error('Select at least one tester or VIP tier.');
     await request('/api/v5/releases',{action:'audience',releaseId:release.id,
       tiers:checks.filter(x=>x[1].checked).map(x=>x[0]),users:[...selected]});
     if(resume)await request('/api/v5/releases',{action:'transition',releaseId:release.id,state:'beta',confirmation:release.version});
     await v5LoadReleases();note(resume?'Beta resumed.':'Beta audience saved.');
    });
   });
   if(release.state==='paused'){
    editor=element('details');editor.append(element('summary','Edit Testers'),audienceForm);
    const resume=element('button','Save & Resume','button primary');resume.type='submit';audienceForm.append(resume);
    resume.dataset.resume='yes';card.append(editor);
   }else card.append(audienceForm);
  }
  const actions=element('div',undefined,'actions');
  const transitions=release.state==='draft'?[['Start Beta','beta']]:
    release.state==='beta'?[['Launch Globally','global'],['Pause Beta','paused']]:
    release.state==='global'?[['Roll Back to Previous Stable','rollback'],['Pause Release','paused']]:[['Resume Beta','beta']];
  for(const [label,state] of transitions){
   const button=element('button',label,'button '+(state==='global'?'primary':'subtle'));
   button.type='button';
   button.addEventListener('click',async()=>{
    if(editor&&state==='beta'){editor.open=true;editor.scrollIntoView({block:'center'});editor.querySelector('input')?.focus({preventScroll:true});return;}
    const confirmation=window.prompt(state==='global'?'FOUNDER GLOBAL LAUNCH — type '+release.version+' to confirm publishing to all users.':state==='rollback'?'FOUNDER ROLLBACK — type '+release.version+' to restore the previous stable version.':'Type '+release.version+' to confirm the release change.');
    if(confirmation===null)return;
    try{
     await request('/api/v5/releases',{action:'transition',releaseId:release.id,state,confirmation});
     await v5LoadReleases();note('Release state changed to '+state+'.');
    }catch(error){note(error.message,true);}
   });
   actions.append(button);
  }
  const feedback=element('button','Review Feedback','button subtle');feedback.type='button';
  feedback.addEventListener('click',async()=>{
   try{
    const result=await request('/api/v5/feedback?'+new URLSearchParams({releaseId:release.id}));
    const list=element('div',undefined,'v5-form');
    list.append(element('h4','Beta feedback'));
    for(const report of result.feedback)list.append(element('p',report.name+': '+report.text,'small'));
    if(!result.feedback.length)list.append(element('p','No feedback submitted yet.','small muted'));
    card.append(list);
   }catch(e){note(e.message,true);}
  });
  actions.append(feedback);card.append(actions);versions.append(card);
 }
 if(!response.releases.length)versions.append(element('p','No releases created yet.','muted'));
 host.append(versions);
}

async function v5LoadModeration(){
 if(!current?.user)return;
 const host=$('cc4-pane-chat');host.replaceChildren();
 const panel=element('article',undefined,'panel');
 panel.append(element('h3','Community Report Inbox'),element('p','Review reports, remove messages, mute accounts, or dismiss false reports.','small muted'));
 const {reports}=await request('/api/v5/reports');
 const seen=new Set();
 for(const row of reports){
  if(seen.has(row.messageId))continue;seen.add(row.messageId);
  const card=element('div',undefined,'v5-release-card');
  card.append(element('strong',row.name+' · '+row.reports+' report(s)'),
    element('p',row.deleted?'Message already deleted':row.message,'small'),
    element('p','Reported reason: '+row.reason,'small muted'));
  const buttons=element('div',undefined,'actions');
  for(const [label,actionType] of [['Remove Message','delete'],['Mute User 1 Hour','mute'],['Dismiss Reports','dismiss']]){
   const button=element('button',label,'button subtle');button.type='button';
   button.addEventListener('click',async()=>{
    if(!window.confirm(label+'?'))return;
    try{
     await request('/api/v5/moderate',{action:actionType,messageId:row.messageId,
       targetId:row.userId,minutes:60,reason:'Community moderation review'});
     await v5LoadModeration();note(label+' completed.');
    }catch(error){note(error.message,true);}
   });
   buttons.append(button);
  }
  card.append(buttons);panel.append(card);
 }
 if(!seen.size)panel.append(element('p','No community reports awaiting review.','muted'));
 host.append(panel);
}
