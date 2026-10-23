import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {CodexRPC} from './codex.mjs';
import {nativeError,sameNativePath} from './native-policy.mjs';
import {validateSpec,now,sleep} from './common.mjs';

function executableStamp(config){if(!config.codexPath||!path.isAbsolute(config.codexPath))return null;const file=fs.realpathSync.native(config.codexPath),s=fs.statSync(file);return [file.toLowerCase(),s.size,s.mtimeMs].join('|');}

function probeError(message,code,state='probe_failed'){return Object.assign(Error(message),{probeCode:code,probeState:state});}
async function ownerStatus(rpc,id){
  if(rpc.closed)throw probeError('The isolated original writer exited before verification finished.','NATIVE_PROBE_OWNER_EXITED');
  const thread=(await rpc.call('thread/read',{threadId:id,includeTurns:false},5000)).thread;
  if(thread?.id!==id)throw probeError('The lock probe returned a different conversation ID.','NATIVE_PROBE_THREAD_MISMATCH','lock_unsupported');
  return thread.status?.type;
}
async function requireWriterRefusal(rpc,id,stage){
  try{await rpc.call('thread/resume',{threadId:id,excludeTurns:true},15000);}
  catch(e){
    // A timeout, transport failure or an unrelated RPC error does not prove a lock.
    if(e.code===-32600&&/already has an active writer/i.test(e.message))return;
    throw e;
  }
  throw probeError(`The official ${stage} writer was not excluded.`,stage==='active'?'NATIVE_ACTIVE_WRITER_NOT_EXCLUDED':'NATIVE_IDLE_WRITER_NOT_EXCLUDED','lock_unsupported');
}

