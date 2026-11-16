'use strict';

const DEFAULTS={
  mode:'private',prefix:'.',commandReaction:'⚡',statusView:false,statusReact:false,
  statusReactionStyle:'heart',statusEmojiMode:'random',statusEmoji:'❤️',
  statusEmojis:['❤️','🔥','😂','😍','🥰','💯','🙌','😎','💙'],statusExclusions:[],
  autoReply:false,awayEnabled:true,awayAutomatic:true,awayActive:false,updateAlerts:true,
  awayMessage:'I’m currently unavailable. This is an automatic reply from my bot. I’ll respond when I’m back.'
};
const direct=Object.keys(DEFAULTS).filter(key=>!key.startsWith('away')&&key!=='updateAlerts');
const choices={mode:['private','public'],statusReactionStyle:['heart','emoji'],statusEmojiMode:['random','fixed']};
const emojiPattern=/^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u;
const isEmoji=value=>typeof value==='string'&&value.length<=40&&emojiPattern.test(value);
function validate(value,{snapshot=false}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a settings object.');
  const settings={};
  for(const key of Object.keys(DEFAULTS)){
    if(!Object.hasOwn(value,key))continue;
    const v=value[key];
    let valid=false;
    if(Object.hasOwn(choices,key))valid=choices[key].includes(v);
    else if(typeof DEFAULTS[key]==='boolean')valid=typeof v==='boolean';
    else if(key==='prefix')valid=typeof v==='string'&&/^[.!?/#$%&*+~:;=@_-]{1,4}$/.test(v);
    else if(key==='commandReaction')valid=v===''||isEmoji(v);
    else if(key==='statusEmoji')valid=isEmoji(v);
    else if(key==='statusEmojis')valid=Array.isArray(v)&&v.length>0&&v.length<=20&&v.every(isEmoji);
    else if(key==='statusExclusions')valid=Array.isArray(v)&&v.length<=500&&v.every(n=>typeof n==='string'&&/^[1-9]\d{7,14}$/.test(n));
    else if(key==='awayMessage')valid=typeof v==='string'&&!!v.trim()&&v.length<=1000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
    if(valid)settings[key]=Array.isArray(v)?[...new Set(v)]:typeof v==='string'?v.trim():v;
    else if(!snapshot)throw Error('Check the value for '+key+'.');
  }
  if(!snapshot&&Object.keys(settings).length!==Object.keys(value).length)throw Error('Unsupported bot setting.');
  return settings;
}
function read(bot){
  const values=Object.fromEntries(direct.map(key=>[key,bot.db.get(key,DEFAULTS[key])]));
  const away=bot.away.state();
  return validate({...values,awayEnabled:away.enabled,awayAutomatic:away.automatic,
    awayActive:away.active,awayMessage:away.message,updateAlerts:bot.portalUpdates.preference()},{snapshot:true});
}
function apply(bot,{revision,patch}){
  if(bot.db.get('portal.settingsRevision')===revision)return;
  const changes=validate(patch);
  for(const key of direct)if(Object.hasOwn(changes,key))bot.db.set(key,changes[key]);
  const away=bot.away.state();
  if(Object.hasOwn(changes,'awayEnabled')&&changes.awayEnabled!==away.enabled)bot.away.enable(changes.awayEnabled);
  if(Object.hasOwn(changes,'awayAutomatic')&&changes.awayAutomatic!==away.automatic)bot.away.automatic(changes.awayAutomatic);
  if(Object.hasOwn(changes,'awayActive')){
    if(changes.awayActive)bot.away.setAway();
    else bot.away.back();
  }
  if(Object.hasOwn(changes,'awayMessage'))bot.away.setMessage(changes.awayMessage);
  if(Object.hasOwn(changes,'updateAlerts'))bot.portalUpdates.setPreference(changes.updateAlerts);
  bot.db.set('portal.settingsRevision',revision);
}

const groupId=value=>typeof value==='string'&&/^\d{5,30}(?:-\d{5,30})?@g\.us$/.test(value);
function groupOptions(value){
  if(!value||typeof value!=='object'||typeof value.welcome!=='boolean'||typeof value.goodbye!=='boolean'||
    typeof value.rules!=='string'||value.rules.length>1500)throw Error('Check the group settings.');
  return {welcome:value.welcome,goodbye:value.goodbye,rules:value.rules.trim()};
}
module.exports={DEFAULTS,validate,read,apply,groupId,groupOptions};
