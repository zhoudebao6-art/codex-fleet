import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {VERSION,assert,fileHash,mkdir,now,readJson,safeUrl,within,writeJson} from './common.mjs';
import {upgradeFailure} from './upgrade-diagnostics.mjs';

const KEY='node-action:',TERMINAL=new Set(['completed','failed']),CHUNK=1024*1024;
const actionId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const text=value=>typeof value==='string'?value.slice(0,400):'';
export function validateUpgradeAction(action,nodeId){
  assert(action&&actionId(action.id)&&action.nodeId===nodeId&&action.action==='upgrade','Unsupported node maintenance action');
  for(const key of ['url','command','path','installDir','script','args'])assert(!Object.hasOwn(action,key),'Maintenance actions cannot supply execution paths or commands');
  const i=action.installer;assert(i&&/^[a-f0-9]{64}$/.test(i.sha256)&&Number.isSafeInteger(i.size)&&i.size>0&&i.size<=1024*1024*1024,'Invalid registered installer integrity metadata');
  assert(/^\d+\.\d+\.\d+$/.test(i.version)&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.zip$/.test(i.name)&&/^[a-zA-Z0-9_-]{1,100}$/.test(i.project),'Invalid registered installer metadata');
  for(const key of ['url','downloadUrl','path','command','script','args'])assert(!Object.hasOwn(i,key),'Installer cannot supply a URL or execution path');
  const downloadPath=`/v1/files/${i.sha256}?project=${encodeURIComponent(i.project)}`;
  assert(action.downloadPath===downloadPath,'Installer download must use the registered same-hub file route');
  return {id:action.id,nodeId,action:'upgrade',installer:{sha256:i.sha256,size:i.size,version:i.version,name:i.name,project:i.project},downloadPath};
}

function installation(configFile){
  if(process.platform!=='win32'||typeof configFile!=='string'||!configFile)return null;
  const root=path.dirname(path.dirname(path.resolve(configFile))),expected=path.join(root,'config','node.json');
  if(path.resolve(configFile).toLowerCase()!==expected.toLowerCase()||path.resolve(fileURLToPath(import.meta.url)).toLowerCase()!==path.join(root,'app','src','node-updater.mjs').toLowerCase())return null;
  for(const part of ['app/scripts/Update-Fleet.ps1','runtime/node.exe'])if(!fs.existsSync(path.join(root,part)))return null;
  return {root};
}

export function launchUpgradeQueue(record,root,dataDir){
  const logDir=mkdir(path.join(dataDir,'upgrades')),prefix=within(logDir,record.id+'.launcher');
  const out=fs.openSync(prefix+'.out.log','a',0o600),err=fs.openSync(prefix+'.err.log','a',0o600);
  const env={...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp',PSModuleAnalysisCachePath:'D:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
  const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const launchStatus=(state,extra={})=>{try{writeJson(prefix+'.json',{actionId:record.id,packageSha256:record.action.installer.sha256,state,at:now(),...extra});}catch{/* The queue receipt remains the authoritative launch confirmation. */}};
  return new Promise((resolve,reject)=>{
    // DETACHED_PROCESS makes Windows PowerShell 5.1 exit successfully without
    // executing -File on affected hosts. Keep this short verifier attached;
    // the verified Queue script starts its own hidden, independent updater.
    let child;try{child=spawn(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'app','scripts','Update-Fleet.ps1'),'-PackagePath',record.file,'-Sha256',record.action.installer.sha256,'-ExpectedVersion',record.action.installer.version,'-InstallDir',root,'-ActionId',record.id,'-Queue'],{env,windowsHide:true,detached:false,stdio:['ignore',out,err]});}catch(e){fs.closeSync(out);fs.closeSync(err);launchStatus('error');reject(e);return;}
    child.once('error',e=>{launchStatus('error',{pid:child.pid||null});reject(e);});
    child.once('spawn',()=>{launchStatus('started',{pid:child.pid});child.unref();resolve({pid:child.pid});});
    child.once('exit',(code,signal)=>launchStatus('exited',{pid:child.pid,code,signal}));
    fs.closeSync(out);fs.closeSync(err);
  });
}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}

