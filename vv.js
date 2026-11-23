'use strict';
const {jidNormalizedUser}=require('@whiskeysockets/baileys');
const W=['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension',
  'documentWithCaptionMessage','editedMessage','deviceSentMessage','ephemeralMessage'];
const TTL=30*60*1000;
const CACHE=new Map();
const nj=j=>jidNormalizedUser(String(j||''));
const TYPES=['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
function unwrap(m,d=0){while(m&&d++<8){const k=W.find(x=>m[x]?.message);if(!k)return m;m=m[k].message;}return m||null;}
function mediaOf(m){const c=unwrap(m);if(!c)return null;const k=TYPES.find(t=>c[t]);return k?{kind:k,node:c[k],content:c}:null;}
function ci(ctx){
  const c=unwrap((ctx.msg||ctx.message)?.message);
  for(const i of Object.values(c||{}))if(i?.contextInfo?.quotedMessage)return i.contextInfo;
  return null;
}
/* Store the whole message, unwrapped, so forwarding sends normal media. */
function remember(m){
  try{
    if(!m?.key?.id||!m.key.remoteJid)return;
    const hit=mediaOf(m.message);
    if(!hit)return;
    const content={...hit.content};
    content[hit.kind]={...hit.node,viewOnce:false,isViewOnce:false};
    CACHE.set(m.key.remoteJid+'|'+m.key.id,{key:m.key,message:content,at:Date.now()});
    if(CACHE.size>200)for(const [k,v] of CACHE)if(Date.now()-v.at>TTL)CACHE.delete(k);
  }catch{}
}
function rememberMany(args){
  for(const a of args){
    if(Array.isArray(a)){for(const m of a)remember(m);continue;}
    if(a&&typeof a==='object'&&a.message&&a.key)remember(a);
  }
}
function resolve(ctx){
  const info=ci(ctx);
  const chat=(ctx.msg||ctx.message)?.key?.remoteJid;
  if(info?.stanzaId&&chat){
    const hit=CACHE.get(chat+'|'+info.stanzaId);
    if(hit&&Date.now()-hit.at<TTL)return{msg:hit,src:'id'};
  }
  if(info?.quotedMessage&&chat){
    const hit=mediaOf(info.quotedMessage);
    if(hit){
      const content={...hit.content};
      content[hit.kind]={...hit.node,viewOnce:false,isViewOnce:false};
      return{msg:{key:{remoteJid:chat,id:info.stanzaId,fromMe:false,participant:info.participant},message:content},src:'quote'};
    }
  }
  if(chat){
    for(const [k,v] of CACHE)if(k.startsWith(chat+'|')&&Date.now()-v.at<TTL)return{msg:v,src:'latest'};
  }
  return null;
}
async function targets(ctx){
  const k=(ctx.msg||ctx.message)?.key;
  const cand=[ctx.senderPn,k?.senderPn,ctx.sender,k?.participant,ctx.participantPn];
  const s=cand.filter(v=>typeof v==='string'&&v.includes('@')).map(nj)
    .find(v=>/^\d+@(s\.whatsapp\.net|lid)$/.test(v));
  if(!s)return[];
  if(!s.endsWith('@lid'))return[s];
  const map=ctx.sock?.signalRepository?.lidMapping;
  if(typeof map?.getPNForLID==='function'){
    try{const pn=nj(await map.getPNForLID(s));if(/^\d+@s\.whatsapp\.net$/.test(pn))return[pn,s];}catch{}
  }
  return[s];
}
function diag(ctx){
  const s=ctx.sock,info=ci(ctx);
  return `hook=${s?.__vvHooked?'y':'n'} wrap=${s?.__vvWrap?'y':'n'} cache=${CACHE.size} id=${info?.stanzaId?'y':'n'}`;
}
async function forwardAvailableMedia(ctx,args=[]){
  try{
    const on=()=>ctx.db.get('feature.vv',true);
    if(args.length)return{ok:false,message:'Reply to media with .vv.'};
    if(!on())return{ok:false,message:'.vv is disabled.'};
    const found=resolve(ctx);
    if(!found)return{ok:false,message:`Nothing to send. ${diag(ctx)}`};
    const node=mediaOf(found.msg.message);
    if(node&&!node.node.directPath&&!node.node.url&&node.node.mediaKey){
      try{
        const up=await ctx.sock.updateMediaMessage(found.msg);
        if(up?.message)found.msg={key:found.msg.key,message:up.message};
      }catch{}
    }
    const dest=await targets(ctx);
    if(!dest.length)return{ok:false,message:'I could not identify your private chat.'};
    let last;
    for(const to of dest){
      try{await ctx.sock.sendMessage(to,{forward:found.msg});return{ok:true,sent:true,to,src:found.src};}
      catch(e){last=e;ctx.logger?.warn?.({code:e?.message},'forward failed');}
    }
    return{ok:false,message:`Forward failed (${last?.message||'unknown'}). ${diag(ctx)}`};
  }catch(e){
    ctx?.logger?.warn?.({code:e?.message},'vv failed');
    return{ok:false,message:`vv failed (${e?.message||'unknown'}). ${diag(ctx)}`};
  }
}
module.exports={forwardAvailableMedia,remember,rememberMany,diag};
