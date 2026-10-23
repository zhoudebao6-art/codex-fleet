import crypto from 'node:crypto';
import {assert,now} from './common.mjs';

// The local response was already sent once. This durable queue acknowledges
// delivery to the hub only; retrying it must never invoke Codex or an approval.
export function queueInteractionResolution(worker,run,id){
  const key='interaction:'+id,record=worker.store.get(key);
  assert(record&&record.taskId===run.task&&record.attemptId===run.attempt,'Interaction does not belong to this task attempt');
  if(['resolved','ack_ended','sent_pending_ack'].includes(record.status))return;
  assert(record.status==='answer_received','Interaction answer has not been received');
  worker.store.put(key,{...record,status:'sent_pending_ack',sentAt:now(),ackFailures:0,ackRetryAt:0});
}

export async function retryInteractionResolutions(worker,{at=Date.now(),limit=4}={}){
  const rows=worker.store.db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'interaction:%' AND json_extract(value,'$.status')='sent_pending_ack' AND coalesce(json_extract(value,'$.ackRetryAt'),0)<=? ORDER BY coalesce(json_extract(value,'$.ackRetryAt'),0),key LIMIT ?").all(at,Math.max(1,Math.min(4,limit)));
  for(const row of rows){
    const record=JSON.parse(row.value),id=row.key.slice('interaction:'.length);
    try{
      const result=await worker.api(`/v1/tasks/${encodeURIComponent(record.taskId)}/interactions/${encodeURIComponent(id)}/resolve`,{method:'POST',body:{attemptId:record.attemptId},timeout:5000});
      assert(result?.status==='resolved'||result?.status==='expired','Unexpected interaction acknowledgement');
      worker.store.put(row.key,{...record,status:result.status==='resolved'?'resolved':'ack_ended',ackedAt:now(),ackRetryAt:null,ackError:result.status==='expired'?'Interaction expired':null});
    }catch(error){
      const message=worker.clean?worker.clean(String(error.message)).slice(0,500):String(error.message).slice(0,500);
      if([400,404,409,410,422].includes(error.status)){worker.store.put(row.key,{...record,status:'ack_ended',ackedAt:now(),ackRetryAt:null,ackError:message,ackHttpStatus:error.status});continue;}
      const failures=(record.ackFailures||0)+1,delay=Math.min(300000,Math.max(1000,error.retryAfterMs||Math.min(120000,1000*2**Math.min(failures,7))));
      worker.store.put(row.key,{...record,ackFailures:failures,ackRetryAt:at+delay,ackError:message});
    }
  }
  return rows.length;
}

// Only explicit, one-turn requests can be forwarded. Policies and permission
// extensions remain local; a remote task is never itself approval authority.
export function describeInteraction(message,clean=x=>x){
  const p=message.params||{},method=message.method;
  let kind,request;
  if(method==='mcpServer/elicitation/request'){
    kind='elicitation';request={serverName:p.serverName,mode:p.mode||'form',message:p.message,requestedSchema:p.requestedSchema,...(p.mode==='url'?{url:p.url}:{})};
  }else if(method==='item/tool/requestUserInput'||method==='tool/requestUserInput'){
    kind='questions';request={questions:p.questions};
  }else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
    if(p.additionalPermissions||p.proposedExecpolicyAmendment||p.proposedNetworkPolicyAmendments||p.networkApprovalContext||p.grantRoot)return null;
    // A reason alone is not enough information for informed remote approval.
    if(method==='item/fileChange/requestApproval'||typeof p.command!=='string'||!p.command.trim())return null;
    const decisions=p.availableDecisions===undefined?['accept','decline','cancel']:(Array.isArray(p.availableDecisions)?p.availableDecisions:[]).filter(x=>['accept','decline','cancel'].includes(x));
    if(!decisions.length)return null;
    kind='approval';request={command:p.command,reason:p.reason,cwd:p.cwd,availableDecisions:decisions};
  }else return null;
  const safe=clean(request);
  // Redaction must never hide part of the action the human is approving.
  if(kind==='approval'&&JSON.stringify(safe)!==JSON.stringify(request))return null;
  return {id:crypto.randomUUID(),kind,method,request:safe,expiresAt:new Date(Date.now()+15*60000).toISOString()};
}

export async function waitForInteraction(worker,run,interaction,signal){
  const route='/v1/tasks/'+encodeURIComponent(run.task)+'/interactions';
  const body={...interaction,attemptId:run.attempt};
  worker.store.put('interaction:'+interaction.id,{taskId:run.task,...body,status:'pending'});
  const control=worker.active.get(run.task);if(control)control.waitingInteraction=interaction.id;
  let published=false;
  try{
    while(!worker.stopping&&!signal.aborted&&Date.now()<Date.parse(interaction.expiresAt)){
      try{
        if(!published){await worker.api(route,{method:'POST',body});published=true;worker.emit({type:'progress',taskId:run.task,attemptId:run.attempt,kind:'interaction_pending',interactionId:interaction.id,message:'等待你在任务详情中回复',method:interaction.method});}
        const value=await worker.api(route),record=value.interactions?.find(x=>x.id===interaction.id);
        if(worker.stopping||signal.aborted)break;
        if(record?.status==='answered'&&record.attemptId===run.attempt){
          worker.store.put('interaction:'+interaction.id,{taskId:run.task,...body,status:'answer_received'});
          return record.response;
        }
        if(record&&['expired','resolved'].includes(record.status))throw Object.assign(Error('This interaction is no longer pending'),{permanent:true});
      }catch(error){if(error.permanent||error.status&&![408,425,429,500,502,503,504].includes(error.status))throw error;}
      await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,2000);signal.addEventListener('abort',finish,{once:true});});
    }
    throw Error(signal.aborted?'Task ended before the interaction was answered':'Interactive request expired; no approval was granted');
  }finally{if(control?.waitingInteraction===interaction.id)delete control.waitingInteraction;}
}
