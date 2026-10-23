import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,writeJson,httpRequest,sleep,isMain} from './common.mjs';
import {networksFromInventory,sendWake} from './power-network.mjs';
const exec=promisify(execFile);
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts');
const env={...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp',PSModuleAnalysisCachePath:'D:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
export class PowerAgent {
 constructor(configFile){this.configFile=configFile;this.config=readJson(configFile);this.dir=path.join(this.config.dataDir,'power');fs.mkdirSync(this.dir,{recursive:true});this.mode=this.local('policy.json',{mode:'available'}).mode;this.busy=false;this.nextScan=0;this.inventory={adapters:[],errors:['Detection pending']};this.networks=[];}
 api(route,options={}){return httpRequest(this.config.hubUrl,route,{token:this.config.nodeToken,sitesToken:this.config.sitesToken,proxy:this.config.proxyUrl,timeout:12000,...options});}
 local(name,fallback=null){try{return readJson(path.join(this.dir,name));}catch{return fallback;}}
 lease(){writeJson(path.join(this.dir,'lease.json'),{expires:new Date(Date.now()+45000).toISOString(),mode:this.mode,busy:this.busy});}
 guard(){
  if(this.child&&this.child.exitCode===null)return;
  this.child=spawn(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scripts,'Keep-FleetAwake.ps1'),'-LeaseFile',path.join(this.dir,'lease.json'),'-StatusFile',path.join(this.dir,'guard.json'),'-OwnerProcessId',String(process.pid)],{env,windowsHide:true,stdio:'ignore'});
  this.child.on('error',()=>{this.child=null;});
  this.child.unref();
 }
 async inspect(){
  const {stdout}=await exec(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scripts,'Inspect-FleetPower.ps1'),'-Configure'],{env,windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  const value=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());this.inventory=value;this.networks=networksFromInventory(value);writeJson(path.join(this.dir,'inventory.json'),value);
 }
 async action(action){
  if(!/^[\w-]{1,100}$/.test(action.id)||(Number.isFinite(action.expiresInMs)?action.expiresInMs<=0:Date.parse(action.expiresAt)<Date.now()))return;
  const file=path.join(this.dir,'action-'+action.id+'.json');let receipt=this.local('action-'+action.id+'.json');
  if(!receipt){
   // Magic packets are non-destructive and bounded. Persist before emission;
   // an ambiguous restart is reported, never silently treated as a wake.
   receipt={id:action.id,status:'uncertain',detail:'Wake emission interrupted before acknowledgement',evidence:[]};writeJson(file,receipt);
   try{receipt={id:action.id,status:'sent',detail:'已发送局域网唤醒包，等待目标重新连接。',evidence:await sendWake(action,this.networks)};}
   catch(e){receipt={id:action.id,status:'failed',detail:String(e.message).slice(0,400),evidence:[]};}
   writeJson(file,receipt);
  }
  await this.api('/v1/power/actions/'+action.id+'/ack',{method:'POST',body:receipt});
 }
 async start(){
  this.inventory=this.local('inventory.json',this.inventory);this.networks=networksFromInventory(this.inventory);
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const leaseTimer=setInterval(()=>{if(!stopping){this.lease();this.guard();}},10000);this.lease();this.guard();
  try{while(!stopping&&!fs.existsSync(path.join(this.dir,'stop.request'))){
   try{
    if(Date.now()>=this.nextScan){this.nextScan=Date.now()+10*60000;try{await this.inspect();}catch(e){this.inventory={...this.inventory,errors:[String(e.message).slice(0,500)]};}}
    const guard=this.local('guard.json',{});
    // Relative age survives a host clock differing from the cloud clock.
    const guardAge=Date.now()-Date.parse(guard.at);
    guard.ageMs=Number.isFinite(guardAge)?Math.max(0,guardAge):120000;
    const report={version:'0.1.0',inventory:this.inventory,networks:this.networks,guard};
    const requestedAt=Date.now(),response=await this.api('/v1/power/poll',{method:'POST',body:report});
    this.mode=response.policy.mode;this.busy=response.busy;writeJson(path.join(this.dir,'policy.json'),response.policy);this.lease();
    for(const action of response.actions||[])await this.action({...action,...(Number.isFinite(action.expiresInMs)?{expiresInMs:action.expiresInMs-(Date.now()-requestedAt)}:{})});
    writeJson(path.join(this.dir,'status.json'),{at:new Date().toISOString(),online:true,mode:this.mode,guard,networks:this.networks.length});
   }catch(e){if([401,403].includes(e.status)){this.mode='off';this.lease();}writeJson(path.join(this.dir,'status.json'),{at:new Date().toISOString(),online:false,error:String(e.message).slice(0,400)});}
   await sleep(10000);
  }}finally{clearInterval(leaseTimer);this.mode='off';this.lease();this.child?.kill();}
 }
}
if(isMain(import.meta.url)){const i=process.argv.indexOf('--config');if(i<0)throw Error('Configuration path required');await new PowerAgent(process.argv[i+1]).start();}
