import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {LocalStore} from './local-store.mjs';
import {runCodex,inspectCodex,publicSanitizer} from './codex.mjs';
import {DesktopCollector} from './desktop-collector.mjs';
import {WorkspaceBindings} from './workspaces.mjs';
import {startConsoleBridge} from './console-bridge.mjs';
import {waitForInteraction,queueInteractionResolution,retryInteractionResolutions} from './interactive.mjs';
import {captureProjectContext} from './project-context.mjs';
import {NodeUpdater} from './node-updater.mjs';
import {NativeContinuation} from './native-continuation.mjs';
import {DeliveryController} from './delivery-controller.mjs';
import {reconcileCancellation} from './cancel-reconcile.mjs';
import {recoverCompletedAttempt} from './completion-recovery.mjs';
import {desktopHealth} from './desktop-health.mjs';
import {VERSION,now,uid,assert,mkdir,json,readJson,writeJson,configPath,httpRequest,sleep,within,fileHash,isMain,validateSpec,transientHttp} from './common.mjs';

function git(cwd,args){return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();}
export class Worker {
  constructor(config,configFile,executor=runCodex,inspector=inspectCodex){this.config=config;this.clean=publicSanitizer(config);this.configFile=configFile;this.executor=executor;this.inspector=inspector;this.inspection=executor!==runCodex?{ready:true}:null;this.lastProbe=0;this.store=new LocalStore(config.dataDir);this.stopping=false;this.active=new Map();this.hubOnline=false;this.lock=path.join(config.dataDir,'worker.lock');this.desktop=executor===runCodex&&config.desktopSync!==false?new DesktopCollector(config,this.store):null;this.workspaces=new WorkspaceBindings(config,this.store);this.updater=new NodeUpdater(this);this.native=new NativeContinuation(this);this.delivery=new DeliveryController(this);}
  emit(event){return this.store.emit(['progress','finished','uncertain'].includes(event.type)?this.clean(event):event);}
  taskDeadline(){
    // Only this non-security limit is refreshed between tasks. Existing turns,
    // credentials, execution permissions and project roots keep their snapshot.
    const valid=value=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;
    let value=valid(this.runtimeMaxTaskMs)?this.runtimeMaxTaskMs:valid(this.config.maxTaskMs)?this.config.maxTaskMs:3600000,error=null;
    if(this.configFile){try{
      const fresh=readJson(this.configFile);
      if(fresh.nodeId!==this.config.nodeId)error='NODE_ID_CHANGED';
      else if(Object.hasOwn(fresh,'maxTaskMs')){if(valid(fresh.maxTaskMs))value=fresh.maxTaskMs;else error='INVALID_TASK_DEADLINE';}
    }catch{error='CONFIG_UNAVAILABLE';}}
    this.runtimeMaxTaskMs=value;this.store.put('taskDeadline',{maxTaskMs:value,checkedAt:now(),error});return value;
  }
  api(route,options={}){if(this.stopping)return Promise.reject(new Error('Fleet worker is stopping; durable work is retained for restart'));return httpRequest(this.config.hubUrl,route,{token:this.config.nodeToken,sitesToken:this.config.sitesToken,proxy:this.config.proxyUrl,...options});}
  taskRuntime(){return this.store.db.prepare("SELECT task,attempt,status,cwd FROM runs WHERE status IN ('preparing','running','uploading') ORDER BY updated DESC,task").all().filter(r=>r.status==='uploading'||this.active.get(r.task)?.attemptId===r.attempt).slice(0,100).map(r=>({taskId:r.task,attemptId:r.attempt,phase:r.status,cwd:r.cwd||null}));}
  desktopLaunchReport(){
    if(!this.configFile)return null;
    try{
      const file=path.join(path.dirname(path.dirname(path.resolve(this.configFile))),'desktop-bridge','launch-status.json');
      if(fs.statSync(file).size>16384)return null;
      const value=readJson(file),report={};
      for(const key of ['state','stage','at','launchMode','error','errorCode'])if(typeof value[key]==='string')report[key]=this.clean(value[key]).slice(0,key==='error'?600:100);
      return report;
    }catch{return null;}
  }
  workSlots(){return Math.max(1,Math.min(16,this.runtimeParallelLimit||this.config.maxRunning||4));}
  conversationSlots(){return this.config.desktopSessionBridge?Math.max(1,Math.min(8,this.config.maxConversations||4)):0;}
  isConversation(spec){return spec?.intent==='conversation'||!!spec?.desktopThreadId;}
  canExecute(spec){return this.bridgeHealth?.ready!==false&&!this.cancelRecoveryPromise&&(this.isConversation(spec)&&this.config.desktopSessionBridge?[...this.active.values()].filter(c=>c.conversation).length<this.conversationSlots():[...this.active.values()].filter(c=>!c.conversation).length<this.workSlots());}
  capabilities(){return {version:VERSION,deliveryControl:true,deliveryController:this.delivery.summary(),parallelExecution:true,conversationDispatch:!!this.config.desktopSessionBridge&&this.inspection?.desktopBridgeFeatures?.nativeMessages===true,conversationReady:this.bridgeHealth?.ready!==false&&!this.stopping&&!this.probePromise&&!this.cancelRecoveryPromise&&!!this.inspection?.ready,conversationSlots:this.conversationSlots(),desktopLaunch:this.desktopLaunchReport(),desktopContinuation:this.native.summary().supported===true,desktopContinuationState:this.native.summary(),selfUpgrade:this.updater.enabled,upgrade:this.updater.summary(),localExecutionPolicy:true,workspaceExecution:true,workspaceCatalog:this.workspaces.catalog.summary(),desktopProjectBridge:this.config.desktopProjectBridge!==false,desktopProjects:this.workspaces.desktopSummary(),consoleBridge:this.consoleBridge?{ready:true,port:this.consoleBridge.port}:{ready:false,error:this.consoleBridgeError||null},...this.inspection,desktopBridgeHealth:this.bridgeHealth||null,executorState:this.bridgeHealth?.ready===false?'blocked':this.probePromise?'checking':this.inspection?.ready?'ready':'blocked',ready:this.bridgeHealth?.ready!==false&&!this.stopping&&!this.probePromise&&!this.cancelRecoveryPromise&&[...this.active.values()].filter(c=>!c.conversation).length<this.workSlots()&&!!this.inspection?.ready,projects:Object.keys(this.config.projects||{}),maxRunning:this.workSlots(),desktopSessionBridge:!!this.config.desktopSessionBridge,execution:this.config.desktopSessionBridge?'desktop-shared-app-server':'local-codex-app-server',skillPolicy:'use-target-host-installed-skills',activeConversations:[...this.active.entries()].filter(([,c])=>c.conversation).map(([id])=>id),activeTasks:[...this.active.keys()],taskRuntime:this.taskRuntime(),waitingInteractions:[...this.active.entries()].filter(([,c])=>c.waitingInteraction).map(([taskId,c])=>({taskId,id:c.waitingInteraction})),...(this.desktop?{desktop:this.desktop.summary()}:{}),transfers:this.store.transfers().filter(x=>x.status!=='complete').slice(0,10).map(({id,name,size,bytes,status,error,followup})=>({id,name,size,bytes,status,error,sourceNode:this.config.nodeId,targetNode:followup?.targetNode||null}))};}
  lockProcess(){
    if(fs.existsSync(this.lock)){const prior=readJson(this.lock);let alive=false;try{process.kill(prior.pid,0);alive=true;}catch(e){if(e.code==='EPERM')alive=true;}assert(!alive,'A worker process already owns this node (or PID was reused). Check worker.lock before restarting.');fs.unlinkSync(this.lock);}
    fs.writeFileSync(this.lock,json({pid:process.pid,started:now()}),{flag:'wx',mode:0o600});
  }
  recover(){for(const r of this.store.runs())if(r.status==='running'){this.store.update(r.task,{status:'uncertain'});this.emit({type:'uncertain',taskId:r.task,attemptId:r.attempt,reason:'Worker restarted while task was executing. Verify the previous process before retry.'});}}
  prepare(r){
    validateSpec(r.spec);
    const p=this.config.projects[r.spec.project];assert(p,'Project not configured locally');const root=r.spec.workspaceId?this.workspaces.root(r.spec):p.root;assert(fs.existsSync(root),'Project root missing');let cwd=fs.realpathSync(root),base=null,branch=null;
    if(r.spec.worktree!==false){let isRepo=false;try{isRepo=git(cwd,['rev-parse','--is-inside-work-tree'])==='true';}catch{}
      if(isRepo){base=r.spec.baseCommit||git(cwd,['rev-parse','HEAD']);git(cwd,['cat-file','-e',base+'^{commit}']);branch='fleet/'+r.task;const dir=path.join(mkdir(path.join(this.config.dataDir,'worktrees')),r.task);
        if(fs.existsSync(dir)){assert(git(dir,['branch','--show-current'])===branch,'Existing worktree does not match task');}else git(cwd,['worktree','add','-b',branch,dir,base]);cwd=fs.realpathSync(dir);
      }else assert(!r.spec.baseCommit,'baseCommit requires a Git repository');
    }
    let resumeThreadId=null;if(r.spec.resumeTaskId){const prior=this.store.run(r.spec.resumeTaskId);assert(!prior?.spec.desktopThreadId,'NATIVE_CONTINUATION_REQUIRED: use the original conversation message endpoint to preserve its permissions');assert(prior?.thread&&prior.spec.project===r.spec.project&&(prior.spec.workspaceId||null)===(r.spec.workspaceId||null)&&['submitted','failed','blocked','cancelled','finished'].includes(prior.status),'Previous local task cannot be resumed');assert(r.spec.worktree===false,'Continuation must use worktree=false');resumeThreadId=prior.thread;cwd=prior.cwd;}
    return {...r,cwd,sandbox:r.spec.mode==='question'?'read-only':p.sandbox||'workspace-write',base,branch,resumeThreadId};
  }
  transferProgress(r,a,stage,bytes){this.store.inputProgress(r.task,a.name,stage,bytes);this.emit({type:'progress',taskId:r.task,attemptId:r.attempt,kind:'input_transfer',stage,sha:a.sha,name:a.name,bytes,size:a.size});}
  async prepareInputs(plan,control){
    const inputs=[];for(const a of plan.spec.inputs||[]){
      const file=within(plan.cwd,path.join('inbox',plan.task,a.name));mkdir(path.dirname(file));
      const entry=this.store.input(plan.task,a,file);assert(entry.sha===a.sha&&entry.path===file&&entry.size===a.size,'Stored input manifest differs');
      if(fs.existsSync(file)){assert(fs.statSync(file).isFile()&&fs.statSync(file).size===a.size&&fileHash(file)===a.sha,'Input file already exists with different contents');this.transferProgress(plan,a,'checksummed',a.size);inputs.push({...a,path:file});continue;}
      const part=within(plan.cwd,path.relative(plan.cwd,file+'.'+a.sha+'.partial'));if(!fs.existsSync(part))fs.writeFileSync(part,Buffer.alloc(0),{flag:'wx',mode:0o600});assert(fs.lstatSync(part).isFile(),'Partial input must be a regular file');
      let offset=fs.statSync(part).size,failures=0;assert(offset<=a.size,'Partial input exceeds declared size');this.transferProgress(plan,a,'received',offset);
      while(offset<a.size){assert(!control.cancelled&&!this.stopping,'Input transfer was cancelled');const length=Math.min(1024*1024,a.size-offset);
        let bytes;try{bytes=await this.api(`/v1/artifacts/${a.sha}?task=${encodeURIComponent(plan.task)}`,{raw:true,headers:{range:`bytes=${offset}-${offset+length-1}`}});failures=0;}catch(e){
          if(!transientHttp(e.status)&&![401,403].includes(e.status))throw e;failures++;this.store.put('inputTransferError',{taskId:plan.task,name:a.name,error:this.clean(e.message),at:now()});if(failures===1||failures%5===0)this.emit({type:'progress',taskId:plan.task,attemptId:plan.attempt,kind:'input_transfer',stage:'retrying',sha:a.sha,name:a.name,bytes:offset,size:a.size,message:this.clean(e.message)});await sleep(Math.min(30000,e.retryAfterMs||1000*2**Math.min(failures,5)));continue;}
        assert(bytes.length===length,'Incomplete input download chunk');const fd=fs.openSync(part,'a');try{fs.writeSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}offset+=bytes.length;this.transferProgress(plan,a,'received',offset);
      }
      assert(fileHash(part)===a.sha,'Input hash mismatch; partial retained for diagnosis');assert(!fs.existsSync(file),'Input destination already exists');fs.renameSync(part,file);this.transferProgress(plan,a,'checksummed',a.size);inputs.push({...a,path:file});
    }return inputs;
  }
  finishUpload(r){this.store.db.exec('BEGIN IMMEDIATE');try{this.emit({type:'finished',taskId:r.task,attemptId:r.attempt,status:r.result.status,result:r.result,threadId:r.thread});this.store.update(r.task,{status:r.result.status});this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}}
  uploadReady(kind,id){return Date.now()>=(this.store.get(`uploadRetry:${kind}:${id}`)?.retryAt||0);}
  uploadRecovered(kind,id){this.store.put(`uploadRetry:${kind}:${id}`,null);}
  uploadFailed(kind,id,error){
    const key=`uploadRetry:${kind}:${id}`,failures=(this.store.get(key)?.failures||0)+1,retryAt=Date.now()+Math.min(300000,error.retryAfterMs||1000*2**Math.min(failures,6));
    const record={kind,id,failures,retryAt,error:this.clean(error.message),at:now()};this.store.put(key,record);this.store.put('uploadError',record);
  }
  async stopResolvedUpload(r,error){
    if(error.status!==409)return false;
    let remote;try{remote=await this.api(`/v1/tasks/${encodeURIComponent(r.task)}`);}catch{return false;}
    if(remote?.id!==r.task||typeof remote.attempt!=='string')return false;
    const superseded=remote.attempt!==r.attempt;
    if(!superseded&&!['failed','cancelled'].includes(remote.status))return false;
    if(this.store.run(r.task)?.status!=='uploading')return false;
    const uploadStopped={reason:superseded?'Remote task has a different attempt; local output upload stopped.':'Remote task was failed or cancelled; local output upload stopped.',remoteStatus:remote.status,remoteAttempt:remote.attempt,stoppedAt:now(),snapshotRetained:true};
    // Keep the original execution result and every immutable snapshot. Do not send
    // a new finished event or overwrite the operator's terminal decision.
    this.store.update(r.task,{status:'upload_stopped',result:{...r.result,uploadStopped}});this.store.put('uploadStopped:'+r.task,uploadStopped);this.uploadRecovered('task',r.task);return true;
  }
  async execute(task){
    const r=this.store.add(task);if(!['received','preparing'].includes(r.status))return;
    if((r.spec.desktopThreadId||task.spec.desktopThreadId)&&(r.attempt!==task.attempt||JSON.stringify(r.spec)!==JSON.stringify(task.spec))){this.emit({type:'uncertain',taskId:task.id,attemptId:task.attempt,reason:'The persisted native continuation differs from the delivered attempt. No message was sent.'});return;}
    const control={conversation:this.isConversation(r.spec),attemptId:r.attempt,cancelled:false,cancel:async()=>{control.cancelled=true;}};this.active.set(r.task,control);this.store.update(r.task,{status:'preparing'});
    this.emit({type:'started',taskId:r.task,attemptId:r.attempt});
    let plan;
    try{
      validateSpec(r.spec);
      let binding;if(r.spec.workspaceId)binding=await this.workspaces.ensure(r.spec.workspaceId,(route,options)=>this.api(route,options),{registerDesktop:!r.spec.resumeTaskId});
      plan=r.spec.desktopThreadId?await this.native.prepare(r):this.prepare(r);this.store.update(r.task,{cwd:plan.cwd});
      if(binding)plan.context=await captureProjectContext(this,r,binding);
      if(binding?.desktopProject){plan.desktopProject=binding.desktopProject;this.emit({type:'progress',taskId:r.task,attemptId:r.attempt,kind:'desktop_project',workspaceId:binding.id,...binding.desktopProject,message:binding.desktopProject.state==='registered'?'已确认本机 Codex 项目登记；桌面显示尚未验收。':'桌面项目登记暂不可用，任务仍在已核验的目录运行：'+(binding.desktopProject.error||binding.desktopProject.state)});}
      plan.inputs=await this.prepareInputs(plan,control);assert(!control.cancelled&&!this.stopping,'Task cancelled before execution');this.store.update(r.task,{status:'running'});
      const result=await this.executor({...this.config,maxTaskMs:this.taskDeadline(),expectedAccountFingerprint:this.inspection?.accountFingerprint},this.configFile,plan,{
        onThread:id=>{this.store.update(r.task,{thread:id});this.emit({type:'progress',taskId:r.task,attemptId:r.attempt,threadId:id});},
        onProgress:p=>this.emit({type:'progress',taskId:r.task,attemptId:r.attempt,...p}),onReady:c=>{Object.assign(control,c,{cancel:async()=>{control.cancelled=true;await c.cancel?.();}});},
        onBeforeTurn:()=>r.spec.desktopThreadId?this.native.beforeTurn(r,control):undefined,onTurn:id=>{this.store.put('executionTurn:'+r.task,{attempt:r.attempt,thread:this.store.run(r.task)?.thread,turnId:id,at:now()});if(r.spec.desktopThreadId)this.native.sent(r,id);},
        onInteraction:(value,signal)=>waitForInteraction(this,r,value,signal),onInteractionResolved:id=>queueInteractionResolution(this,r,id),
        onContextAttached:()=>{for(const a of plan.inputs)this.transferProgress(plan,a,'context_attached',a.size);}
      });
      const artifacts=[];
      if(result.status==='submitted')for(const relative of r.spec.outputs||[]){const file=within(plan.cwd,relative);assert(fs.existsSync(file)&&fs.statSync(file).isFile(),`Expected output missing: ${relative}`);const size=fs.statSync(file).size;assert(size<=(this.config.maxArtifactBytes||512*1024*1024),`Artifact exceeds size limit: ${relative}`);const sha=fileHash(file),dest=path.join(mkdir(path.join(this.config.dataDir,'artifacts')),sha);if(!fs.existsSync(dest))fs.copyFileSync(file,dest);assert(fileHash(dest)===sha,'Artifact snapshot changed');artifacts.push({sha,size,name:relative});}
      let code=null;if(!r.spec.desktopThreadId)try{code={baseCommit:plan.base,branch:git(plan.cwd,['branch','--show-current']),commit:git(plan.cwd,['rev-parse','HEAD']),dirty:!!git(plan.cwd,['status','--porcelain'])};}catch{}
      this.store.update(r.task,{status:'uploading',result:{...result,artifacts,code,cwd:plan.cwd}});
    }catch(e){if(e.deliveryUncertain){this.store.update(r.task,{status:'uncertain',result:{status:'uncertain',summary:'',error:this.clean(e.message),threadId:e.threadId}});this.emit({type:'uncertain',taskId:r.task,attemptId:r.attempt,reason:'Desktop connection ended after dispatch. Check the existing conversation before retrying.'});return;}const uncertain=r.spec.desktopThreadId&&this.store.get('nativeDelivery:'+r.task),state=e.nativeState||(uncertain?'uncertain':null);this.store.update(r.task,{status:'uploading',result:{status:control.cancelled?'cancelled':state||e.preflightBlocked?'blocked':'failed',summary:'',error:this.clean(e.message),artifacts:[],cwd:plan?.cwd||null,...(state?{desktop:{threadId:r.spec.desktopThreadId,deepLink:'codex://threads/'+encodeURIComponent(r.spec.desktopThreadId),state,reason:e.nativeCode||(uncertain?'NATIVE_CONTINUATION_UNCERTAIN':undefined),sameThread:true,visibility:'not_verified'}}:{})}});}
    finally{this.active.delete(r.task);}
  }
  async uploads(maxChunks=1){
    let chunks=0;
    for(const r of this.store.runs().filter(x=>x.status==='uploading')){
      if(!this.uploadReady('task',r.task))continue;
      try{
        for(const a of r.result.artifacts||[]){const route=`/v1/artifacts/${a.sha}?task=${encodeURIComponent(r.task)}`;let state=await this.api(route,{method:'POST',body:{size:a.size,name:a.name}});
          if(!state.complete){const chunkSize=Number.isSafeInteger(state.chunkSize)?Math.max(65536,Math.min(8*1024*1024,state.chunkSize)):1024*1024;const fd=fs.openSync(path.join(this.config.dataDir,'artifacts',a.sha),'r');try{while(state.offset<a.size){if(chunks>=maxChunks)return;const b=Buffer.alloc(Math.min(chunkSize,a.size-state.offset));const count=fs.readSync(fd,b,0,b.length,state.offset);assert(count===b.length,'Artifact read failed');chunks++;state=await this.api(route+'&offset='+state.offset,{method:'PUT',body:b});this.uploadRecovered('task',r.task);this.emit({type:'progress',taskId:r.task,attemptId:r.attempt,kind:'output_transfer',sha:a.sha,name:a.name,bytes:state.offset,size:a.size,stage:state.complete?'checksummed':'uploading'});}if(a.size===0){if(chunks>=maxChunks)return;chunks++;state=await this.api(route+'&offset=0',{method:'PUT',body:Buffer.alloc(0)});}assert(state.complete,'Artifact did not finish verification');}finally{fs.closeSync(fd);}}
        }
        // Persist finished event and local status atomically so a restart cannot lose the result.
        this.finishUpload(r);this.uploadRecovered('task',r.task);
      }catch(e){if(!await this.stopResolvedUpload(r,e))this.uploadFailed('task',r.task,e);}
    }
    for(const a of this.store.transfers().filter(a=>a.status!=='complete')){
      if(chunks>=maxChunks)return;
      if(!this.uploadReady('file',a.id))continue;
      try{
        const route=`/v1/files/${a.sha}?project=${encodeURIComponent(a.project)}`;let state=await this.api('/v1/files',{method:'POST',body:{id:a.id,project:a.project,sha:a.sha,size:a.size,name:a.name}});this.store.transferProgress(a.id,'uploading',state.offset||0);
        if(!state.complete){const chunkSize=Number.isSafeInteger(state.chunkSize)?Math.max(65536,Math.min(8*1024*1024,state.chunkSize)):1024*1024;const fd=fs.openSync(path.join(this.config.dataDir,'artifacts',a.sha),'r');try{
          while(state.offset<a.size){if(chunks>=maxChunks)return;const b=Buffer.alloc(Math.min(chunkSize,a.size-state.offset));assert(fs.readSync(fd,b,0,b.length,state.offset)===b.length,'File snapshot read failed');chunks++;state=await this.api(route+'&offset='+state.offset,{method:'PUT',body:b});this.uploadRecovered('file',a.id);this.store.transferProgress(a.id,'uploading',state.offset);}
          if(a.size===0){if(chunks>=maxChunks)return;chunks++;state=await this.api(route+'&offset=0',{method:'PUT',body:Buffer.alloc(0)});}assert(state.complete,'File did not finish verification');
        }finally{fs.closeSync(fd);}}
        this.store.db.exec('BEGIN IMMEDIATE');try{if(a.followup)this.emit({type:'assign',spec:{...a.followup,inputs:[{sha:a.sha,size:a.size,name:a.name}]}});this.store.transferProgress(a.id,'complete',a.size);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}this.uploadRecovered('file',a.id);
      }catch(e){this.store.transferProgress(a.id,'uploading',this.store.transfer(a.id).bytes,this.clean(e.message));this.uploadFailed('file',a.id,e);}
    }
  }
  async tick(){
    if(this.stopping)return;
    const waiting=!this.config.hubUrl||['pending','enrolling'].includes(this.config.enrollmentState);
    if(this.executor===runCodex&&this.config.desktopSessionBridge&&!this.healthPromise&&Date.now()-(this.lastHealth||0)>15000){this.lastHealth=Date.now();this.healthPromise=desktopHealth(this.config.desktopSessionBridge).then(value=>{this.bridgeHealth=value;}).finally(()=>{this.healthPromise=null;});}
    if(this.executor===runCodex&&!this.probePromise&&(!this.inspection||(!waiting&&!this.active.size&&Date.now()-this.lastProbe>60000))){this.lastProbe=Date.now();this.inspectorAbort=new AbortController();this.probePromise=this.inspector(this.config,{signal:this.inspectorAbort.signal}).then(value=>{this.inspection=value;},e=>{this.inspection={ready:false,error:'Local Codex probe failed: '+this.clean(e.message)};}).finally(()=>{this.store.put('codex',this.inspection);this.probePromise=null;});}
    if(waiting){this.hubOnline=false;if(this.store.get('connection')?.state!=='awaiting_enrollment')this.store.put('connection',{online:false,state:'awaiting_enrollment',at:now(),note:'Installed locally. Complete enrollment with an invitation from the intended hub before dispatching tasks.'});return;}
    if(this.executor===runCodex&&!this.deliveryPromise)this.deliveryPromise=this.delivery.tick().finally(()=>{this.deliveryPromise=null;});
    if(this.executor===runCodex&&this.native.canCheck()&&!this.nativeProbePromise)this.nativeProbePromise=this.native.check().finally(()=>{this.nativeProbePromise=null;});
    if(this.updater.enabled&&!this.upgradePromise)this.upgradePromise=this.updater.tick().catch(e=>this.store.put('upgradeError',{at:now(),error:this.clean(e.message)})).finally(()=>{this.upgradePromise=null;});
    if(!this.interactionAckPromise)this.interactionAckPromise=retryInteractionResolutions(this).catch(e=>this.store.put('interactionAckError',{at:now(),error:this.clean(e.message)})).finally(()=>{this.interactionAckPromise=null;});
    if((this.executor===runCodex||this.config.workspaceSync===true)&&!this.workspacePromise)this.workspacePromise=this.workspaces.sync((route,options)=>this.api(route,options)).catch(e=>this.store.put('workspaceSync',{at:now(),error:this.clean(e.message)})).finally(()=>{this.workspacePromise=null;});
    // Reading the native task directory has its own retry path. Slow history or
    // network calls must not block Fleet heartbeats, transfers or execution.
    if(this.desktop&&!this.desktopPromise)this.desktopPromise=this.desktop.tick((route,options)=>this.api(route,options)).catch(e=>console.error(this.clean(e.message))).finally(()=>{this.desktopPromise=null;});
    let events=this.store.pending(),response;
    try{response=await this.api('/v1/sync',{method:'POST',body:{events,capabilities:this.capabilities()}});}
    catch(e){
      if(e.status&&e.status>=400&&e.status<500&&!transientHttp(e.status)&&![401,403].includes(e.status)&&events.length){
        for(const item of events){try{const one=await this.api('/v1/sync',{method:'POST',body:{events:[item],capabilities:{...this.capabilities(),ready:false}}});this.store.ack(one.ack);}catch(err){if(err.status&&err.status>=400&&err.status<500&&!transientHttp(err.status)&&![401,403].includes(err.status))this.store.quarantine(item.id,this.clean(err.message));else throw err;}}
        response=await this.api('/v1/sync',{method:'POST',body:{events:[],capabilities:this.capabilities()}});
      }else throw e;
    }
    if(Number.isInteger(response.parallelLimit)&&response.parallelLimit>=1&&response.parallelLimit<=16)this.runtimeParallelLimit=response.parallelLimit;
    this.hubOnline=true;this.nextPollMs=Number.isFinite(response.nextPollMs)?Math.max(1000,Math.min(this.config.desktopSessionBridge?2000:30000,response.nextPollMs)):null;this.store.ack(response.ack);this.store.put('connection',{online:true,lastSuccess:now()});
    for(const t of response.tasks){
      if(this.stopping)break;
      if(t.status==='cancel_requested'){const c=this.active.get(t.id);if(c?.cancel)await c.cancel().catch(()=>{});else if(!c){const r=this.store.run(t.id);if(!r||r.status==='received'){this.store.add(t);this.store.update(t.id,{status:'cancelled'});this.emit({type:'finished',taskId:t.id,attemptId:t.attempt,status:'cancelled',result:{summary:'Cancelled before execution'}});}else if(r.status==='uncertain'&&!this.cancelRecoveryPromise){this.cancelRecoveryPromise=reconcileCancellation({config:this.config,store:this.store,api:(...args)=>this.api(...args),taskId:t.id,isActive:id=>this.active.has(id),stopping:()=>this.stopping}).catch(e=>this.store.put('cancelRecoveryError',{at:now(),error:this.clean(e.message)})).finally(()=>{this.cancelRecoveryPromise=null;});}}continue;}
      if(['claimed','running'].includes(t.status)&&!this.active.has(t.id)){const existing=this.store.run(t.id);if((!existing||['received','preparing'].includes(existing.status))&&this.canExecute(t.spec))this.execute(t).catch(e=>console.error(this.clean(e.message)));}
      const c=this.active.get(t.id);if(c?.message){const messages=await this.api(`/v1/tasks/${t.id}/messages`);for(const m of messages){if(this.store.db.prepare('SELECT 1 FROM delivery WHERE id=?').get(m.id))continue;
        // Mark before injection: a crash must not blindly inject the same instruction twice.
        this.store.db.prepare('INSERT INTO delivery VALUES(?,?,?)').run(m.id,t.id,'sending');
        try{await c.message(m.text);this.store.db.prepare("UPDATE delivery SET state='delivered' WHERE id=?").run(m.id);}catch(e){this.store.db.prepare("UPDATE delivery SET state='uncertain' WHERE id=?").run(m.id);this.emit({type:'progress',taskId:t.id,attemptId:t.attempt,message:`Message delivery uncertain (${m.id}): ${this.clean(e.message)}`});}
      }}
    }
    // Operator-resolved attempts are absent from the active sync response.
    // Reconcile their local uncertain record too, without changing that decision.
    if(!this.stopping&&!this.active.size&&!this.cancelRecoveryPromise){
      const orphan=this.store.runs().find(r=>r.status==='uncertain'&&!(Date.parse(this.store.get('cancelRecovery:'+r.task)?.retryAt)>Date.now()));
      if(orphan)this.cancelRecoveryPromise=(async()=>{
        if(this.executor===runCodex&&await recoverCompletedAttempt(this,orphan.task))return;
        return reconcileCancellation({config:this.config,store:this.store,api:(...args)=>this.api(...args),taskId:orphan.task,isActive:id=>this.active.has(id),stopping:()=>this.stopping});
      })().catch(e=>this.store.put('cancelRecoveryError',{at:now(),error:this.clean(e.message)})).finally(()=>{this.cancelRecoveryPromise=null;});
    }
    for(const r of this.store.runs().filter(r=>r.status==='uploading'&&!r.result.artifacts?.length))this.finishUpload(r);
    if(!this.uploadPromise&&Date.now()>=(this.uploadRetryAt||0)&&(this.store.runs().some(r=>r.status==='uploading')||this.store.transfers().some(r=>r.status!=='complete')))this.uploadPromise=this.uploads(Math.max(1,Math.min(8,this.config.uploadChunksPerTick||1))).then(()=>{this.uploadFailures=0;this.uploadRetryAt=0;}).catch(e=>{this.uploadFailures=(this.uploadFailures||0)+1;this.uploadRetryAt=Date.now()+Math.min(300000,e.retryAfterMs||1000*2**Math.min(this.uploadFailures,6));this.store.put('uploadError',{error:this.clean(e.message),at:now(),retryAt:new Date(this.uploadRetryAt).toISOString()});}).finally(()=>{this.uploadPromise=null;});
  }
  async start(){this.lockProcess();this.recover();if(this.executor===runCodex&&this.config.enrollmentState==="enrolled"&&this.config.consoleBridge!==false){try{this.consoleBridge=await startConsoleBridge(this.config);}catch(e){this.consoleBridgeError=this.clean(e.message);}}console.log(json({service:'codex-fleet-node',node:this.config.nodeId,name:this.config.name}));let failures=0;const desktopWatch=setInterval(()=>{if(!this.stopping&&this.desktop&&!this.desktopPromise&&this.config.hubUrl&&this.config.enrollmentState==="enrolled")this.desktopPromise=this.desktop.tick((route,options)=>this.api(route,options)).catch(e=>console.error(this.clean(e.message))).finally(()=>{this.desktopPromise=null;});},5000);const watch=setInterval(()=>{if(fs.existsSync(path.join(this.config.dataDir,'stop.request')))this.stop();},500);
    while(!this.stopping){let retryAfter=0;try{await this.tick();failures=0;}catch(e){failures++;retryAfter=e.retryAfterMs||0;this.hubOnline=false;this.store.put('connection',{online:false,error:this.clean(e.message),at:now()});if(failures===1||failures%10===0)console.error(json({at:now(),error:this.clean(e.message)}));}const busy=this.active.size||this.store.pending().length||this.store.runs().some(r=>r.status==='uploading')||this.store.transfers().some(r=>r.status!=='complete');await this.pause(Math.max(retryAfter,Math.min(60000,(busy?(this.config.pollMs||2000):(this.nextPollMs||this.config.idlePollMs||1500))*Math.min(2**Math.min(failures,4),16)))+Math.floor(Math.random()*200));}
    clearInterval(desktopWatch);this.shutdownState('draining_tasks');while(this.active.size){for(const c of this.active.values())if(c.cancel&&!c.cancelSent){c.cancelSent=true;await c.cancel().catch(()=>{});}await sleep(100);}this.shutdownState('closing_readers');await this.consoleBridge?.close();await this.desktop?.close();this.shutdownState('waiting_background');await Promise.allSettled(this.backgroundPending().map(key=>this[key]));clearInterval(watch);clearTimeout(this.shutdownTimer);this.closeStorage();this.shutdownState('cleanup_complete');
  }
  backgroundPending(){return ['healthPromise','probePromise','uploadPromise','desktopPromise','desktopClosePromise','workspacePromise','workspaceClosePromise','interactionAckPromise','upgradePromise','nativeProbePromise','cancelRecoveryPromise','deliveryPromise'].filter(key=>this[key]);}
  shutdownState(stage,extra={}){try{writeJson(path.join(this.config.dataDir,'shutdown-status.json'),{pid:process.pid,nodeId:this.config.nodeId,stage,at:now(),pending:this.backgroundPending(),activeTasks:this.active.size,...extra});}catch{/* A failed diagnostic write must not interrupt durable shutdown. */}}
  closeStorage(){if(this.storageClosed)return;this.store.close();this.storageClosed=true;if(fs.existsSync(this.lock)&&readJson(this.lock).pid===process.pid)fs.unlinkSync(this.lock);}
  canFinishIdleShutdown(){
    if(!this.stopping||this.storageClosed)return false;
    const unsafe=this.store.runs().filter(r=>['preparing','running','uncertain'].includes(r.status));
    if(this.active.size||unsafe.length||this.cancelRecoveryPromise){this.shutdownState('needs_attention',{reason:'Active or uncertain task must be reconciled before process exit.'});return false;}
    this.shutdownState('idle_shutdown_timeout',{reason:'Background cleanup exceeded its grace period; durable queues are retained.'});return true;
  }
  pause(ms){if(this.stopping)return Promise.resolve();return new Promise(resolve=>{const finish=()=>{clearTimeout(timer);this.wake=null;resolve();};const timer=setTimeout(finish,ms);this.wake=finish;});}
  stop(){if(this.stopping)return;this.stopping=true;this.shutdownState('requested');this.wake?.();this.inspectorAbort?.abort();this.desktopClosePromise=Promise.resolve(this.desktop?.close()).catch(()=>{}).finally(()=>{this.desktopClosePromise=null;});this.workspaceClosePromise=this.workspaces.close().catch(()=>{}).finally(()=>{this.workspaceClosePromise=null;});if(this.onIdleShutdownTimeout){const grace=Math.max(1000,Math.min(120000,Number(this.config.shutdownGraceMs)||60000));this.shutdownTimer=setTimeout(()=>{try{if(this.canFinishIdleShutdown())this.onIdleShutdownTimeout();}catch(e){this.shutdownState('needs_attention',{reason:this.clean(e.message)});}},grace);}}
}
if(isMain(import.meta.url)){const p=configPath(),w=new Worker(readJson(p),p);w.onIdleShutdownTimeout=()=>{w.closeStorage();process.exit(0);};for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>w.stop());await w.start();process.exit(0);}
