import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {FleetClient} from './client.mjs';
import {assert,within,mkdir,writeJson,readJson,fileHash,now} from './common.mjs';

const execute=promisify(execFile);
const REPOS=new Set(['zhoudebao6-art/software-case-batch','zhoudebao6-art/software-system-delivery']);
// The controller persists all intent before I/O. It never runs a business model
// locally, and a failed/lost request keeps the same batch and task identity.
export class DeliveryController {
 constructor(worker,{exec=execute}={}){
  this.worker=worker;this.exec=exec;this.retryAt=0;
  this.client=Object.assign(Object.create(FleetClient.prototype),{config:worker.config,store:worker.store,api:(...args)=>worker.api(...args)});
 }
 summary(){return this.worker.store.get('deliveryController')||{state:'ready'};}
 root(op){assert(/^[\w-]{1,100}$/.test(op.batchId),'Invalid delivery identity');const root=this.worker.config.projects?.[op.project]?.root;assert(root,'Controller project unavailable');return mkdir(within(root,'deliveries/'+op.batchId));}
 async github(route,binary=false){
  assert(/^repos\/zhoudebao6-art\/(software-case-batch|software-system-delivery)\//.test(route),'Unsupported baseline repository');
  const gh=this.worker.config.githubCliPath||(['D:/codex+/tools/gh/bin/gh.exe'].find(p=>fs.existsSync(p)))||'gh';
  const {stdout}=await this.exec(gh,['api',route],{windowsHide:true,timeout:90000,maxBuffer:32*1024*1024,encoding:binary?'buffer':'utf8',env:{...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp'}});
  return binary?stdout:JSON.parse(stdout);
 }
 async baseline(op){
  const root=this.root(op),stateFile=path.join(root,'baseline-state.json'),repository=op.profile.repository;
  assert(REPOS.has(repository),'Unsupported delivery profile');
  let state=fs.existsSync(stateFile)?readJson(stateFile):null;
  if(!state){
   const ref=await this.github(`repos/${repository}/git/ref/heads/main`);assert(/^[a-f0-9]{40}$/.test(ref.object?.sha),'Invalid GitHub revision');
   state={repository,commit:ref.object.sha,checkedAt:now()};writeJson(stateFile,state);
  }
  assert(state.repository===repository,'Baseline identity changed');
  const dir=mkdir(path.join(root,'baseline')),archive=path.join(dir,'package.zip'),manifest=path.join(dir,'manifest.json');
  if(!fs.existsSync(manifest)){
   const tree=await this.github(`repos/${repository}/git/trees/${state.commit}?recursive=1`);assert(!tree.truncated&&Array.isArray(tree.tree),'Incomplete GitHub tree');
   assert(tree.tree.every(x=>x.type==='tree'||x.type==='blob'&&x.mode!=='120000'),'Unsupported symlink or submodule in skill');
   writeJson(manifest,{repository,commit:state.commit,files:tree.tree.filter(x=>x.type==='blob').map(x=>({path:x.path,gitBlob:x.sha,size:x.size}))});
  }
  if(!fs.existsSync(archive)){
   const bytes=await this.github(`repos/${repository}/zipball/${state.commit}`,true);assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024*1024,'Invalid skill archive');
   const tmp=archive+'.partial';fs.writeFileSync(tmp,bytes);fs.renameSync(tmp,archive);
  }
  if(!readJson(manifest).archiveVerified){
   await this.exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/Verify-SkillArchive.ps1',import.meta.url)),'-Archive',archive,'-Manifest',manifest],{windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  }
  const proof=readJson(manifest);assert(proof.archiveVerified&&proof.archiveSha256===fileHash(archive),'Baseline archive changed after verification');
  const parts={};
  for(const [key,file] of [['package',archive],['manifest',manifest]]){
   const relative=path.relative(this.worker.config.projects[op.project].root,file);
   const transfer=this.client.queueFile(op.project,relative,{id:`delivery-${op.batchId}-${key}`});
   if(transfer.status!=='complete')return;
   parts[key]={sha:transfer.sha,size:transfer.size,name:transfer.name};
  }
  await this.ack(op,{kind:'baseline',baseline:{...state,...parts}});
 }
 async download(op,file){
  const root=this.root(op),out=within(root,file.name);
  if(fs.existsSync(out)){assert(fs.statSync(out).size===file.size&&fileHash(out)===file.sha,'Collected file changed; existing file preserved');return out;}
  assert(!this.worker.stopping,'Controller is stopping');
  await this.client.download(file.taskId||op.taskId,file.sha,out);
  assert(fs.statSync(out).size===file.size&&fileHash(out)===file.sha,'Collected artifact integrity mismatch');return out;
 }
 ack(op,body){assert(!this.worker.stopping,'Controller is stopping');return this.worker.api(`/v1/deliveries/${op.batchId}/ack`,{method:'POST',body});}
 async inspect(op){
  const receipts=op.artifacts.filter(x=>x.name.endsWith('/receipt.json'));assert(receipts.length===1,'Missing or ambiguous delivery receipt');
  const file=receipts[0];assert(file.size>0&&file.size<=512*1024,'Receipt too large');
  // Server independently reads and validates the uploaded JSON against frozen
  // inputs. Local integrity checks also prove that the controller can retrieve it.
  await this.download(op,file);
  await this.ack(op,{kind:'inspect',jobId:op.jobId,receiptSha:file.sha});
 }
 async collect(op){
  assert(op.files.length>0,'No files to collect');
  for(const file of op.files)await this.download(op,file);
  const files=op.files.map(({name,sha,size})=>({name,sha,size}));
  writeJson(path.join(this.root(op),'collection.json'),{batchId:op.batchId,name:op.name,mode:op.mode,files,at:now()});
  await this.ack(op,{kind:'collect',relativeDirectory:'deliveries/'+op.batchId,files});
 }
 async tick(){
  if(this.worker.stopping||Date.now()<this.retryAt)return;
  this.retryAt=Date.now()+5000;
  try{
   const response=await this.worker.api('/v1/delivery/tick',{method:'POST',body:{}});
   if(!response.enabled){this.retryAt=Date.now()+60000;return;}
   let failed=false;
   // Backoff is persisted per operation; a broken receipt or one remote
   // transfer must not starve the other computers' completed work.
   const retries=this.worker.store.get('deliveryOperationRetries')||{};
   const available=new Set(response.operations.map(op=>op.batchId+':'+op.kind+':'+(op.jobId||'')));
   for(const key of Object.keys(retries))if(!available.has(key)&&Date.now()-(retries[key].at||0)>86400000)delete retries[key];
   for(const op of response.operations){
    if(this.worker.stopping)break;
    const key=op.batchId+':'+op.kind+':'+(op.jobId||'');
    if(Date.now()<(retries[key]?.retryAt||0)){failed=true;continue;}
    try{
     assert(['baseline','inspect','collect'].includes(op.kind),'Unknown delivery operation');
     await this[op.kind](op);
     delete retries[key];
    }catch(e){
     failed=true;
     const error=this.worker.clean(e.message);
     const attempts=(retries[key]?.attempts||0)+1;
     retries[key]={attempts,at:Date.now(),retryAt:Date.now()+Math.min(300000,15000*2**Math.min(5,attempts-1))};
     this.worker.store.put('deliveryController',{state:'retrying',batchId:op.batchId,error,at:now()});
     await this.ack(op,{kind:'controllerError',error}).catch(()=>{});
    }
    this.worker.store.put('deliveryOperationRetries',retries);
   }
   this.worker.store.put('deliveryOperationRetries',retries);
   if(!failed)this.worker.store.put('deliveryController',{state:'ready',at:now()});
  }catch(e){
   this.retryAt=Date.now()+30000;
   this.worker.store.put('deliveryController',{state:'retrying',error:this.worker.clean(e.message),at:now()});
  }
 }
}
