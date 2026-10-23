import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC,publicSanitizer} from './codex.mjs';
import {probeNativeWriterLock} from './native-continuation.mjs';
import {resumeNativeThread} from './native-policy.mjs';
import {now,assert} from './common.mjs';

// Cancellation is an execution fact, not a cloud status edit. Only a matching
// cancelled Fleet attempt with no local executor may enter this recovery path.
export async function reconcileCancellation({config,store,api,taskId,isActive=()=>false,stopping=()=>false},deps={}){
  const clean=publicSanitizer(config),initial=store.run(taskId);
  if(!initial||initial.status!=='uncertain'||isActive(taskId)||stopping())return {state:'not_eligible'};
  const previous=store.get('cancelRecovery:'+taskId);
  if(previous?.retryAt&&Date.parse(previous.retryAt)>Date.now())return {state:'backoff'};
  const lockFile=path.join(config.dataDir,'cancel-recovery.lock');let lock,rpc;
  try{lock=fs.openSync(lockFile,'wx');fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:now()}));}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    // Remove only a dead owner's unchanged lock. Permission errors and PID
    // reuse remain busy; they are not evidence that the owner has exited.
    try{const raw=fs.readFileSync(lockFile,'utf8'),owner=JSON.parse(raw);assert(Number.isSafeInteger(owner.pid)&&owner.pid>0,'Unknown lock owner');let gone=false;try{process.kill(owner.pid,0);}catch(err){gone=err.code==='ESRCH';}if(!gone||fs.readFileSync(lockFile,'utf8')!==raw)return {state:'busy'};fs.unlinkSync(lockFile);lock=fs.openSync(lockFile,'wx');fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:now()}));}catch{return {state:'busy'};}
  }
  const rpcFactory=deps.rpcFactory||((c)=>new CodexRPC(c,null));
  const operatorResolved=t=>t.status==='failed'&&t.result?.error==='Operator resolved uncertain attempt';
  const verifyCloud=async()=>{const t=await api('/v1/tasks/'+encodeURIComponent(taskId));assert(t.id===initial.task&&t.target===config.nodeId&&t.attempt===initial.attempt&&(t.status==='cancel_requested'||operatorResolved(t)),'Cancellation no longer matches the exact task attempt');return t;};
  try{
    const initialCloud=await verifyCloud();
    assert(initial.thread&&initial.cwd&&!initial.spec.desktopThreadId,'Cannot reconcile an unknown or native conversation automatically');
    assert(!store.runs().some(r=>r.task!==taskId&&r.thread===initial.thread&&['received','preparing','running','uncertain'].includes(r.status)),'Another task uses this conversation');
    let proof;
    if(config.desktopSessionBridge){
      rpc=rpcFactory(config);
      try{
        await rpc.start();
        const loaded=await rpc.call('thread/loaded/list',{},10000);
        if((loaded.data||[]).includes(initial.thread)){
          const {thread}=await rpc.call('thread/read',{threadId:initial.thread,includeTurns:false},10000);
          assert(thread?.id===initial.thread,'Desktop returned a different conversation');
          if(thread.status?.type==='idle')proof={method:'shared_executor_idle',threadId:initial.thread};
          else throw Error('Original desktop conversation is still active; cancellation is awaiting its executor');
        }
      }catch(e){if(/still active|different conversation/.test(e.message))throw e;}
      if(!proof){await rpc.close();rpc=null;}
    }
    if(!proof){
      // A fresh local reader does not prove absence of another writer. Check
      // exclusion using an inert isolated endpoint, then acquire the idle
      // original writer with its exact saved policy. Never start a new turn.
      const executable=fs.realpathSync.native(config.codexPath),stat=fs.statSync(executable),stamp=[executable.toLowerCase(),stat.size,stat.mtimeMs].join('|');
      let capability=store.get('cancelWriterCapability');
      if(capability?.stamp!==stamp||capability.supported!==true||!Number.isFinite(Date.parse(capability.checkedAt))||Math.abs(Date.now()-Date.parse(capability.checkedAt))>3600000){
        capability=await (deps.probe||probeNativeWriterLock)(config);
        assert(capability?.supported===true,'Codex writer exclusion is not verified');
        const after=fs.statSync(executable);assert([executable.toLowerCase(),after.size,after.mtimeMs].join('|')===stamp,'Codex changed during writer verification');
        store.put('cancelWriterCapability',{...capability,stamp});
      }
      rpc=rpcFactory({...config,desktopSessionBridge:undefined});await rpc.start();
      await (deps.resume||resumeNativeThread)(rpc,config,{threadId:initial.thread,cwd:initial.cwd,realRoot:fs.realpathSync.native(initial.cwd)});
      proof={method:'exclusive_idle_writer',threadId:initial.thread,capabilityCheckedAt:capability.checkedAt};
    }
    const finalCloud=await verifyCloud();
    assert(finalCloud.status===initialCloud.status,'Cloud resolution changed during verification');
    assert(!isActive(taskId)&&!stopping(),'Local executor changed during cancellation verification');
    const {thread}=await rpc.call('thread/read',{threadId:initial.thread,includeTurns:false},10000);
    assert(thread?.id===initial.thread&&thread.status?.type==='idle','Original conversation no longer idle');
    const resolved=operatorResolved(finalCloud),status=resolved?'failed':'cancelled';
    const result={...(resolved?initial.result||{}:{}),summary:resolved?'已核实原会话停止，保留网站操作员的结束决定。':'已核实原会话停止，取消完成。',artifacts:[],...(resolved?{operatorResolution:finalCloud.result}:{}),cancellation:{...proof,checkedAt:now(),attemptId:initial.attempt}};
    store.db.exec('BEGIN IMMEDIATE');
    try{
      const current=store.run(taskId);
      assert(current?.attempt===initial.attempt&&current.status==='uncertain'&&current.thread===initial.thread&&current.updated===initial.updated,'Local task changed during cancellation verification');
      store.update(taskId,{status,result});
      if(!resolved)store.emit({type:'finished',taskId,attemptId:initial.attempt,status:'cancelled',result});
      store.put('cancelRecovery:'+taskId,{state:resolved?'operator_resolved':'cancelled',at:now(),proof:result.cancellation});
      store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}
    return {state:resolved?'operator_resolved':'cancelled',taskId,proof:result.cancellation};
  }catch(e){const value={state:'waiting',at:now(),retryAt:new Date(Date.now()+60000).toISOString(),reason:clean(e.message)};store.put('cancelRecovery:'+taskId,value);return value;}
  finally{try{if(rpc)await rpc.close();}finally{fs.closeSync(lock);fs.unlinkSync(lockFile);}}
}
