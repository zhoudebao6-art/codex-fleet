import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC} from './codex.mjs';
import {readCompletionProof} from './completion-proof.mjs';
import {assert,within,mkdir,fileHash,now} from './common.mjs';

// Called only by the sole managed worker, for attempts it no longer executes.
// Uploads use the normal durable artifact path and server receipt validation.
export async function recoverCompletedAttempt(worker,taskId,{rpcFactory=c=>new CodexRPC(c,null)}={}){
  const {store,config}=worker,r=store.run(taskId);
  if(!r||r.status!=='uncertain'||worker.active.has(taskId)||worker.stopping||r.spec.desktopThreadId)return false;
  const mark=store.get('completionRecovery:'+taskId);
  if(Date.parse(mark?.retryAt)>Date.now())return false;
  let rpc;
  try{
    const cloud=await worker.api('/v1/tasks/'+encodeURIComponent(taskId));
    if(cloud.id!==taskId||cloud.target!==config.nodeId||cloud.attempt!==r.attempt||!['running','uncertain','claimed'].includes(cloud.status))return false;
    rpc=rpcFactory({...config,desktopSessionBridge:undefined});await rpc.start();
    const turn=store.get('executionTurn:'+taskId);
    const result=await readCompletionProof(rpc,{task:taskId,thread:r.thread,cwd:r.cwd,
      turnId:turn?.attempt===r.attempt?turn.turnId:null,legacy:!r.spec.resumeTaskId&&r.spec.intent!=='conversation'});
    if(!result)return false;
    const artifacts=[];
    if(result.status==='submitted')for(const relative of r.spec.outputs||[]){
      const file=within(r.cwd,relative);assert(fs.statSync(file).isFile(),'Expected output is not a file');
      const size=fs.statSync(file).size;assert(size<=(config.maxArtifactBytes||512*1024*1024),'Output exceeds artifact limit');
      const sha=fileHash(file),dest=path.join(mkdir(path.join(config.dataDir,'artifacts')),sha);
      if(!fs.existsSync(dest))fs.copyFileSync(file,dest);
      assert(fileHash(dest)===sha,'Recovered output snapshot changed');artifacts.push({sha,size,name:relative});
    }
    const latest=await worker.api('/v1/tasks/'+encodeURIComponent(taskId));
    assert(latest.attempt===r.attempt&&['running','uncertain','claimed'].includes(latest.status),'Cloud attempt changed during recovery');
    store.db.exec('BEGIN IMMEDIATE');
    try{
      const current=store.run(taskId);
      assert(!worker.active.has(taskId)&&!worker.stopping&&current?.status==='uncertain'&&current.attempt===r.attempt&&current.updated===r.updated,'Local attempt changed during recovery');
      store.update(taskId,{status:'uploading',result:worker.clean({...result,artifacts,cwd:r.cwd,desktop:{threadId:r.thread,connection:'desktop_shared',visibility:'not_verified'}})});
      worker.emit({type:'progress',taskId,attemptId:r.attempt,kind:'completion_reconciled',message:'已核验原对话结束，恢复原任务文件回传；没有重新执行。'});
      store.put('completionRecovery:'+taskId,{state:'recovered',at:now(),proof:result.completionProof});
      store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}
    return true;
  }catch(e){store.put('completionRecovery:'+taskId,{state:'waiting',at:now(),retryAt:new Date(Date.now()+60000).toISOString(),error:worker.clean(e.message)});return false;}
  finally{await rpc?.close();}
}
