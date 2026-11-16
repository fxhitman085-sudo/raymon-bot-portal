'use strict';

const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {gzipSync,gunzipSync}=require('node:zlib');

const portal=path.resolve(__dirname,'..');
const source=process.argv[2];
if(!source)throw Error('Pass the path to the RAYMON BOT checkout.');
const git=(...args)=>execFileSync('git',['-C',source,...args],{maxBuffer:32*1024*1024});
const commit=git('rev-parse','HEAD').toString().trim();
const label=path.join(portal,'bot-runtime-version.json');
if(fs.existsSync(label)&&JSON.parse(fs.readFileSync(label)).commit===commit){
  console.log('The portal already includes '+commit);
  process.exit(0);
}

const runtimePackage=JSON.parse(git('show',commit+':package.json'));
const portalPackage=JSON.parse(fs.readFileSync(path.join(portal,'package.json')));
for(const [name,version] of Object.entries(runtimePackage.dependencies||{})){
  if(portalPackage.dependencies[name]!==version){
    throw Error('Update the portal dependency and lockfile for '+name+' before importing '+commit);
  }
}

const include=['config.js','commands','lib','assets','releases'];
const fileNames=[];
for(const entry of git('ls-tree','-r','-z',commit,'--',...include).toString().split('\0').filter(Boolean)){
  const tab=entry.indexOf('\t');
  const [mode,type]=entry.slice(0,tab).split(' ');
  const file=entry.slice(tab+1);
  if(!['100644','100755'].includes(mode)||type!=='blob')throw Error('Unexpected entry in runtime source: '+file);
  if(/(?:^|\/)\./.test(file)||!/^[-a-zA-Z0-9_./]+$/.test(file))throw Error('Unexpected runtime file name: '+file);
  if(file==='config.js'||/^(?:commands|lib)\/.*\.(?:js|cjs|mjs|json)$/.test(file)||
      /^releases\/.*\.json$/.test(file)||/^assets\/.*\.(?:png|jpe?g|gif|webp|mp4|svg|ttf|woff2)$/i.test(file))fileNames.push(file);
}
for(const file of ['config.js','lib/bot.js','lib/database.js','lib/updates.js','releases/current.json','assets/announcements.jpg']){
  if(!fileNames.includes(file))throw Error('Bot checkout is missing '+file);
}
const archive=gzipSync(git('archive','--format=tar',commit,'--',...fileNames),{level:9});
if(!gunzipSync(archive).length)throw Error('Runtime archive was empty.');
fs.writeFileSync(path.join(portal,'bot-runtime.tar.gz'),archive);
fs.writeFileSync(label,JSON.stringify({repository:'variefx-alt/raymon-whatsapp-bot',commit},null,2)+'\n');
console.log('Packaged RAYMON BOT source at '+commit);
