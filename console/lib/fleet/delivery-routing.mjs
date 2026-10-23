import {assert,parse,json,hash,now,canonical,validId} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {workspaceAccess} from './workspaces.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {currentCreator} from './orchestration.mjs';
import {assertNodeAccess} from './access.mjs';
import {recordRecovery} from './delivery-loop.mjs';
import {submit} from './tasks.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';
import {regionalDispatchAllowed} from './regional-controllers.mjs';

const rootKey=s=>String(s).replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
export async function validateLocalControllers(db,actor,bindings){
 assert(Array.isArray(bindings)&&bindings.length<=200,'Invalid local controllers');
 const seen=new Set(),result=[];
 for(const b of bindings){
  assert(b&&['auto20','software'].includes(b.profile)&&[b.nodeId,b.workspaceId,b.threadId].every(validId),'Invalid local controller binding');
  const key=b.nodeId+':'+b.profile;assert(!seen.has(key),'Only one controller per device and automation');seen.add(key);
  const w=await workspaceAccess(db,actor,b.workspaceId);
  const thread=await first(db,'SELECT * FROM desktop_threads WHERE node=? AND thread_id=?',b.nodeId,b.threadId);
  assert(w.node===b.nodeId&&w.status==='ready'&&w.root&&thread&&!thread.archived&&thread.project===w.project&&rootKey(thread.cwd)===w.root_key,'Choose an existing conversation in this computer workspace',409);
  result.push({nodeId:b.nodeId,profile:b.profile,workspaceId:w.id,threadId:thread.thread_id,project:w.project,title:thread.title||w.name,workspaceName:w.name});
 }
 return result;
}
export function localRoute(row,node){return (parse(row.routing)||[]).find(r=>r.nodeId===node);}
export async function routingView(db,row){
 const routes=parse(row.routing)||[],handoffs=await all(db,'SELECT h.*,t.status AS task_status FROM delivery_handoffs h LEFT JOIN tasks t ON t.id=h.task_id WHERE h.batch_id=? ORDER BY h.created_at,h.id',row.id);
 const compensations=await all(db,'SELECT f.* FROM delivery_dispatch_fallbacks f JOIN delivery_jobs j ON j.id=f.job_id WHERE j.batch_id=?',row.id);
 const jobs=await all(db,'SELECT j.node,t.id,t.status FROM delivery_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.batch_id=?',row.id);
 return routes.map(r=>{
  const assigned=jobs.filter(j=>j.node===r.nodeId),messages=handoffs.filter(h=>h.node===r.nodeId);
  return {...r,compensations:compensations.filter(f=>assigned.some(j=>j.id===f.job_id)),assigned:assigned.filter(j=>j.id).length,total:assigned.length,
   state:assigned.length&&assigned.every(j=>j.id)?'delegated':messages.some(m=>['submitted','accepted'].includes(m.task_status))?'message_received':messages.some(m=>['uncertain','blocked','failed'].includes(m.task_status))?'needs_attention':'awaiting_controller',
   messages:messages.map(h=>({taskId:h.task_id,status:h.task_status||'pending',error:h.error}))};
 });
}
// Prepared job IDs are immutable. Only the selected local node can submit them,
// with the exact declared inputs, scope, destination and output contract.
export async function validateLocalDispatch(db,actor,spec){
 const row=await first(db,'SELECT j.spec,j.node,j.phase,b.* FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id WHERE j.task_id=?',spec.id);
 if(!row||!localRoute(row,row.node))return;
 const fallback=actor.id===row.controller&&await first(db,'SELECT job_id FROM delivery_dispatch_fallbacks WHERE job_id=?',spec.id);
 const configured=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 const delegate=localRoute(row,row.node)?.dispatcher;
 const regional=actor.id===delegate?.nodeId&&await regionalDispatchAllowed(db,configured||{},row,delegate);
 assert(!actor.browser&&!actor.admin&&(actor.id===row.node||fallback||regional),'This job is reserved for its registered controller',403);
 assert(canonical(parse(row.spec))===canonical(spec),'Local controller job contract changed',409);
 assert(row.status===(row.phase==='preflight'?'preflight':'producing'),'This batch is paused or stopped',409);
 assert(configured?.controller===row.controller&&!configured.excludedNodes.includes(row.node),'This device is not enabled for this batch',409);
 const creator=await currentCreator(db,{...row,project:spec.project});
 for(const id of parse(row.declaration).nodes)await assertNodeAccess(db,creator,id);
 await assertNodeAccess(db,creator,row.controller);
 if(regional)await assertNodeAccess(db,creator,delegate.nodeId);
}
export async function sendLocalHandoffs(db,actor,row){
 for(const route of parse(row.routing)||[]){
  const dispatcher=route.dispatcher||route;
  const pending=await all(db,'SELECT j.* FROM delivery_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.batch_id=? AND j.node=? AND t.id IS NULL ORDER BY j.phase,j.item_index,j.attempt',row.id,route.nodeId);
  if(!pending.length)continue;
  let dispatcherUnavailable=null;
  if(route.dispatcher){
   const peer=await first(db,'SELECT * FROM nodes WHERE id=?',dispatcher.nodeId),cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value)||{};
   dispatcherUnavailable=runtimeIssue(peer,{parallel:true})||(!await regionalDispatchAllowed(db,cfg,{...row,node:route.nodeId},dispatcher)?'区域协调授权已变更':null);
   if(dispatcherUnavailable){
    // Only children with no prepared message can be taken over immediately.
    for(const job of pending.filter(j=>!parse(j.spec).parentId))await fallbackDispatch(db,actor,row,job,'regional-'+dispatcher.nodeId,'regional_unavailable_before_send');
    // Existing acknowledgements still need reconciliation while this peer is
    // offline. Do not turn a lost heartbeat into a second unknown execution.
   }
  }
  // Recover any uncertain original send under its original ID. Never create a
  // second message just because its children have not arrived yet.
  const old=await all(db,'SELECT * FROM delivery_handoffs WHERE batch_id=? AND node=? ORDER BY created_at',row.id,route.nodeId);
  const covered=new Set(old.flatMap(h=>parse(h.job_ids)));
  const fresh=dispatcherUnavailable?[]:pending.filter(j=>!covered.has(j.id));
  for(let offset=0;offset<fresh.length;offset+=4){
   const group=fresh.slice(offset,offset+4),ids=group.map(j=>j.id),id='local-handoff-'+hash(row.id+':'+route.nodeId+':'+ids.join(',')).slice(0,36);
   const specs=group.map(j=>({...parse(j.spec),dependencies:[],parentId:id}));
   const scope=route.dispatcher?`区域协调接单：执行电脑 ${route.nodeId}，区域协调 ${dispatcher.nodeId}，全局主控 ${row.controller}。只转交下列已冻结任务到指定执行机；不得改换目标、复制凭据或另开制作。成果仍按原合同汇总回全局主控。`:'本机自动化总控接单';
   const prompt=`${scope}：${parse(row.declaration).name}\n批次 ${row.id}。沿用执行电脑已有技能、依赖、配置和原自动化环境，不另建总控，不重跑已完成案件；遵守执行电脑容量。\n先用 fleet_status 查询各固定编号；已有则跟踪。尚未存在时，用 fleet_assign 原样提交以下完整声明，保留 parentId、workspaceId、inputs、outputs、targetNode。不可改编号、目标或输出合同。负责跟踪与排障，不代签独立审核；消息接收、排队及协调对话结束都不代表交付完成。Fleet 根据真实文件和收据回传核验，断线后使用同一编号恢复。暂停或取消后不得派工，不接管无关对话，不复制其他电脑环境。\n${json(specs)}`;
   assert(prompt.length<=64000,'Controller batch message is too large');
   await batch(db,[
    ...specs.map(s=>['UPDATE delivery_jobs SET spec=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM tasks WHERE id=?)',json(s),s.id,s.id]),
    ['INSERT OR IGNORE INTO delivery_handoffs(id,batch_id,node,thread_id,task_id,job_ids,prompt,created_at) VALUES(?,?,?,?,?,?,?,?)',id,row.id,route.nodeId,dispatcher.threadId,id,json(ids),prompt,now()]
   ]);
  }
  // A controller can finish its message before submitting the child outbox.
  // Bounded follow-ups use the same job IDs and check both server and local
  // queues. Unknown delivery never enters this recovery path.
  for(const original of old.filter(h=>!h.parent_id)){
   const ids=parse(original.job_ids);
   if(!pending.some(j=>ids.includes(j.id)))continue;
   const chain=[original,...old.filter(h=>h.parent_id===original.id)];
   const latest=chain.at(-1),task=await first(db,'SELECT status,updated FROM tasks WHERE id=?',latest.task_id);
   if(task&&['uncertain','blocked','failed'].includes(task.status)){
    const full=await first(db,'SELECT result FROM tasks WHERE id=?',latest.task_id),result=parse(full?.result);
    // Only an explicit pre-send refusal permits direct dispatch. The exact
    // frozen child identity also makes a delayed local outbox harmless.
    if(task.status==='blocked'&&result?.desktop?.reason==='NATIVE_CONTINUATION_BUSY'&&result.desktop.state==='busy'){
     for(const job of pending.filter(j=>ids.includes(j.id)))await fallbackDispatch(db,actor,row,job,latest.task_id,'original_writer_busy_before_send');
     continue;
    }
    for(const job of pending.filter(j=>ids.includes(j.id)))await recordRecovery(db,row,job,'handoff','本机总控接单状态 '+task.status+'，需要核对原消息；未新建替代任务');
    continue;
   }
   if(!task||!['submitted','accepted'].includes(task.status)){
    if(dispatcherUnavailable&&Date.now()-Date.parse(latest.created_at)>5*60000)
     for(const job of pending.filter(j=>ids.includes(j.id)))await recordRecovery(db,row,job,'handoff','区域接单通道不可用：'+dispatcherUnavailable+'；原消息 '+(task?.status||'尚未提交')+'，保留原编号等待核实');
    continue;
   }
   if(Date.now()-Date.parse(task.updated)<120000)continue;
   for(const job of pending.filter(j=>ids.includes(j.id)))await fallbackDispatch(db,actor,row,job,latest.task_id,'acknowledged_without_dispatch');

  }
  for(const h of await all(db,'SELECT h.* FROM delivery_handoffs h LEFT JOIN tasks t ON t.id=h.task_id WHERE h.batch_id=? AND h.node=? AND t.id IS NULL',row.id,route.nodeId)){
   if(dispatcherUnavailable)continue;
   try{
    await continueDesktop(db,actor,dispatcher.nodeId,h.thread_id,{id:h.task_id,prompt:h.prompt});
    await run(db,'UPDATE delivery_handoffs SET error=NULL WHERE id=?',h.id);
   }catch(e){
    // Network/readiness faults retain the exact original message for reconnect.
    await run(db,'UPDATE delivery_handoffs SET error=? WHERE id=?',String(e.message).slice(0,500),h.id);
    if(Date.now()-Date.parse(h.created_at)>5*60000)for(const job of pending.filter(j=>parse(h.job_ids).includes(j.id)))await recordRecovery(db,row,job,'handoff','原接单通道连续不可用：'+String(e.message).slice(0,400));
   }
  }
 }
}
async function fallbackDispatch(db,actor,row,job,source,reason){
 if(actor.id!==row.controller||!['preflight','producing'].includes(row.status))return;
 await run(db,'INSERT OR IGNORE INTO delivery_dispatch_fallbacks(job_id,source_id,reason,created_at) VALUES(?,?,?,?)',job.id,source,reason,now());
 await submit(db,actor,parse(job.spec));
}
