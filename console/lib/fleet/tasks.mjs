import {attentionWhere,taskActions} from './attention.mjs';
import {visibleItem,visibleDirectory,visibleDesktop,consoleView} from './console-cleanup.mjs';
import {assert,hash,uid,now,json,parse,canonical,taskView,validateSpec,validId,validProject} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {can,writer,admin} from './auth.mjs';
import {nodeScope,assertNodeAccess,readAccess,CLAIM_ACTOR_TARGETS_SQL,TASK_CREATOR_CLAIM_GUARD} from './access.mjs';
import {fileRow} from './files.mjs';
import {validateTaskWorkspace,workspaceAccess} from './workspaces.mjs';
import {directoryFilter,sqlDirectory} from './project-paths.mjs';
import {advanceAutomations,AUTOMATION_CLAIM_GUARD} from './orchestration.mjs';
import {DELIVERY_CLAIM_GUARD} from './deliveries.mjs';
import {validateLocalDispatch} from './delivery-routing.mjs';
import {SKILL_CLAIM_GUARD,validateSkillCycleDispatch} from './skill-cycles.mjs';
import {MAINTENANCE_CLAIM_GUARD,validateMaintenanceDispatch} from './skill-maintenance.mjs';
import {nodeRuntime,runtimeIssue} from './runtime-readiness.mjs';
import {LOAD_CTE,CAPACITY_CLAIM_GUARD,capacityView} from './capacity.mjs';
import {CASE_CLAIM_GUARD,validateCaseDispatch} from './case-guards.mjs';
export const BUSY="'claimed','running','cancel_requested','uncertain'";
const collaborationOnly="json_extract(spec,'$.desktopThreadId') IS NULL AND COALESCE(json_extract(spec,'$.intent'),'collaboration')!='conversation'";
const TERMINAL="'accepted','submitted','failed','blocked','cancelled'";
const COMPLETED_AT="(SELECT MIN(e.created) FROM events e WHERE e.task=t.id AND e.type='finished' AND e.node=t.target AND json_extract(e.payload,'$.attemptId')=t.attempt AND json_extract(e.payload,'$.status')='submitted' AND t.status IN('submitted','accepted')) AS completedAt";
export async function taskAccess(db,n,id){const t=taskView(await first(db,'SELECT t.*,'+COMPLETED_AT+' FROM tasks t WHERE t.id=?',id));assert(t,'Task not found',404);assert(can(n,t.project),'Project access denied',403);await assertNodeAccess(db,n,t.target);
  const pending=await first(db,"SELECT count(*) AS count FROM automation_flows WHERE json_extract(declaration,'$.parentTaskId')=? AND status!='completed'",id);
  const children=await first(db,"SELECT count(*) AS count FROM tasks WHERE json_extract(spec,'$.parentId')=? AND status NOT IN('submitted','accepted')",id);
  t.coordination={pendingFlows:pending.count,pendingChildren:children.count,complete:pending.count===0&&children.count===0};
  if(t.status==='queued'){
    const node=await first(db,'SELECT capabilities,last_seen,max_running FROM nodes WHERE id=?',t.target),caps=parse(node?.capabilities)||{};
    const interactive=t.spec.intent==='conversation'||!!t.spec.desktopThreadId;
    const pendingDependency=await first(db,"SELECT 1 FROM json_each(?) j LEFT JOIN tasks p ON p.id=j.value WHERE p.id IS NULL OR p.status!='accepted' LIMIT 1",json(t.spec.dependencies||[]));
    const busy=await first(db,`SELECT count(*) AS count FROM tasks WHERE target=? AND status IN (${BUSY}) AND ${interactive?"(json_extract(spec,'$.intent')='conversation' OR json_extract(spec,'$.desktopThreadId') IS NOT NULL)":"COALESCE(json_extract(spec,'$.intent'),'collaboration')!='conversation' AND json_extract(spec,'$.desktopThreadId') IS NULL"}`,t.target);
    const limit=interactive?Number(caps.conversationSlots)||4:caps.parallelExecution?Number((await first(db,'SELECT value FROM settings WHERE key=?','parallel_limit:'+t.target))?.value)||4:node.max_running;
    const maintenance=await first(db,'SELECT node FROM node_maintenance WHERE node=? AND expires_at>?',t.target,now());
    t.runtime=nodeRuntime({...node,maintenance:{enabled:!!maintenance}});t.capacity=await capacityView(db,t.target,t.spec);
    t.waitReason=runtimeIssue({...node,capabilities:{...caps,ready:interactive?(caps.conversationReady??caps.ready):caps.ready},maintenance:{enabled:!!maintenance}},{requireDesktop:!!(t.spec.requireDesktop||t.spec.desktopThreadId)});
    t.waitReason=t.waitReason||(pendingDependency?'等待前置任务交付并确认':t.capacity?.reason)|| (busy.count>=limit?`此电脑已有 ${busy.count} 项发送或执行，达到当前上限 ${limit} 项`:'等待设备领取');
  }
  return t;
}
export async function submit(db,n,s,receipt=null,{automationId=null,desktopContinuation=false}={}){
  assert(s?.intent===undefined||['conversation','collaboration'].includes(s.intent),'Invalid dispatch intent');
  if(s?.intent==='conversation')assert(s.requireDesktop===true&&s.worktree===false&&!s.parentId&&!s.workflowId&&!s.resumeTaskId&&!(s.dependencies||[]).length,'Conversation cannot be a workflow step');
  assert(s?.requireDesktop===undefined||typeof s.requireDesktop==='boolean','Invalid desktop requirement');
  writer(n);assert(desktopContinuation||(!Object.hasOwn(s||{},'desktopThreadId')&&!Object.hasOwn(s||{},'desktopCwd')),'Direct native thread continuation is not supported',400,'NATIVE_CONTINUATION_UNSUPPORTED');validateSpec(s);assert(can(n,s.project),'Project access denied',403);await assertNodeAccess(db,n,s.targetNode);if(s.mode!==undefined)assert(['question','execute'].includes(s.mode),'Invalid task mode');const digest=hash(canonical(s)),old=await first(db,'SELECT * FROM tasks WHERE id=?',s.id);if(old){let sameCreator=old.creator===n.id;if(!sameCreator&&await first(db,'SELECT job_id FROM delivery_dispatch_fallbacks WHERE job_id=?',s.id)){await validateLocalDispatch(db,n,s);sameCreator=true;}assert(sameCreator&&old.spec_hash===digest,'Task ID already used with different request',409);if(receipt){await run(db,'INSERT OR IGNORE INTO receipts(node,id,body_hash) VALUES(?,?,?)',n.id,receipt.id,receipt.digest);assert((await first(db,'SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,receipt.id)).body_hash===receipt.digest,'Changed event body',409);}return taskView(old);}
  await validateLocalDispatch(db,n,s);
  await validateSkillCycleDispatch(db,n,s);
  await validateMaintenanceDispatch(db,n,s);
  await validateCaseDispatch(db,n,s);
  const target=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',s.targetNode);assert(target,'Unknown target node',404);assert(can(n,s.project)&&parse(target.projects).includes(s.project),'Project access denied',403);
  if(s.intent==='conversation')assert(parse(target.capabilities)?.conversationDispatch===true,'请先升级并连接此电脑的桌面联动，再新建对话。',409,'NODE_UPGRADE_REQUIRED');
  if(s.executionPolicy==='local')assert(parse(target.capabilities)?.localExecutionPolicy===true,'Upgrade the target adapter before using its local execution policy',409,'NODE_UPGRADE_REQUIRED');
  const reservation=await first(db,'SELECT s.flow,s.prepared_hash,f.creator,f.status FROM automation_steps s JOIN automation_flows f ON f.id=s.flow WHERE s.task_id=?',s.id);
  if(automationId)assert(reservation?.flow===automationId&&reservation.prepared_hash===digest&&reservation.creator===n.id&&reservation.status==='running','Automation dispatch is paused or its prepared declaration changed',409);
  else assert(!reservation,'Task ID is reserved for an automation step',409);
  await validateTaskWorkspace(db,n,s);
  for(const id of s.dependencies||[]){assert(id!==s.id,'Self dependency');const d=await taskAccess(db,n,id);assert(d.project===s.project,'Cross-project dependency denied');}
  if(s.parentId){let p=await taskAccess(db,n,s.parentId),depth=0;assert(p.project===s.project,'Cross-project parent denied');while(p){assert(++depth<9,'Maximum delegation depth exceeded');p=p.spec.parentId?await taskAccess(db,n,p.spec.parentId):null;}}
  let continuationThread=desktopContinuation?s.desktopThreadId:null;
  if(s.resumeTaskId){const prior=await taskAccess(db,n,s.resumeTaskId);assert(!prior.spec.desktopThreadId,'Continue this original Codex conversation through its dedicated message endpoint',409,'NATIVE_CONTINUATION_REQUIRED');assert(prior.project===s.project&&prior.target===s.targetNode&&['submitted','accepted','failed','blocked','cancelled'].includes(prior.status),'Resume task must be terminal on the same computer and project');assert((prior.spec.workspaceId||null)===(s.workspaceId||null),'Continuation must stay in the same workspace');assert(s.worktree===false,'Continuation requires worktree=false');continuationThread=prior.thread_id||null;
    // A historical generic task must not reopen a thread that has since entered
    // the native continuation path with its original saved policy.
    if(continuationThread)assert(!await first(db,"SELECT 1 FROM tasks WHERE target=? AND project=? AND json_extract(spec,'$.desktopThreadId')=? LIMIT 1",s.targetNode,s.project,continuationThread),'Continue this original Codex conversation through its dedicated message endpoint',409,'NATIVE_CONTINUATION_REQUIRED');
  }
  for(const i of s.inputs||[]){assert(await first(db,'SELECT 1 FROM files WHERE project=? AND sha=?',s.project,i.sha),'Input file is not complete in this project',409);const f=await fileRow(db,n,s.project,i.sha);assert(f.status==='complete'&&f.size===i.size,'Input file is not complete in this project',409);}
  const timestamp=now(),conditions=[],conditionArgs=[];
  conditions.push("NOT EXISTS(SELECT 1 FROM delivery_jobs dj JOIN delivery_batches db ON db.id=dj.batch_id WHERE dj.task_id=? AND json_array_length(db.routing)>0 AND db.status!=CASE dj.phase WHEN 'preflight' THEN 'preflight' ELSE 'producing' END)");
  conditionArgs.push(s.id);
  if(s.workflowId){
    assert(validId(s.workflowId),'Invalid workflow ID');
    const stopKey='workflow_cancelled:'+hash(json([n.id,s.project,s.workflowId]));
    assert(!await first(db,'SELECT key FROM settings WHERE key=?',stopKey),'Workflow was cancelled',409);
    conditions.push('NOT EXISTS(SELECT 1 FROM settings WHERE key=?)');conditionArgs.push(stopKey);
  }
  if(desktopContinuation){assert(s.mode==='execute'&&s.worktree===false&&validId(s.desktopThreadId)&&typeof s.desktopCwd==='string'&&!Object.hasOwn(s,'executionPolicy'),'Invalid trusted native continuation');}
  if(continuationThread){
    const sharedMessage=desktopContinuation&&parse(target.capabilities)?.conversationDispatch===true;
    conditions.push(`NOT EXISTS(SELECT 1 FROM tasks nt WHERE nt.target=? AND (nt.status IN(${sharedMessage?"'queued','claimed','uncertain','cancel_requested'":"'queued','claimed','running','uncertain','cancel_requested'"}) OR json_extract(nt.result,'$.desktop.state')='uncertain') AND (nt.thread_id=? OR json_extract(nt.spec,'$.desktopThreadId')=? OR EXISTS(SELECT 1 FROM tasks np WHERE np.id=json_extract(nt.spec,'$.resumeTaskId') AND np.thread_id=?)))`);
    conditionArgs.push(s.targetNode,continuationThread,continuationThread,continuationThread);
  }
  if(receipt){conditions.push('NOT EXISTS(SELECT 1 FROM receipts WHERE node=? AND id=?)');conditionArgs.push(n.id,receipt.id);}
  if(automationId){conditions.push("EXISTS(SELECT 1 FROM automation_steps ast JOIN automation_flows af ON af.id=ast.flow WHERE ast.task_id=? AND ast.flow=? AND ast.prepared_hash=? AND af.creator=? AND af.status='running')");conditionArgs.push(s.id,automationId,digest,n.id);}
  else {conditions.push('NOT EXISTS(SELECT 1 FROM automation_steps WHERE task_id=?)');conditionArgs.push(s.id);}
  const statements=[
    ['INSERT OR IGNORE INTO tasks(id,creator,target,project,status,spec,spec_hash,created,updated) SELECT ?,?,?,?,?,?,?,?,? WHERE '+conditions.join(' AND '),s.id,n.id,s.targetNode,s.project,'queued',json(s),digest,timestamp,timestamp,...conditionArgs],
    ["INSERT OR IGNORE INTO artifact_refs(task,sha,name,direction) SELECT t.id,json_extract(j.value,'$.sha'),json_extract(j.value,'$.name'),'input' FROM tasks t,json_each(t.spec,'$.inputs') j WHERE t.id=? AND t.creator=? AND t.spec_hash=?",s.id,n.id,digest],
    ["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,creator,id,'submitted','{}',? FROM tasks WHERE id=? AND creator=? AND spec_hash=?",'task-created:'+s.id,timestamp,s.id,n.id,digest]
  ];if(receipt)statements.push(['INSERT OR IGNORE INTO receipts(node,id,body_hash) SELECT ?,?,? FROM tasks WHERE id=? AND creator=? AND spec_hash=?',n.id,receipt.id,receipt.digest,s.id,n.id,digest]);await batch(db,statements);if(receipt)assert((await first(db,'SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,receipt.id))?.body_hash===receipt.digest,'Changed event body',409);const result=await first(db,'SELECT * FROM tasks WHERE id=?',s.id);if(continuationThread)assert(result,'This conversation already has a queued or active continuation',409,desktopContinuation?'NATIVE_CONTINUATION_PENDING':'TASK_CONTINUATION_PENDING');assert(result&&result.creator===n.id&&result.spec_hash===digest,'Task ID conflict',409);return taskView(result);
}
export async function message(db,n,taskId,b,receipt=null){writer(n);await taskAccess(db,n,taskId);assert(typeof b.text==='string'&&b.text.length>0&&b.text.length<=16000,'Invalid message');const id=b.id||uid();assert(validId(id),'Invalid message id');const ts=now(),statements=[['INSERT OR IGNORE INTO messages(id,task,sender,text,created) SELECT ?,?,?,?,?'+(receipt?' WHERE NOT EXISTS(SELECT 1 FROM receipts WHERE node=? AND id=?)':''),id,taskId,n.id,b.text,ts,...(receipt?[n.id,receipt.id]:[])],["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,sender,task,'message',?,created FROM messages WHERE id=? AND sender=? AND task=? AND text=?",'message:'+id,json({messageId:id}),id,n.id,taskId,b.text]];if(receipt)statements.push(['INSERT OR IGNORE INTO receipts(node,id,body_hash) SELECT ?,?,? FROM messages WHERE id=? AND sender=? AND task=? AND text=?',n.id,receipt.id,receipt.digest,id,n.id,taskId,b.text]);await batch(db,statements);if(receipt)assert((await first(db,'SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,receipt.id))?.body_hash===receipt.digest,'Changed event body',409);const m=await first(db,'SELECT * FROM messages WHERE id=?',id);assert(m&&m.sender===n.id&&m.task===taskId&&m.text===b.text,'Message ID conflict',409);return m;}
async function ingest(db,n,e){
  assert(validId(e.id)&&typeof e.type==='string','Invalid event');const digest=hash(canonical(e)),previous=await first(db,'SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,e.id);if(previous){assert(previous.body_hash===digest,'Changed event body',409);return;}
  if(e.type==='assign')await submit(db,n,e.spec,{id:e.id,digest});
  else if(e.type==='message')await message(db,n,e.taskId,{id:e.id,text:e.text},{id:e.id,digest});
  else {
    const t=await taskAccess(db,n,e.taskId);assert(t.target===n.id&&t.attempt===e.attemptId,'Task attempt owner mismatch',409);assert(['started','progress','uncertain','finished'].includes(e.type),'Unknown event type');assert(json(e).length<=256000,'Event too large',413);
    const guard=' AND NOT EXISTS(SELECT 1 FROM receipts WHERE node=? AND id=?)',q=[];const ts=now();
    if(e.type==='started')q.push([`UPDATE tasks SET status='running',thread_id=COALESCE(?,thread_id),updated=? WHERE id=? AND target=? AND attempt=? AND status IN ('claimed','running','uncertain')${guard}`,e.threadId||null,ts,t.id,n.id,e.attemptId,n.id,e.id]);
    else if(e.type==='progress'&&e.threadId)q.push([`UPDATE tasks SET thread_id=COALESCE(thread_id,?),updated=? WHERE id=? AND target=? AND attempt=? AND status IN (${BUSY})${guard}`,e.threadId,ts,t.id,n.id,e.attemptId,n.id,e.id]);
    else if(e.type==='uncertain')q.push([`UPDATE tasks SET status='uncertain',updated=? WHERE id=? AND target=? AND attempt=? AND status IN ('claimed','running','uncertain')${guard}`,ts,t.id,n.id,e.attemptId,n.id,e.id]);
    else if(e.type==='finished'){
      assert(['submitted','failed','blocked','cancelled'].includes(e.status),'Invalid finish status');
      if(e.status==='submitted'){
        const expected=t.spec.outputs||[],refs=await all(db,"SELECT r.name,f.status FROM artifact_refs r LEFT JOIN files f ON f.sha=r.sha AND f.project=? WHERE r.task=? AND r.direction='output'",t.project,t.id);
        assert(expected.every(name=>refs.some(r=>r.name===name&&r.status==='complete')),'Task outputs are not fully uploaded',409);
      }
      q.push([`UPDATE tasks SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,result=CASE WHEN status='cancel_requested' THEN json_set(?,'$.status','cancelled') ELSE ? END,thread_id=COALESCE(?,thread_id),updated=? WHERE id=? AND target=? AND attempt=? AND status IN (${BUSY})${guard}`,e.status,json(e.result||{}),json(e.result||{}),e.threadId||null,ts,t.id,n.id,e.attemptId,n.id,e.id]);
    }
    q.push([`INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM receipts WHERE node=? AND id=?)`,'node:'+n.id+':'+e.id,n.id,t.id,e.type,json(e),ts,n.id,e.id]);
    q.push(['INSERT OR IGNORE INTO receipts(node,id,body_hash) VALUES(?,?,?)',n.id,e.id,digest]);await batch(db,q);
  }
  const receipt=await first(db,'SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,e.id);assert(receipt?.body_hash===digest,'Changed event body',409);
}
export async function sync(db,n,b){
  assert(!n.admin&&!n.browser,'Node token required',403);assert(Array.isArray(b.events||[])&&(b.events||[]).length<=100,'Invalid event batch');const ack=[];for(const e of b.events||[]){await ingest(db,n,e);ack.push(e.id);}
  const caps=b.capabilities||{};assert(json(caps).length<=128000,'Capabilities too large');const fingerprint=typeof caps.accountFingerprint==='string'&&/^[a-f0-9]{64}$/.test(caps.accountFingerprint)?caps.accountFingerprint:null;
  const previousCaps=parse(n.capabilities??(await first(db,'SELECT capabilities FROM nodes WHERE id=?',n.id))?.capabilities)||{};delete caps.desktopHealthReceivedAt;
  if(caps.desktopBridgeHealth?.checkedAt){caps.desktopHealthReceivedAt=previousCaps.desktopBridgeHealth?.checkedAt===caps.desktopBridgeHealth.checkedAt?(previousCaps.desktopHealthReceivedAt||now()):now();}
  // A transient probe must not release the account semaphore of an active turn.
  // Move to a newly observed account only after this node has no busy attempts.
  await run(db,`UPDATE nodes SET last_seen=?,capabilities=?,fingerprint=CASE WHEN ? IS NULL THEN fingerprint WHEN fingerprint IS NULL OR NOT EXISTS(SELECT 1 FROM tasks WHERE target=nodes.id AND status IN (${BUSY})) THEN ? ELSE fingerprint END WHERE id=? AND revoked=0`,now(),json(caps),fingerprint,fingerprint,n.id);
  await advanceAutomations(db,{limit:10});
  if((caps.ready===true||caps.conversationReady===true)&&caps.executorState!=='blocked'&&caps.executorState!=='checking'&&caps.desktopBridgeHealth?.ready!==false){const attempt=uid(),ts=now();
    // The eligibility predicates run in the same SQL write as the claim. A separate
    // read/count followed by UPDATE would race across independent Worker isolates.
    const claim=`WITH ${CLAIM_ACTOR_TARGETS_SQL}, ${LOAD_CTE} UPDATE tasks SET status='claimed',attempt=?,updated=? WHERE id=(
      SELECT t.id FROM tasks t JOIN nodes owner ON owner.id=t.target
      WHERE t.target=? AND t.status='queued' AND owner.revoked=0
      AND NOT EXISTS(SELECT 1 FROM settings WHERE key='delivery_controller_lock' AND json_extract(value,'$.recovery')=1 AND json_extract(value,'$.expiresAt')>?)
      AND NOT EXISTS(SELECT 1 FROM node_maintenance nm WHERE nm.node=owner.id AND nm.expires_at>?)
      AND (json_extract(t.spec,'$.desktopThreadId') IS NULL OR json_extract(owner.capabilities,'$.desktopContinuation')=1)
      AND (COALESCE(json_extract(t.spec,'$.requireDesktop'),0)!=1 OR json_extract(owner.capabilities,'$.desktopSessionBridge')=1)
      AND (json_extract(owner.capabilities,'$.desktopBridgeHealth.checkedAt') IS NULL OR julianday(COALESCE(json_extract(owner.capabilities,'$.desktopHealthReceivedAt'),json_extract(owner.capabilities,'$.desktopBridgeHealth.checkedAt')))>=julianday('now','-120 seconds'))
      AND (COALESCE(json_extract(t.spec,'$.executionPolicy'),'project')!='local' OR json_extract(owner.capabilities,'$.localExecutionPolicy')=1)
      AND (json_extract(t.spec,'$.workspaceId') IS NULL OR (json_extract(owner.capabilities,'$.workspaceExecution')=1 AND EXISTS(SELECT 1 FROM project_workspaces w WHERE w.id=json_extract(t.spec,'$.workspaceId') AND w.node=owner.id AND w.project=t.project AND w.status='ready')))
      ${AUTOMATION_CLAIM_GUARD}
      ${DELIVERY_CLAIM_GUARD}
      ${SKILL_CLAIM_GUARD}
      ${MAINTENANCE_CLAIM_GUARD}
      ${TASK_CREATOR_CLAIM_GUARD}
      ${CASE_CLAIM_GUARD}
      ${CAPACITY_CLAIM_GUARD}
      AND EXISTS(SELECT 1 FROM json_each(owner.capabilities,'$.projects') p WHERE p.value=t.project)
      AND NOT EXISTS(SELECT 1 FROM json_each(t.spec,'$.dependencies') d LEFT JOIN tasks dep ON dep.id=d.value WHERE dep.id IS NULL OR dep.status!='accepted')
      AND (
        (json_extract(owner.capabilities,'$.conversationReady')=1
         AND json_extract(owner.capabilities,'$.conversationDispatch')=1
         AND (json_extract(t.spec,'$.intent')='conversation' OR json_extract(t.spec,'$.desktopThreadId') IS NOT NULL)
         AND (EXISTS(SELECT 1 FROM fleet_load fl WHERE fl.node=owner.id AND fl.unit=json_extract(t.spec,'$.desktopThreadId')) OR (SELECT count(*) FROM tasks cb WHERE cb.target=owner.id AND cb.status IN (${BUSY}) AND (json_extract(cb.spec,'$.intent')='conversation' OR json_extract(cb.spec,'$.desktopThreadId') IS NOT NULL)) < MIN(8,MAX(1,COALESCE(json_extract(owner.capabilities,'$.conversationSlots'),1)))))
        OR
        (json_extract(owner.capabilities,'$.ready')=1 AND COALESCE(json_extract(t.spec,'$.intent'),'collaboration')!='conversation' AND (json_extract(t.spec,'$.desktopThreadId') IS NULL OR json_extract(owner.capabilities,'$.conversationDispatch') IS NOT 1)
      AND (SELECT count(*) FROM tasks busy WHERE busy.target=owner.id AND busy.status IN (${BUSY}) AND (json_extract(owner.capabilities,'$.parallelExecution') IS NOT 1 OR (COALESCE(json_extract(busy.spec,'$.intent'),'collaboration')!='conversation' AND json_extract(busy.spec,'$.desktopThreadId') IS NULL)))<CASE WHEN json_extract(owner.capabilities,'$.parallelExecution')=1 THEN MIN(COALESCE(CAST((SELECT value FROM settings WHERE key='parallel_limit:'||owner.id) AS INTEGER),4),MAX(1,COALESCE(json_extract(owner.capabilities,'$.maxRunning'),1))) ELSE owner.max_running END
      AND (json_extract(owner.capabilities,'$.parallelExecution')=1 OR NOT EXISTS(SELECT 1 FROM tasks busy WHERE busy.target=owner.id AND busy.project=t.project AND busy.status IN (${BUSY})))
      AND NOT EXISTS(SELECT 1 FROM tasks busy WHERE busy.target=owner.id AND busy.project=t.project AND busy.status IN (${BUSY}) AND COALESCE(json_extract(busy.spec,'$.workspaceId'),'')=COALESCE(json_extract(t.spec,'$.workspaceId'),'') AND json_extract(t.spec,'$.worktree')=0 AND json_extract(busy.spec,'$.worktree')=0 AND EXISTS(SELECT 1 FROM json_each(t.spec,'$.outputs') a JOIN json_each(busy.spec,'$.outputs') b ON lower(replace(a.value,'\\','/'))=lower(replace(b.value,'\\','/'))))
      ))
      ORDER BY CASE WHEN json_extract(t.spec,'$.desktopThreadId') IS NOT NULL THEN 0 WHEN json_extract(t.spec,'$.intent')='conversation' THEN 1 ELSE 2 END,t.created,t.id LIMIT 1) AND status='queued'`;
    await batch(db,[[claim,attempt,ts,n.id,ts,ts],["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,'hub',id,'claimed',?,? FROM tasks WHERE target=? AND attempt=? AND status='claimed'",'claim:'+attempt,json({attemptId:attempt,node:n.id}),ts,n.id,attempt]]);
  }
  const active=(await all(db,`SELECT * FROM tasks WHERE target=? AND status IN (${BUSY}) ORDER BY created`,n.id)).map(taskView);return {parallelLimit:Number((await first(db,"SELECT value FROM settings WHERE key=?",'parallel_limit:'+n.id))?.value)||4,ack,tasks:active,serverTime:now(),protocol:1,nextPollMs:caps.conversationDispatch?1000:active.length?2000:10000};
}
export async function changeTask(db,n,id,action,b){const t=await taskAccess(db,n,id),ts=now(),eventId=uid();writer(n);
  if(action==='accept')assert(t.coordination.complete,'总控仍有未完成的子任务或流程，不能确认整批完成。',409,'COORDINATION_INCOMPLETE');
  if(action==='accept'){assert(n.admin||t.creator===n.id||await first(db,"SELECT 1 FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id WHERE j.task_id=? AND b.controller=? AND json_extract(j.verified,'$.passed')=1 AND b.status IN('preflight','producing','collecting')",id,n.id),'Only task creator or verified delivery controller may accept',403);assert(typeof b.note==='string'&&b.note.length>0&&b.note.length<=16000,'Acceptance evidence note required');assert(['submitted','accepted'].includes(t.status),'Task not submitted',409);await batch(db,[["UPDATE tasks SET status='accepted',updated=? WHERE id=? AND status IN ('submitted','accepted')",ts,id],["INSERT INTO events(id,node,task,type,payload,created) SELECT ?,?,id,'accepted',?,? FROM tasks WHERE id=? AND status='accepted'",eventId,n.id,json({note:b.note}),ts,id]]);}
  else if(action==='cancel'){assert(n.admin||t.creator===n.id||t.target===n.id||n.nodeId===t.target||await first(db,'SELECT 1 FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id WHERE j.task_id=? AND b.controller=?',id,n.id),'Cannot cancel',403);assert(['queued','claimed','running','uncertain','cancel_requested','blocked','cancelled'].includes(t.status),'Task is terminal',409);await batch(db,[[`UPDATE tasks SET status=CASE WHEN status='queued' OR (status='blocked' AND COALESCE(json_extract(result,'$.desktop.state'),'')!='uncertain') THEN 'cancelled' ELSE 'cancel_requested' END,updated=? WHERE id=? AND status IN ('queued','blocked',${BUSY})`,ts,id],["INSERT INTO events(id,node,task,type,payload,created) SELECT ?,?,id,'cancel_requested','{}',? FROM tasks WHERE id=? AND status IN ('cancelled','cancel_requested')",eventId,n.id,ts,id]]);}
  else if(action==='resolve'){admin(n);assert(b.confirmStopped===true&&typeof b.note==='string'&&b.note.length>0&&b.note.length<=16000,'Confirm stopped process and supply evidence');assert(['uncertain','cancel_requested'].includes(t.status)||(t.spec.desktopThreadId&&t.result?.desktop?.state==='uncertain'),'Task not uncertain',409);await batch(db,[["UPDATE tasks SET status='failed',result=?,updated=? WHERE id=? AND (status IN ('uncertain','cancel_requested') OR (json_extract(spec,'$.desktopThreadId') IS NOT NULL AND json_extract(result,'$.desktop.state')='uncertain'))",json({error:'Operator resolved uncertain attempt',note:b.note}),ts,id],["INSERT INTO events(id,node,task,type,payload,created) SELECT ?,?,id,'resolved',?,? FROM tasks WHERE id=? AND status='failed'",eventId,n.id,json(b),ts,id]]);}
  const result=await taskAccess(db,n,id);assert(action==='cancel'?['cancelled','cancel_requested'].includes(result.status):action==='accept'?result.status==='accepted':result.status==='failed','Task changed before the action could be applied',409);return result;
}
export async function listNodes(db,n){return (await all(db,'SELECT n.*,(SELECT CAST(value AS INTEGER) FROM settings WHERE key=\'parallel_limit:\'||n.id) AS parallel_limit,g.name AS display_group_name,m.expires_at AS maintenance_expires,m.reason AS maintenance_reason FROM nodes n LEFT JOIN device_groups g ON g.id=n.display_group_id LEFT JOIN node_maintenance m ON m.node=n.id WHERE '+nodeScope(n,'n.id')+' ORDER BY n.name')).filter(x=>n.admin||(n.browser&&n.kind!=='device')||parse(x.projects).some(p=>can(n,p))).map(x=>({id:x.id,name:x.name,code:x.name,displayName:x.display_name||x.name,groupId:x.display_group_id||null,groupName:x.display_group_name||null,...(n.admin?{consoleRole:x.console_role,consoleAccess:readAccess(x.console_access)}:{}),projects:parse(x.projects),accountGroup:x.account_group,effectiveAccountGroup:x.fingerprint?'account-'+x.fingerprint.slice(0,12):x.account_group,lastSeen:x.last_seen,online:!!x.last_seen&&Date.now()-Date.parse(x.last_seen)<60000,revoked:!!x.revoked,parallelLimit:x.parallel_limit||4,capabilities:parse(x.capabilities),maintenance:{enabled:!!x.maintenance_expires&&x.maintenance_expires>now(),expiresAt:x.maintenance_expires||null,reason:x.maintenance_expires&&x.maintenance_expires>now()?x.maintenance_reason:null}})).map(x=>({...x,runtime:nodeRuntime(x)}));}
export async function listTasks(db,n,url){const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||500)),target=url.searchParams.get('target'),status=url.searchParams.get('status'),where=[nodeScope(n,'target')],args=[];if(consoleView(n))where.push(visibleItem('task','tasks.id'),collaborationOnly);if(!n.admin&&(!n.browser||n.kind==='device')){where.push('project IN (SELECT value FROM json_each(?))');args.push(n.projects);}if(target){where.push('target=?');args.push(target);}if(status){where.push('status=?');args.push(status);}const rows=await all(db,'SELECT * FROM tasks'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY created DESC,id DESC LIMIT ?',...args,limit);return rows.map(taskView);}
export async function taskStats(db,n) {
  const scoped=!n.admin&&(!n.browser||n.kind==='device'),rows=await all(db,'SELECT target,status,count(*) AS count FROM tasks WHERE '+nodeScope(n,'target')+(consoleView(n)?' AND '+visibleItem('task','tasks.id')+' AND '+collaborationOnly:'')+(scoped?' AND project IN (SELECT value FROM json_each(?))':'')+' GROUP BY target,status ORDER BY target,status',...(scoped?[n.projects]:[]));
  const byStatus={},nodes=new Map();let total=0;
  for(const row of rows){total+=row.count;byStatus[row.status]=(byStatus[row.status]||0)+row.count;let node=nodes.get(row.target);if(!node){node={nodeId:row.target,total:0,byStatus:{}};nodes.set(row.target,node);}node.total+=row.count;node.byStatus[row.status]=row.count;}
  return {total,byStatus,byNode:[...nodes.values()]};
}
export async function attentionStats(db,n) {
  const scoped=!n.admin&&(!n.browser||n.kind==='device');
  const where=nodeScope(n,'t.target')+(consoleView(n)?' AND '+visibleItem('task','t.id'):'')+(scoped?' AND t.project IN (SELECT value FROM json_each(?))':'');
  const rows=await all(db,`SELECT t.target AS nodeId,COALESCE(SUM(CASE WHEN ${attentionWhere(n,'action')} THEN 1 ELSE 0 END),0) AS action,COALESCE(SUM(CASE WHEN ${attentionWhere(n,'confirm')} THEN 1 ELSE 0 END),0) AS confirm FROM tasks t WHERE ${where} GROUP BY t.target`,...(scoped?[n.projects]:[]));
  const byNode=rows.filter(r=>r.action+r.confirm>0).map(r=>({...r,total:r.action+r.confirm}));
  const action=byNode.reduce((sum,r)=>sum+r.action,0),confirm=byNode.reduce((sum,r)=>sum+r.confirm,0);
  return {action,confirm,total:action+confirm,nodeId:n.kind==='device'?n.nodeId:null,byNode};
}
export async function tasksPage(db,n,url) {
  const limit=Number(url.searchParams.get('limit')||50),target=url.searchParams.get('target')||null,status=url.searchParams.get('status')||null,q=(url.searchParams.get('q')||'').trim(),workspaceId=url.searchParams.get('workspaceId')||null,cwd=directoryFilter(url.searchParams.get('cwd')||url.searchParams.get('root')),project=url.searchParams.get('project')||null,phase=url.searchParams.get('phase')||'all';
  assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Invalid task page size');assert(!target||validId(target),'Invalid target node');assert(q.length<=300,'Task search is too long');
  assert(!status||['queued','claimed','running','cancel_requested','uncertain','submitted','accepted','failed','blocked','cancelled'].includes(status),'Invalid task status');
  const attention=url.searchParams.get('attention')||null;assert(!attention||['action','confirm'].includes(attention),'Invalid attention category');
  const scoped=!n.admin&&(!n.browser||n.kind==='device'),where=[nodeScope(n,'target')],args=[],scope=scoped?[...parse(n.projects)].sort():null;if(consoleView(n))where.push(visibleItem('task','t.id'));
  assert(['all','active','completed'].includes(phase),'Invalid task phase');assert(!project||validProject(project),'Invalid project');assert(!cwd||target,'Directory filter requires a target computer');
  if(scoped){where.push('project IN (SELECT value FROM json_each(?))');args.push(json(scope));}
  if(!attention&&url.searchParams.get('source')==='collaboration')where.push("json_extract(spec,'$.desktopThreadId') IS NULL AND COALESCE(json_extract(spec,'$.intent'),'collaboration')!='conversation'");
  if(attention)where.push(attentionWhere(n,attention));
  if(target){where.push('target=?');args.push(target);}if(status){where.push('status=?');args.push(status);}
  if(project){assert(can(n,project),'Project access denied',403);where.push('project=?');args.push(project);}
  if(phase==='active')where.push("status IN('claimed','running','cancel_requested','uncertain')");if(phase==='completed')where.push("status IN('submitted','accepted')");
  const runtimeValue="CASE WHEN rt.type='object' THEN rt.value ELSE '{}' END",taskCwd="COALESCE((SELECT w.root FROM project_workspaces w WHERE w.id=json_extract(t.spec,'$.workspaceId') AND w.node=t.target AND w.project=t.project),json_extract(t.result,'$.cwd'),(SELECT d.cwd FROM desktop_threads d WHERE d.node=t.target AND d.thread_id=t.thread_id AND d.project=t.project),(SELECT json_extract("+runtimeValue+",'$.cwd') FROM nodes rn,json_each(rn.capabilities,'$.taskRuntime') rt WHERE rn.id=t.target AND json_extract("+runtimeValue+",'$.taskId')=t.id AND json_extract("+runtimeValue+",'$.attemptId')=t.attempt LIMIT 1))";
  if(workspaceId){const w=await workspaceAccess(db,n,workspaceId);assert(!target||target===w.node,'Workspace belongs to another computer');assert(!project||project===w.project,'Workspace belongs to another project');where.push("target=? AND project=? AND (json_extract(spec,'$.workspaceId')=?"+(w.root?` OR ${sqlDirectory(taskCwd)}=?`:'')+')');args.push(w.node,w.project,w.id,...(w.root?[directoryFilter(w.root)]:[]));}
  if(cwd){where.push(sqlDirectory(taskCwd)+'=?');args.push(cwd);}
  if(q){const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(id LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR json_extract(spec,'$.prompt') LIKE ? ESCAPE '\\')");args.push(like,like,like);}
  const signature=hash(canonical({source:url.searchParams.get('source'),target,status,q,scope,attention,actor:attention?n.id:null,device:attention?n.nodeId:null,access:n.browser?readAccess(n.access):null,workspaceId,cwd,project,phase})),pageWhere=[...where],pageArgs=[...args],raw=url.searchParams.get('cursor');
  if(raw){let cursor;assert(raw.length<=1000,'Invalid task cursor');try{cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{assert(false,'Invalid task cursor');}
    assert(cursor&&cursor.signature===signature&&validId(cursor.id)&&typeof cursor.created==='string'&&Number.isFinite(Date.parse(cursor.created)),'Invalid task cursor');
    pageWhere.push('(created<? OR (created=? AND id<?))');pageArgs.push(cursor.created,cursor.created,cursor.id);
  }
  const [rows,count]=await Promise.all([all(db,'SELECT t.*,'+COMPLETED_AT+' FROM tasks t WHERE '+pageWhere.join(' AND ')+' ORDER BY created DESC,id DESC LIMIT ?',...pageArgs,limit+1),first(db,'SELECT count(*) AS total FROM tasks t WHERE '+where.join(' AND '),...args)]);
  const page=rows.slice(0,limit),last=page.at(-1);return {tasks:page.map(row=>{const t=taskView(row);return {...t,actions:taskActions(n,t)};}),nextCursor:rows.length>limit?Buffer.from(json({signature,created:last.created,id:last.id})).toString('base64url'):null,total:count.total,serverTime:now()};
}
export async function events(db,n,{taskId,after=0,limit=100,tail=null}={}){
  if(taskId)await taskAccess(db,n,taskId);const scoped=!n.admin&&(!n.browser||n.kind==='device');
  const rows=await all(db,`SELECT e.*,COALESCE(source.display_name,source.name,a.username,m.email,e.node) AS nodeName,COALESCE(substr(json_extract(t.spec,'$.prompt'),1,100),e.task) AS taskName,t.project,t.target AS targetNode,COALESCE(target.display_name,target.name) AS targetName,msg.text AS messageText FROM events e LEFT JOIN nodes source ON source.id=e.node LEFT JOIN members m ON e.node='member:'||m.id LEFT JOIN local_accounts a ON a.member_id=m.id LEFT JOIN tasks t ON t.id=e.task LEFT JOIN nodes target ON target.id=t.target LEFT JOIN messages msg ON e.type='message' AND msg.id=json_extract(e.payload,'$.messageId') AND msg.task=e.task AND msg.sender=e.node WHERE e.seq>? AND ${nodeScope(n,'t.target')} ${consoleView(n)&&!taskId?'AND '+visibleItem('task','e.task'):''} ${n.admin?'':'AND e.task IS NOT NULL'} ${taskId?'AND e.task=?':''} ${scoped?'AND t.project IN (SELECT value FROM json_each(?))':''} ORDER BY e.seq ${tail===null?'ASC':'DESC'} LIMIT ?`,after,...(taskId?[taskId]:[]),...(scoped?[n.projects]:[]),Math.min(500,tail===null?limit:tail));
  if(tail!==null)rows.reverse();
  return rows.map(({messageText,...e})=>({...e,sourceId:e.node,sourceName:e.nodeName,payload:{...parse(e.payload),...(messageText!==null?{text:messageText,sender:e.node,sourceName:e.nodeName,targetNode:e.targetNode,targetName:e.targetName}:{})}}));
}
export async function taskDetail(db,n,id){const t=await taskAccess(db,n,id),files=await all(db,'SELECT r.sha,r.name,r.direction,f.size,f.status FROM artifact_refs r JOIN files f ON f.sha=r.sha AND f.project=? WHERE r.task=?',t.project,id);return {...t,actions:taskActions(n,t),artifacts:files.filter(x=>x.direction==='output'),inputs:files.filter(x=>x.direction==='input')};}
