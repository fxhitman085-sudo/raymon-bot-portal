const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const ADMIN='+2348059692394';
const INVITE='JaMqtr0NIYAFAIBRBORrMs';
const phone=value=>typeof value==='string'&&/^\+[1-9][0-9]{7,14}$/.test(value);
const pn=value=>typeof value==='string'&&value.endsWith('@s.whatsapp.net')?value.split('@')[0].split(':')[0]:null;

function init(store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS community_additions (
    phone TEXT PRIMARY KEY, outcome TEXT NOT NULL, attempted INTEGER NOT NULL
  )`);
}
function task(store,d){
  if(d.phone!==ADMIN||!d.linked||d.intent!=='run')return null;
  return store.get(`SELECT v.phone FROM verified_numbers v JOIN users u ON u.id=v.user_id
    JOIN portal_profiles p ON p.user_id=u.id
    WHERE u.banned=0 AND p.closed_at IS NULL AND v.phone<>?
    AND NOT EXISTS (SELECT 1 FROM community_additions a WHERE a.phone=v.phone)
    ORDER BY v.phone LIMIT 1`,ADMIN)||null;
}
function report(store,d,r,now){
  const result=r.community;
  if(d.phone!==ADMIN||!d.linked||r.status!=='online'||!phone(result?.phone)||
    !['added','already_member','skipped','unknown'].includes(result.outcome))return;
  if(!store.get('SELECT 1 FROM verified_numbers WHERE phone=?',result.phone))return;
  store.run('INSERT OR IGNORE INTO community_additions VALUES (?,?,?)',result.phone,result.outcome,now);
}

const releases=require('./public-releases.json');
const internal=/\b(admin(?:istrat(?:or|ive|ion))?s?|owners?|founders?|staff|privileged)\b/i;
function publicCaption(release){
  const lines=release.changes.filter(c=>c.audience==='public'&&typeof c.summary==='string'&&!internal.test(c.summary)).map(c=>c.summary.trim()).filter(Boolean);
  return lines.length?'⚡ RAYMON BOT Update\n\n'+lines.join('\n'):null;
}
async function announce(entry,active){
  const bot=entry.bot,sock=bot.sock;
  const valid=()=>active()&&bot.sock===sock;
  for(const release of releases){
    const caption=publicCaption(release);
    if(!caption||!valid())continue;
    const dir=path.join(this.root,'release-history');
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const marker=path.join(dir,createHash('sha256').update(INVITE+':'+release.id).digest('hex'));
    try{await fs.access(marker);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
    const info=await sock.groupGetInviteInfo(INVITE);
    if(!valid()||!info?.id?.endsWith('@g.us'))return;
    const group=await sock.groupMetadata(info.id);
    const ids=group.participants?.map(p=>p.id||p.lid||p.phoneNumber);
    if(!ids?.length||ids.some(id=>!id)||!valid())return;
    const image=await fs.readFile(path.join(__dirname,'bot-runtime/assets/announcements.jpg'));
    if(!valid())return;
    try{await fs.writeFile(marker,'claimed',{flag:'wx',mode:0o600,flush:true});}
    catch(e){if(e.code==='EEXIST')continue;throw e;}
    if(!valid()){await fs.unlink(marker);return;}
    await sock.sendMessage(group.id,{image,caption,mentions:[...new Set(ids)]});
  }
}

class Community {
  constructor({root,clock=Date.now}){this.root=path.join(root,'community-additions');this.clock=clock;this.next=0;this.running=null;}
  run(entry,active){
    if(entry.task.phone===ADMIN&&active()&&!this.announcing&&this.clock()>=(this.nextAnnouncement||0)){
      this.nextAnnouncement=this.clock()+60000;
      this.announcing=announce.call(this,entry,active).catch(()=>console.warn('Community release announcement could not complete.')).finally(()=>{this.announcing=null;});
    }
    const candidate=entry.task.community;
    if(entry.task.phone!==ADMIN||!phone(candidate?.phone)||candidate.phone===ADMIN||
      entry.communityResult?.phone===candidate.phone||this.running||this.clock()<this.next||!active())return;
    this.next=this.clock()+30_000;
    this.running=this.attempt(entry,candidate.phone,active).catch(()=>{
      // Metadata or storage failure: no addition is attempted; try after the cooldown.
      console.warn('Community addition paused: check group access and persistent storage.');
    }).finally(()=>{this.running=null;});
  }
  async attempt(entry,target,active){
    const sock=entry.bot.sock;
    const valid=()=>active()&&sock===entry.bot.sock;
    const marker=path.join(this.root,createHash('sha256').update(INVITE+':'+target).digest('hex')+'.json');
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    try{
      const saved=JSON.parse(await fs.readFile(marker,'utf8'));
      entry.communityResult={phone:target,outcome:saved.outcome||'unknown'};
      return;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(!valid())return;
    const info=await sock.groupGetInviteInfo(INVITE);
    if(!valid()||!/^\d+(?:-\d+)?@g\.us$/.test(info?.id||''))return;
    const group=await sock.groupMetadata(info.id);
    if(!valid())return;
    const aliases=new Set([sock.user?.id,sock.user?.lid,entry.bot.authState?.creds?.me?.lid]
      .filter(Boolean).map(id=>id.replace(/:\d+@/,'@')));
    const ids=p=>[p.id,p.lid,p.phoneNumber,p.jid].filter(Boolean);
    if(!group.participants?.some(p=>['admin','superadmin'].includes(p.admin)&&
      ids(p).some(id=>aliases.has(id.replace(/:\d+@/,'@')))))return;
    let outcome=group.participants.some(p=>ids(p).some(id=>pn(id)===target.slice(1)))?'already_member':'unknown';
    // Persist BEFORE the network action. An interrupted/ambiguous attempt is never replayed.
    let file;
    try{file=await fs.open(marker,'wx',0o600);}catch(error){if(error.code==='EEXIST')return;throw error;}
    try{await file.writeFile(JSON.stringify({outcome}));await file.sync();}finally{await file.close();}
    const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}
    if(outcome==='unknown'&&valid()){
      try{
        const result=await sock.groupParticipantsUpdate(group.id,[target.slice(1)+'@s.whatsapp.net'],'add');
        const status=String(result?.[0]?.status||'');
        outcome=status==='200'?'added':status?'skipped':'unknown';
      }catch{outcome='unknown';}
    }
    // The original durable marker is sufficient even if saving the final result fails.
    entry.communityResult={phone:target,outcome};

  }
}
module.exports={ADMIN,INVITE,init,task,report,Community};