export async function probeNativeWriterLock(config,{rpcFactory=cfg=>new CodexRPC(cfg,null),pause=sleep}={}){
  const dir=fs.mkdtempSync(path.join('D:/codex+/temp','fleet-native-lock-')),home=path.join(dir,'home');fs.mkdirSync(home);
  // An empty thread may not acquire its writer lock until its first turn.
  // Use a local inert model endpoint in an isolated Codex home: no account,
  // external inference, shell tools or user conversations participate.
  const sockets=new Set();let requests=0;
  const server=http.createServer((req,res)=>{req.resume();requests++;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.created\ndata: '+JSON.stringify({type:'response.created',response:{id:'resp_fleet_lock_probe',object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:'gpt-6.1-sol',output:[]}})+'\n\n');});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6.1-sol"\nmodel_provider = "fleet_lock_probe"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fleet_lock_probe]\nname = "Fleet isolated writer lock check"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const isolated={codexPath:config.codexPath,codexHome:home,dataDir:dir},a=rpcFactory(isolated),b=rpcFactory(isolated);
  let id,turnId;
  try{await a.start();await b.start();const start=await a.call('thread/start',{cwd:dir,approvalPolicy:'never',sandbox:'read-only'},15000);id=start.thread?.id;if(typeof id!=='string'||!id)throw probeError('The isolated probe conversation was not created.','NATIVE_PROBE_THREAD_MISSING');turnId=(await a.call('turn/start',{threadId:id,input:[{type:'text',text:'Inert local writer lock capability probe.'}]},10000)).turn?.id;
    if(typeof turnId!=='string'||!turnId)throw probeError('The official probe turn did not return an ID.','NATIVE_PROBE_TURN_MISSING');
    // Writer exclusion is independent of model transport. Some valid Windows
    // installations keep a turn active while localhost inference is retrying.
    // Observe the official state and verify the lock itself; never change proxy,
    // sandbox or managed requirements to make this diagnostic endpoint reachable.
    let active=false;for(let i=0;i<100;i++){if(await ownerStatus(a,id)==='active'){active=true;break;}await pause(100);}
    if(!active)throw probeError('The official probe turn did not become active.','NATIVE_PROBE_NOT_ACTIVE');
    await requireWriterRefusal(b,id,'active');
    if(await ownerStatus(a,id)!=='active')throw probeError('The original probe turn stopped during active writer verification.','NATIVE_PROBE_ACTIVE_CHANGED');
    await a.call('turn/interrupt',{threadId:id,turnId},5000);let idle=false;for(let i=0;i<50;i++){if(await ownerStatus(a,id)==='idle'){idle=true;break;}await pause(100);}
    if(!idle)throw probeError('The original probe writer did not become idle.','NATIVE_PROBE_NOT_IDLE');
    await requireWriterRefusal(b,id,'idle');
    if(await ownerStatus(a,id)!=='idle')throw probeError('The original idle writer changed during verification.','NATIVE_PROBE_IDLE_CHANGED');
    await a.close();const resumed=await b.call('thread/resume',{threadId:id,excludeTurns:true},15000);if(resumed.thread?.id!==id||resumed.thread.status?.type!=='idle')throw probeError('Writer lock handoff did not preserve the same idle conversation.','NATIVE_PROBE_HANDOFF_MISMATCH','lock_unsupported');
    return {supported:true,state:'ready',scope:'unloaded_conversations_with_supported_saved_policy',checkedAt:now(),modelRequestsObserved:requests};
  }finally{if(id&&turnId&&!a.closed)await a.call('turn/interrupt',{threadId:id,turnId},5000).catch(()=>{});await Promise.allSettled([a.close(),b.close()]);for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
export class NativeContinuation {
  constructor(worker,{probe=probeNativeWriterLock,clock=Date.now,retryDelays=[30000,120000]}={}){this.worker=worker;this.probe=probe;this.clock=clock;this.retryDelays=retryDelays;this.attempts=0;this.nextRetryAt=0;this.checked=false;this.pending=null;this.state={supported:false,state:'checking',reason:'Verifying local Codex conversation writer exclusion.'};}
  summary(){return this.state;}
  canCheck(){return !this.checked&&!this.pending&&!this.worker.stopping&&!this.worker.active?.size&&this.clock()>=this.nextRetryAt;}
  check(){
    if(this.pending)return this.pending;
    if(!this.canCheck())return Promise.resolve(this.state);
    this.pending=this.inspect().finally(()=>{this.pending=null;});return this.pending;
  }
  async inspect(){
    if(this.worker.config.desktopContinuation===false||!this.worker.desktop){this.checked=true;this.state={supported:false,state:'disabled',reason:'Native continuation is disabled or desktop inventory is unavailable.'};this.worker.store.put('nativeContinuationCapability',this.state);return this.state;}
    if(this.worker.config.desktopSessionBridge){this.executableStamp=executableStamp(this.worker.config);this.checked=true;this.state={supported:true,state:'ready',scope:'shared_desktop_original_conversations',checkedAt:now()};this.worker.store.put('nativeContinuationCapability',this.state);return this.state;}
    this.attempts++;this.state={supported:false,state:'checking',attempt:this.attempts,reason:'Verifying local Codex conversation writer exclusion.'};
    try{
      const stamp=executableStamp(this.worker.config),result=await this.probe(this.worker.config);
      if(stamp!==executableStamp(this.worker.config))throw probeError('Codex executable changed during lock verification.','NATIVE_PROBE_EXECUTABLE_CHANGED');
      if(result?.supported!==true)throw probeError('The conversation writer probe did not confirm support.','NATIVE_PROBE_INCOMPLETE');
      this.executableStamp=stamp;this.checked=true;this.nextRetryAt=0;this.state={...result,attempt:this.attempts};
    }catch(e){
      const unsupported=e.probeState==='lock_unsupported'||e.code===-32601;
      const exhausted=this.attempts>this.retryDelays.length;
      this.checked=unsupported||exhausted;this.nextRetryAt=this.checked?0:this.clock()+this.retryDelays[this.attempts-1];
      this.state={supported:false,state:unsupported?'lock_unsupported':'probe_failed',reason:unsupported?'This Codex installation did not satisfy the official conversation writer lock checks.':exhausted?'The local writer lock check could not finish after three attempts; no conversation was sent.':'The local writer lock check could not finish. It will retry while this node is idle.',code:e.probeCode||(e.code===-32601?'NATIVE_PROBE_RPC_UNSUPPORTED':'NATIVE_PROBE_FAILED'),attempt:this.attempts,retryExhausted:!unsupported&&exhausted,...(this.nextRetryAt?{nextRetryAt:new Date(this.nextRetryAt).toISOString()}:{}),checkedAt:now()};
    }
    this.worker.store.put('nativeContinuationCapability',this.state);return this.state;
  }
  async assertClaim(run){
    const remote=await this.worker.api('/v1/tasks/'+encodeURIComponent(run.task));
    if(remote?.id!==run.task||remote.target!==this.worker.config.nodeId||remote.attempt!==run.attempt||!['claimed','running'].includes(remote.status)||remote.spec?.desktopThreadId!==run.spec.desktopThreadId||remote.spec?.desktopCwd!==run.spec.desktopCwd||remote.spec?.prompt!==run.spec.prompt)throw nativeError('unsupported','The original continuation claim is no longer current. No message was sent.','NATIVE_CONTINUATION_STALE_CLAIM');
  }
  async prepare(run){
    validateSpec(run.spec);await this.check();if(!this.state.supported)throw nativeError('unsupported',this.state.reason||'Native continuation is not supported on this computer.');
    if(this.executableStamp!==executableStamp(this.worker.config)){this.state={supported:false,state:'unsupported',reason:'The local Codex executable changed after its writer lock check. Restart this node to verify the new version.',checkedAt:now()};throw nativeError('unsupported',this.state.reason);}
    const spec=run.spec,local=this.worker.desktop?.cached(spec.desktopThreadId);
    if(spec.targetNode!==this.worker.config.nodeId||!this.worker.config.projects?.[spec.project]||local?.threadId!==spec.desktopThreadId||local.project!==spec.project||local.archived||!sameNativePath(local.cwd,spec.desktopCwd))throw nativeError('unsupported','This conversation does not match this computer synchronized task inventory.');
    const remote=await this.worker.api('/v1/desktop/threads/'+encodeURIComponent(this.worker.config.nodeId)+'/'+encodeURIComponent(spec.desktopThreadId));
    if(remote?.nodeId!==this.worker.config.nodeId||remote.threadId!==spec.desktopThreadId||remote.project!==spec.project||remote.archived||!sameNativePath(remote.cwd,local.cwd))throw nativeError('unsupported','The cloud conversation source changed; refresh the original task before sending.');
    if(!fs.existsSync(local.cwd)||!fs.statSync(local.cwd).isDirectory())throw nativeError('unsupported','The original conversation directory is missing.');
    await this.assertClaim(run);
    if(this.worker.store.get('nativeDelivery:'+run.task))throw nativeError('uncertain','This continuation already has a durable delivery intent; inspect the original conversation before any new message.','NATIVE_CONTINUATION_UNCERTAIN');
    return {...run,cwd:local.cwd,base:null,branch:null,resumeThreadId:spec.desktopThreadId,inputs:[],nativeContinuation:{threadId:spec.desktopThreadId,cwd:local.cwd,realRoot:fs.realpathSync.native(local.cwd)}};
  }
  async beforeTurn(run,control){
    if(control.cancelled||this.worker.stopping)throw nativeError('unsupported','Continuation was cancelled before sending.');await this.assertClaim(run);
    if(control.cancelled||this.worker.stopping)throw nativeError('unsupported','Continuation was cancelled before sending.');
    const key='nativeDelivery:'+run.task,prior=this.worker.store.get(key);if(prior)throw nativeError('uncertain','This continuation already has a durable delivery intent; it will not be sent twice.','NATIVE_CONTINUATION_UNCERTAIN');
    this.worker.store.put(key,{taskId:run.task,attemptId:run.attempt,threadId:run.spec.desktopThreadId,state:'sending',at:now()});
  }
  sent(run,turnId){this.worker.store.put('nativeDelivery:'+run.task,{taskId:run.task,attemptId:run.attempt,threadId:run.spec.desktopThreadId,turnId,state:'sent',at:now()});}
}