// This maintenance channel never creates a model turn or changes its permissions.
// It accepts one narrowly scoped administrator action, independently of task tools.
export class NodeUpdater {
  constructor(worker,options={}){this.worker=worker;this.store=worker.store;this.installed=options.installation||installation(worker.configFile);this.version=options.version||VERSION;this.launch=options.launch||launchUpgradeQueue;this.pollAt=0;this.clock=options.clock||Date.now;this.enabled=!!this.installed&&worker.config.selfUpgrade!==false;}
  records(){return this.store.db.prepare("SELECT value FROM metadata WHERE key LIKE 'node-action:%' ORDER BY rowid").all().map(r=>JSON.parse(r.value));}
  save(record,patch={}){Object.assign(record,patch,{updatedAt:now()});this.store.put(KEY+record.id,record);return record;}
  transition(record,status,detail){return this.save(record,{status,detail,ackPending:true,ackRetryAt:0});}
  summary(){const r=this.records().at(-1);return {enabled:this.enabled,...(r?{id:r.id,status:r.status,bytes:r.bytes||0,size:r.action?.installer?.size||0,version:r.action?.installer?.version,detail:r.detail,updatedAt:r.updatedAt}:{}),...(this.error?{error:this.error}:{})};}
  async ack(record){
    if(!record.ackPending||this.clock()<(record.ackRetryAt||0))return;
    const status=record.status==='launching'?'waiting':record.status,body={status,bytes:record.bytes||0,detail:text(record.detail)};
    if(record.action?.installer){body.packageSha256=record.action.installer.sha256;body.version=record.action.installer.version;}
    try{await this.worker.api(`/v1/node/actions/${encodeURIComponent(record.id)}/ack`,{method:'POST',body,timeout:5000});this.save(record,{ackPending:false,ackFailures:0});}
    catch(e){if([404,409,410,422].includes(e.status)){this.save(record,{ackPending:false,ackError:'The server no longer accepts this action status.'});return;}const n=(record.ackFailures||0)+1;this.save(record,{ackFailures:n,ackRetryAt:this.clock()+Math.min(120000,1000*2**Math.min(n,7))});}
  }
  reconcile(record){
    if(!['launching','waiting','installing'].includes(record.status))return;
    const dir=path.join(this.worker.config.dataDir,'upgrades'),statusFile=path.join(dir,record.id+'.status.json'),queueFile=path.join(dir,record.id+'.queued.json');
    let status,queue,launcher;try{if(fs.existsSync(statusFile))status=readJson(statusFile);if(fs.existsSync(queueFile))queue=readJson(queueFile);const launcherFile=path.join(dir,record.id+'.launcher.json');if(fs.existsSync(launcherFile))launcher=readJson(launcherFile);}catch{return;}
    if(this.clock()-(record.launchAt||0)>3600000){this.transition(record,'failed','Upgrade exceeded its recovery window. Inspect the local updater status before requesting another action.');return;}
    if(status?.actionId===record.id&&status.packageSha256===record.action.installer.sha256){
      if(status.state==='completed'){
        if(this.version===record.action.installer.version&&status.version===this.version)this.transition(record,'completed','Upgrade completed; the new node is running.');
        else this.transition(record,'failed','Upgrade reported completion but the running node version does not match.');
      }else if(status.state==='failed'){
        const failure=upgradeFailure(status.detail);
        this.transition(record,'failed',`[${failure.code}] ${failure.message}`);
      }
      else if(!alive(status.pid))this.transition(record,'failed','The updater exited before confirming completion. Inspect the local upgrade log; this action will not be launched twice.');
      else if(['preparing','waiting_for_idle'].includes(status.state)){if(record.status!=='waiting')this.transition(record,'waiting','Waiting for active tasks, transfers and pending events to finish.');}
      else if(record.status!=='installing')this.transition(record,'installing','Applying the verified package and checking the managed node.');
      return;
    }
    if(queue?.actionId===record.id&&queue.packageSha256===record.action.installer.sha256&&queue.state==='queued'){
      if(!alive(queue.pid))this.transition(record,'failed','The queued updater exited before writing its status. Inspect the local launcher and upgrade logs.');
      else if(record.status==='launching')this.transition(record,'waiting','Upgrade queued; current work will finish before the node restarts.');return;
    }
    if(launcher?.actionId===record.id&&launcher.packageSha256===record.action.installer.sha256&&['exited','error'].includes(launcher.state)){
      this.transition(record,'failed',`Updater launcher ${launcher.state==='exited'?'exited (code '+launcher.code+')':'failed'} before confirming a queued upgrade. Inspect its local log; this action will not be launched twice.`);return;
    }
    if(record.status==='launching'&&this.clock()-(record.launchAt||0)>180000)this.transition(record,'failed','Updater launch could not be confirmed. It will not be launched a second time for this action; inspect the local launcher log before requesting another upgrade.');
  }
  async download(record){
    if(this.clock()<(record.retryAt||0)||this.worker.stopping)return;
    const i=record.action.installer,dir=mkdir(path.join('D:\\codex+\\cache\\fleet-upgrades',this.worker.config.nodeId));
    const file=within(dir,i.sha256+'.zip'),partial=within(dir,i.sha256+'.partial');record.file=file;
    try{
      if(!fs.existsSync(file)){
        if(!fs.existsSync(partial))fs.writeFileSync(partial,Buffer.alloc(0),{flag:'wx',mode:0o600});
        assert(fs.lstatSync(partial).isFile()&&!fs.lstatSync(partial).isSymbolicLink(),'Upgrade partial file is not a regular file');
        let offset=fs.statSync(partial).size;assert(offset<=i.size,'Upgrade download exceeds registered package size');
        for(let n=0;n<4&&offset<i.size&&!this.worker.stopping;n++){
          const length=Math.min(CHUNK,i.size-offset);let bytes;
          try{bytes=await this.worker.api(record.action.downloadPath,{raw:true,timeout:10000,headers:{range:`bytes=${offset}-${offset+length-1}`}});}catch(e){e.retryable=!e.status||e.status>=500||[408,425,429,401,403].includes(e.status);throw e;}
          assert(Buffer.isBuffer(bytes)&&bytes.length===length,'Incomplete upgrade download chunk');
          const fd=fs.openSync(partial,'a');try{fs.writeSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}offset+=bytes.length;this.save(record,{bytes:offset,ackPending:true,retryAt:0,failures:0});
        }
        if(offset<i.size)return;
        assert(fileHash(partial)===i.sha256,'Registered installer SHA256 mismatch; upgrade was not started');fs.renameSync(partial,file);
      }
      assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size===i.size&&fileHash(file)===i.sha256,'Registered installer SHA256 mismatch; upgrade was not started');
      if(this.worker.stopping)return;
      // Persist before spawning. A crash in the uncertain spawn window must not
      // cause another automatic launch of the same action after restart.
      this.save(record,{bytes:i.size,file,launchAt:this.clock()});this.transition(record,'launching','Package verified; queuing an upgrade that waits for current work.');
      const result=await this.launch(record,this.installed.root,this.worker.config.dataDir);this.save(record,{launcherPid:result?.pid||null});
    }catch(e){
      if(record.status==='launching'||!e.retryable){this.transition(record,'failed',e.status===400?text(e.message):'Upgrade preparation or launch failed; no automatic second launch will be attempted.');}
      else{const failures=(record.failures||0)+1;this.save(record,{failures,retryAt:this.clock()+Math.min(120000,1000*2**Math.min(failures,7)),detail:'Download interrupted; it will resume from the verified byte offset.',ackPending:true});}
    }
  }
  async tick(){
    if(!this.enabled||this.worker.stopping)return;
    safeUrl(this.worker.config.hubUrl);
    let records=this.records();for(const r of records){this.reconcile(r);}for(const r of records.filter(r=>r.ackPending).slice(0,4))await this.ack(r);
    if(this.clock()>=this.pollAt){this.pollAt=this.clock()+10000;try{
      const response=await this.worker.api('/v1/node/actions',{timeout:5000});assert(Array.isArray(response.actions)&&response.actions.length<=10,'Invalid maintenance action response');this.error=null;
      for(const raw of response.actions){
        let action;try{action=validateUpgradeAction(raw,this.worker.config.nodeId);}catch{
          if(raw?.nodeId===this.worker.config.nodeId&&/^[a-zA-Z0-9_-]{1,100}$/.test(raw?.id)&&!this.store.get(KEY+raw.id))this.save({id:raw.id,status:'failed',bytes:0,detail:'Rejected invalid maintenance action metadata.',ackPending:true});continue;
        }
        const prior=this.store.get(KEY+action.id);if(prior){if(prior.action&&JSON.stringify(prior.action)!==JSON.stringify(action)&&!TERMINAL.has(prior.status))this.transition(prior,'failed','The registered action changed after it was received.');continue;}
        this.save({id:action.id,action,status:'downloading',bytes:0,detail:'Downloading the registered release.',ackPending:true,createdAt:now()});
      }
    }catch{this.error='Maintenance service is temporarily unavailable; local upgrade recovery remains active.';}}
    records=this.records();if(records.some(r=>['launching','waiting','installing'].includes(r.status)))return;
    const next=records.find(r=>r.status==='downloading');if(next)await this.download(next);
  }
}
