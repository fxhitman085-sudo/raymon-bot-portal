'use strict';
const {randomUUID}=require('node:crypto');

const diagnoses={
  pair_no_code:{severity:'warning',title:'Pairing code not generated',
    description:'WhatsApp did not deliver a code before the worker timeout.',
    steps:['Confirm the country code and full WhatsApp number.','Check that the worker is online.','Retry only after the previous request has ended.'],action:'retry'},
  pair_failed:{severity:'warning',title:'Pairing attempt failed',
    description:'WhatsApp rejected or interrupted the link attempt.',
    steps:['Make sure the WhatsApp app is available on the phone.','Wait for the current attempt to finish.','Generate a fresh code without clearing any unrelated sessions.'],action:'retry'},
  needs_pairing:{severity:'warning',title:'WhatsApp needs re-linking',
    description:'The saved session can no longer authenticate.',
    steps:['Open WhatsApp linked devices on your phone.','Start a new pairing attempt only for this bot.','Contact support if this happens repeatedly.'],action:'relink'},
  expired:{severity:'info',title:'Pairing request expired',
    description:'The previous code is no longer usable.',
    steps:['Confirm your number.','Request another pairing code after the cooldown.'],action:'retry'},
  low_balance:{severity:'warning',title:'Insufficient hosting coins',
    description:'Your prepaid bot access has expired.',
    steps:['Check your wallet balance and maintenance rate.','Add enough coins to renew before resuming the bot.'],action:'wallet'},
  reconnecting:{severity:'info',title:'Reconnecting to WhatsApp',
    description:'The worker is attempting to restore your existing valid session.',
    steps:['Avoid repeatedly restarting the bot.','Check the worker status and latest connection event.','Open a support ticket if reconnection continues to fail.'],action:'none'},
  online:{severity:'ok',title:'Connected',
    description:'The bot has recently reported a connected WhatsApp session.',
    steps:['No action is required.'],action:'none'},
  paused:{severity:'info',title:'Bot paused',
    description:'Bot activity was paused by the user or administrator.',
    steps:['Select Resume when you are ready to run it again.'],action:'resume'},
  default:{severity:'info',title:'Checking connection',
    description:'The bot is being prepared or awaits a valid pairing action.',
    steps:['Use the on-screen pairing instructions.','If there is no response, check again after the worker status refreshes.'],action:'none'}
};
class Diagnostics {
  constructor(store,ErrorType){this.s=store;this.Error=ErrorType;}
  report(userId,id){
    this.s.requireActive(userId);
    const bot=this.s.deployment(userId,id);
    if(!bot)this.fail(404,'Bot not found.');
    const now=this.s.clock(),state=this.s.state(bot,this.s.user(userId),now),
      alive=this.s.workerSeen!==null&&this.s.workerSeen+15000>now;
    const preset=alive?(diagnoses[state]||diagnoses.default):{
      severity:'warning',title:'Pairing worker unavailable',
      description:'The website has not received a fresh heartbeat from the pairing worker.',
      steps:['Do not delete or reset the saved WhatsApp authentication session.','Check the portal status again shortly.','Contact support if worker connectivity does not recover.'],action:'none'
    };
    const code=this.s.codes.get(bot.id);
    const stalled=bot.intent==='pair'&&bot.pair_until>now&&!code&&bot.requested+75000<now;
    const finding=stalled&&alive?diagnoses.pair_no_code:preset;
    const events=this.s.all('SELECT title,description,created FROM portal_events WHERE user_id=? AND deployment_id=? ORDER BY created DESC LIMIT 12',userId,id);
    const reference='BOT-'+bot.id.slice(0,8).toUpperCase();
    return {reference,state,workerAvailable:alive,linked:!!bot.linked,reportTime:now,
      issue:finding,events,canRetry:!bot.linked&&!['queued','awaiting_code','connecting'].includes(state)&&bot.requested+45000<now,
      expires:bot.pair_until>now?bot.pair_until:null};
  }
  fleet(actor){
    this.s.v3.permit(actor,'diagnostics.view');
    const now=this.s.clock();
    const states=this.s.all("SELECT state,COUNT(*) AS count FROM deployments WHERE state<>'cancelled' GROUP BY state");
    const problems=this.s.all("SELECT d.id,d.user_id,d.state,d.last_seen,u.email FROM deployments d JOIN users u ON u.id=d.user_id WHERE d.state IN ('pair_failed','pair_no_code','needs_pairing') ORDER BY d.requested DESC LIMIT 30");
    return {workerAvailable:this.s.workerSeen!==null&&this.s.workerSeen+15000>now,states,problems,checked:now};
  }
  fail(status,message){throw new this.Error(status,message);}
}
module.exports={Diagnostics};
