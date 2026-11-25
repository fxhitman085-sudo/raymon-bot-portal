'use strict';
(()=>{
const api=(query='',data)=>request('/api/recruitment'+query,data);
const make=(tag,text)=>element(tag,text);
function button(parent,label,fn){const b=make('button',label);b.type='button';b.className='button subtle';b.onclick=()=>action(b,fn);parent.append(b);return b;}
function field(parent,label,type,value){
 const wrap=make('label',label),input=make(type==='textarea'?'textarea':type==='select'?'select':'input');
 if(input.tagName==='INPUT')input.type=type;
 if(type==='checkbox')input.checked=!!value;else if(value!=null)input.value=value;
 wrap.append(input);parent.append(wrap);return input;
}
function select(parent,label,choices,value){const el=field(parent,label,'select');for(const c of choices)el.add(new Option(c,c));el.value=value??choices[0];return el;}
function section(parent,title){const box=make('details'),head=make('summary',title);box.className='panel rec-block';box.append(head);parent.append(box);return box;}
const form=$('rec-form');
async function applyPage(){
 switchView('community');form.hidden=false;
 const data=await api();form.replaceChildren(make('h2','Apply for Admin'));
 for(const a of data.applications)form.append(make('p',a.status+' · Round '+a.round+' · '+a.id));
 if(!data.round){form.append(make('p','Applications are closed.'));return;}
 if(data.applications.some(a=>!['Accepted','Rejected'].includes(a.status)))return;
 form.append(make('p','Round '+data.round+' · '+data.questions.length+' questions. Answers are private. Recruitment reviewers may use Gemini to assess them.'));
 const inputs=[];
 for(const q of data.questions){
 const group=make('fieldset');form.append(group);group.append(make('legend',q.category+' · '+q.difficulty));
 const input=field(group,q.prompt,'textarea');input.maxLength=3000;
 const disclosure=field(group,'I used AI assistance on this answer','checkbox');
 button(group,'Edit my draft with Gemini',async()=>{const result=await api('',{action:'assist',round:data.round,qid:q.id,text:input.value});input.value=result.text;disclosure.checked=true;});
 inputs.push({q,input,disclosure});}
 button(form,'Submit application',async()=>{
 const answers={};for(const {q,input,disclosure} of inputs){if(!input.value.trim()){input.focus();throw Error('Answer each question before submitting.');}answers[q.id]={text:input.value,disclosed:disclosure.checked};}
 await api('',{action:'submit',round:data.round,answers});await applyPage();note('Application submitted.');});
}
$('rec-apply').onclick=()=>action($('rec-apply'),applyPage);
const ticker=$('rec-ticker');ticker.onclick=()=>action(ticker,applyPage);
let openedFor=null;
window.recDashboard=data=>{
 const r=data.recruitment;ticker.hidden=!r||!data.user;
 if(r&&ticker.dataset.text!==r.ticker){ticker.replaceChildren();const track=make('span');track.className='rec-track';for(let i=0;i<2;i++)track.append(make('span',r.ticker));ticker.append(track);ticker.dataset.text=r.ticker;delete ticker.dataset.speed;}
 if(r&&ticker.firstChild&&ticker.dataset.speed!==String(r.speed)){
 ticker.dataset.speed=r.speed;ticker.firstChild.getAnimations().forEach(a=>a.cancel());
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches)ticker.firstChild.animate([{transform:'translateX(0)'},{transform:'translateX(-50%)'}],{duration:r.speed*1000,iterations:Infinity});}
 if(!data.user){openedFor=null;form.replaceChildren();form.hidden=true;}
 if(data.user&&location.hash==='#apply-admin'&&openedFor!==data.user.id){openedFor=data.user.id;setTimeout(()=>applyPage().catch(e=>note(e.message,true)),0);}
};
if(typeof current!=='undefined'&&current)window.recDashboard(current);
const post=(action,data)=>api('',{action,...data});
async function settings(host){
 const state=await api('?settings=1'),cfg=state.config,round=section(host,'Round settings & question selection');round.open=true;
 round.append(make('p',state.round?'Round '+state.round+' is open':'Applications are closed'));
 const mode=select(round,'Recruitment mode',['Founder-Controlled','Always Open'],cfg.mode);
 const count=field(round,'Questions per round (1–200)','number',cfg.count);
 const limit=field(round,'Application limit','number',cfg.limit),cool=field(round,'Cooldown in days','number',cfg.cooldown);
 const ticker=field(round,'Dashboard announcement','text',cfg.ticker),speed=field(round,'Seconds per scroll','number',cfg.speed);
 const min=field(round,'Recommended minimum score','number',cfg.minimum);
 const diff=select(round,'Difficulty',['Any','Basic','Intermediate','Advanced'],cfg.difficulty);
 const categoryBox=section(round,'Categories and grading weights');
 const cats=state.categories.map(c=>({c,enabled:field(categoryBox,c,'checkbox',cfg.categories.includes(c)),weight:field(categoryBox,c+' weight (optional)','number',cfg.weights[c])}));
 const picks=section(round,'Choose specific questions');picks.append(make('p','Unfilled places are drawn randomly from the selected categories and difficulty.'));
 button(picks,'Clear manual picks for a random draw',()=>{for(const [,input] of checks)input.checked=false;});
 const checks=state.bank.filter(q=>q.enabled).map(q=>[q.id,field(picks,q.id+' · '+q.prompt,'checkbox',cfg.ids.includes(q.id))]);
 const name=field(round,'Save configuration under a name (optional)','text');
 function config(){return {mode:mode.value,count:+count.value,limit:+limit.value,cooldown:+cool.value,ticker:ticker.value,speed:+speed.value,minimum:+min.value,difficulty:diff.value,
 categories:cats.filter(x=>x.enabled.checked).map(x=>x.c),weights:Object.fromEntries(cats.filter(x=>x.weight.value).map(x=>[x.c,+x.weight.value])),ids:checks.filter(x=>x[1].checked).map(x=>x[0])};}
 button(round,'Save & preview exact form',async()=>{await post('preview',{config:config(),name:name.value});await window.recStaff();});
 for(const p of state.presets)button(round,'Load '+p.name,async()=>{await post('preview',{config:JSON.parse(p.config)});await window.recStaff();});
 if(state.preview){const preview=section(round,'Complete form preview ('+state.preview.length+')');preview.open=true;
 const ol=make('ol');for(const q of state.preview)ol.append(make('li',q.prompt));preview.append(ol);
 if(!state.round)button(round,cfg.mode==='Always Open'?'Activate Always Open':'Open recruitment',async()=>{await post(cfg.mode==='Always Open'?'activate':'open');await window.recStaff();await refresh();});}
 if(state.round)button(round,cfg.mode==='Always Open'?'End Always Open and close applications':'Close applications',async()=>{await post('close');await window.recStaff();await refresh();});
 const edit=section(host,'Question Bank · '+state.bank.length),pick=select(edit,'Question',['Add a new question',...state.bank.map(q=>q.id+' · '+q.prompt)]);
 const prompt=field(edit,'Question','textarea'),cat=select(edit,'Category',state.categories),difficulty=select(edit,'Difficulty',['Basic','Intermediate','Advanced']);
 const criteria=field(edit,'Expected answer criteria','textarea'),rubric=field(edit,'Grading rubric','textarea'),enabled=field(edit,'Enabled','checkbox',true);
 pick.onchange=()=>{const q=state.bank[pick.selectedIndex-1];prompt.value=q?.prompt||'';cat.value=q?.category||state.categories[0];difficulty.value=q?.difficulty||'Basic';criteria.value=q?.criteria||'';rubric.value=q?.rubric||'';enabled.checked=q?.enabled??true;};
 button(edit,'Save question version',async()=>{await post('question',{question:{id:state.bank[pick.selectedIndex-1]?.id,prompt:prompt.value,category:cat.value,difficulty:difficulty.value,criteria:criteria.value,rubric:rubric.value,enabled:enabled.checked}});await window.recStaff();});
 const history=section(host,'Recruitment history & deliveries');
 for(const r of state.history)history.append(make('p','Round '+r.id+' · '+(r.closed?'Closed':'Open')+' · '+r.applications+' applications'));
 for(const d of state.delivery)history.append(make('p','Round '+d.round+' · '+d.state+' · '+d.recipients+' recipients · '+d.attempts+' attempts'));
}
async function detail(host,id){
 const a=await api('?app='+encodeURIComponent(id));host.replaceChildren(make('h3',a.account.name+' · '+a.status),make('p',a.account.email+' · '+a.id),make('p','Overall '+(a.score??'Not Yet Graded')+' · '+a.graded+'/'+a.answers.length+' graded · Recommended minimum '+a.policy.minimum));
 for(const [c,m] of Object.entries(a.categories))host.append(make('p',c+' · '+m.toFixed(1)+'/100'));
 const update=async(type,data)=>{await post(type,{app:id,...data});await detail(host,id);};
 for(const x of a.answers){const g=section(host,x.question.prompt);g.append(make('p',x.answer),make('p',x.evidence),make('p',x.result?x.result.source+' · '+x.result.score+'/100 · '+x.result.grade:'Not Yet Graded'),make('p','Rubric · '+x.question.rubric));
 if(x.result)for(const k of ['strengths','weaknesses','reason','improvement'])if(x.result[k])g.append(make('p',k+' · '+x.result[k]));
 const score=field(g,'Manual score','number',x.result?.score),reason=field(g,'Reason for correction','textarea');
 button(g,'Save manual assessment',()=>update('grade',{qid:x.qid,score:score.value.trim()?Number(score.value):null,detail:reason.value}));
 button(g,'Request fresh AI assessment',()=>update('retry',{qid:x.qid}));}
 const noteField=field(host,'Private staff note','textarea');button(host,'Save private note',()=>update('note',{detail:noteField.value}));
 if(!['Accepted','Rejected'].includes(a.status)){
 const status=select(host,'Application status',['Under Review','Shortlisted','Interview',...(current.user.isOwner?['Accepted','Rejected']:[])]);
 const message=field(host,'Message, interview questions or assessment instructions for applicant','textarea');button(host,'Update applicant',()=>update('status',{status:status.value,detail:message.value}));}
 if(current.user.isOwner&&a.status==='Accepted'){const lvl=select(host,'Appointment level',[1,2,3,4,5,6,7]);button(host,'Appoint administrator',()=>update('appointment',{level:+lvl.value}));}
 const log=section(host,'Review history');for(const e of a.history)log.append(make('p',formatDate(e.created)+' · '+e.event+' · '+e.detail));
}
window.recStaff=async()=>{
 const host=$('cc4-pane-recruitment');host.replaceChildren();
 if(current.user.isOwner)await settings(host);
 const items=await api('?review=1'),box=section(host,'Review & compare applications');box.open=true;
 const search=field(box,'Search by name or application ID','search'),min=field(box,'Minimum score','number'),round=field(box,'Round','number');
 const status=select(box,'Status',['All','Pending','Under Review','Shortlisted','Interview','Accepted','Rejected']);
 const cat=select(box,'Score category',['Overall',...new Set(items.flatMap(x=>Object.keys(x.categories)))]);
 const list=make('div'),reviews=make('div');box.append(list,reviews);
 function display(){list.replaceChildren();for(const a of items){const score=cat.value==='Overall'?a.score:a.categories[cat.value];
 if(!((a.account.name+' '+a.id).toLowerCase().includes(search.value.toLowerCase()))||round.value&&a.round!==+round.value||status.value!=='All'&&a.status!==status.value||min.value&&(score==null||score<+min.value)||cat.value!=='Overall'&&score==null)continue;
 button(list,a.account.name+' · '+a.status+' · '+(score==null?'Not Yet Graded':score.toFixed(1)+'/100'),async()=>{const panel=section(reviews,a.account.name);panel.open=true;const content=make('div');panel.append(content);await detail(content,a.id);});}}
 for(const f of [search,min,round,status,cat])f.oninput=display;display();
};
})();
