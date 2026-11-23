'use strict';
const {downloadContentFromMessage,jidNormalizedUser}=require('@whiskeysockets/baileys');
const W=['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension',
  'documentWithCaptionMessage','editedMessage','deviceSentMessage','ephemeralMessage'];
const MAX=16*1024*1024;
const TTL=30*60*1000;
const CACHE=new Map();
const nj=j=>jidNormalizedUser(String(j||''));
function code(e){const c=e?.code||e?.name;return typeof c==='string'&&/^[A-Za-z0-9_]{1,40}$/.test(c)?c:'MEDIA_ERROR';}
function unwrap(m,d=0){while(m&&d++<8){const k=W.find(x=>m[x]?.message);if(!k)return m;m=m[k].message;}return m||null;}
function pick(m){
  const c=unwrap(m);if(!c)return null;
  const vo=Object.values(c).some(i=>i?.viewOnce||i?.isViewOnce);
  for(const t of ['image','video','document','sticker','audio']){
    const i=c[t+'Message'];
    if(i)return{type:t,message:i,viewOnce:!!i.viewOnce||vo};
  }
  return null;
}
function ci(ctx){
  const c=unwrap((ctx.msg||ctx.message)?.message);
  for(const i of Object.values(c||{}))if(i?.contextInfo?.quotedMessage)return i.contextInfo;
  return null;
}
/* Walk nested quotes: user may reply to the bot's reply instead of the media. */
function findQuoted(ctx){
  const info=ci(ctx);
  if(!info)return null;
  let node=info.quotedMessage;
  for(let i=0;i<3&&node;i++){
    const hit=pick(node);
    if(hit)return hit;
    const c=unwrap(node);
    node=Object.values(c||{}).find(v=>v?.contextInfo?.quotedMessage)?.contextInfo?.quotedMessage||null;
  }
  return null;
}
/* Cache the real media the instant it lands, before the quote copy goes stale. */
function remember(m){
  try{
    if(!m?.key?.id||!m.key.remoteJid)return;
    const media=pick(m.message);
    if(!media||!media.viewOnce)return;
    CACHE.set(m.key.remoteJid+'|'+m.key.id,{media,at:Date.now()});
    if(CACHE.size>300)for(const [k,v] of CACHE)if(Date.now()-v.at>TTL)CACHE.delete(k);
  }catch{}
}
function resolve(ctx){
  const info=ci(ctx);
  const chat=(ctx.msg||ctx.message)?.key?.remoteJid;
  if(info?.stanzaId&&chat){
    const hit=CACHE.get(chat+'|'+info.stanzaId);
    if(hit&&Date.now()-hit.at<TTL)return hit.media;
  }
  return findQuoted(ctx);
}
async function targets(ctx){
  const k=(ctx.msg||ctx.message)?.key;
  const cand=[ctx.senderPn,k?.senderPn,ctx.sender,k?.participant,ctx.participantPn];
  if(k?.fromMe===true)cand.push(ctx.sock?.user?.id);
  const s=cand.filter(v=>typeof v==='string'&&v.includes('@')).map(nj)
    .find(v=>/^\d+@(s\.whatsapp\.net|lid)$/.test(v));
  if(!s)return[];
  if(!s.endsWith('@lid'))return[s];
  const map=ctx.sock?.signalRepository?.lidMapping;
  if(typeof map?.getPNForLID==='function'){
    try{
      const pn=nj(await map.getPNForLID(s));
      if(/^\d+@s\.whatsapp\.net$/.test(pn))return[pn,s];
    }catch{}
  }
  return[s];
}
function payload(m,d){
  const{message:x,type:t,viewOnce}=m;
  const cap=`⚡ RAYMON BOT • Requested media${viewOnce?' • view once':''}`;
  const mt=x.mimetype;
  if(t==='image')return{image:d,mimetype:mt||'image/jpeg',caption:cap};
  if(t==='video')return{video:d,mimetype:mt||'video/mp4',gifPlayback:!!x.gifPlayback,caption:cap};
  if(t==='document')return{document:d,mimetype:mt||'application/octet-stream',fileName:x.fileName||'file',caption:cap};
  if(t==='sticker')return{sticker:d,mimetype:mt||'image/webp'};
  if(t==='audio')return{audio:d,mimetype:mt||'audio/ogg; codecs=opus',ptt:!!x.ptt,...(Number.isFinite(x.seconds)?{seconds:x.seconds}:{})};
  return null;
}
async function read(stream,limit){
  const c=[];let n=0;
  try{
    for await(const b of stream){
      const buf=Buffer.isBuffer(b)?b:Buffer.from(b);
      n+=buf.length;
      if(n>limit)throw Object.assign(new Error('too large'),{code:'MEDIA_TOO_LARGE'});
      c.push(buf);
    }
    return Buffer.concat(c,n);
  }finally{stream.destroy?.();}
}
async function forwardAvailableMedia(ctx,args=[]){
  let phase='resolve';
  try{
    const on=()=>ctx.db.get('feature.vv',true);
    if(args.length)return{ok:false,message:'Reply to media with .vv.'};
    if(!on())return{ok:false,message:'.vv is disabled.'};
    const media=resolve(ctx);
    if(!media)return{ok:false,message:'Reply to a photo, video, document, sticker or voice note with .vv.'};
    if(!media.message.mediaKey||!(media.message.directPath||media.message.url))
      return{ok:false,message:'That media arrived before the bot cached it. Send it again and reply within 30 minutes.'};
    const cfg=ctx.config?.maxMediaBytes;
    const limit=Number.isSafeInteger(cfg)&&cfg>0?cfg:MAX;
    const dest=await targets(ctx);
    if(!dest.length)return{ok:false,message:'I could not identify your private chat.'};
    phase='download';
    const t=media.type==='sticker'?'image':media.type;
    const data=await read(await downloadContentFromMessage(media.message,t),limit);
    if(!data.length)return{ok:false,message:'Download returned no usable media.'};
    phase='send';
    const body=payload(media,data);
    if(!body)return{ok:false,message:'Unsupported media type.'};
    let last;
    for(const to of dest){
      if(!on())return{ok:false,message:'.vv was disabled. Delivery cancelled.'};
      try{await ctx.sock.sendMessage(to,body);return{ok:true,sent:true,to};}
      catch(e){last=e;ctx.logger?.warn?.({phase,code:code(e)},'Private media delivery failed');}
    }
    return{ok:false,message:`Private delivery failed (${code(last)}).`};
  }catch(e){
    ctx?.logger?.warn?.({phase,code:code(e)},'Media command failed');
    return{ok:false,message:`Media command failed during ${phase} (${code(e)}).`};
  }
}
module.exports={forwardAvailableMedia,remember};
