import {all,first,run} from './db.mjs';
import {assert,hash,json,parse,now,validId,validProject} from './util.mjs';
import {can,writer} from './auth.mjs';
import {nodeScope,fileScope,assertNodeAccess} from './access.mjs';
import {consoleView,visibleItem} from './console-cleanup.mjs';
import {changeTask} from './tasks.mjs';
import {fileRow} from './files.mjs';

// Parallel/DAG runs remain backed by their original tasks. Reading this view
// never dispatches work, advances a task or fabricates an acceptance.
const keyFor=(creator,project,id)=>hash(json([creator,project,id]));
const active=new Set(['queued','claimed','running','cancel_requested']);
const summary=r=>String(r?.summary||r?.text||r?.finalAnswer||'').slice(0,1200);
async function rowsFor(db,creator,project,id){
  return all(db,"SELECT * FROM tasks WHERE creator=? AND project=? AND json_extract(spec,'$.workflowId')=? ORDER BY created,id",creator,project,id);
}
async function view(db,n,rows){
  const firstTask=rows[0],spec=parse(firstTask.spec),id=keyFor(firstTask.creator,firstTask.project,spec.workflowId);
  const record=await first(db,'SELECT value FROM settings WHERE key=?','workflow:'+id),meta=record?parse(record.value):null;
  const refs=await all(db,`SELECT r.task,r.direction,r.name,r.sha,f.size,f.status FROM artifact_refs r JOIN files f ON f.project=? AND f.sha=r.sha WHERE r.task IN(SELECT value FROM json_each(?)) AND ${fileScope(n,'f')} ORDER BY r.name`,firstTask.project,json(rows.map(t=>t.id)));
  const recent=await all(db,"SELECT e.task,e.payload,e.created FROM events e WHERE e.task IN(SELECT value FROM json_each(?)) AND e.seq=(SELECT MAX(e2.seq) FROM events e2 WHERE e2.task=e.task AND e2.type='progress')",json(rows.filter(t=>active.has(t.status)||t.status==='uncertain').map(t=>t.id)));
  const steps=rows.map(t=>{const s=parse(t.spec),result=parse(t.result),event=recent.find(e=>e.task===t.id),p=event?parse(event.payload):{};
    const progress=String(p.text||p.summary||p.message||(p.kind==='input_transfer'?'正在接收输入文件':p.kind==='output_transfer'?'正在回传结果文件':p.kind==='plan'?p.plan?.find(x=>x.status==='in_progress')?.step||'更新执行计划':p.tool?'正在使用 '+p.tool:'')).slice(0,1200);
    return {key:t.id,taskId:t.id,name:s.prompt.split(/\r?\n/)[0].slice(0,160),targetNode:t.target,status:t.status,updatedAt:event?.created||t.updated,summary:progress||summary(result),error:result?.error?String(result.error).slice(0,1200):null,dependencies:s.dependencies||[],inputs:refs.filter(r=>r.task===t.id&&r.direction==='input'),artifacts:refs.filter(r=>r.task===t.id&&r.direction==='output')};});
  let status=rows.some(t=>['failed','blocked','uncertain'].includes(t.status))?'needs_attention':rows.some(t=>t.status==='cancel_requested')?'cancelling':rows.some(t=>active.has(t.status))?'running':rows.some(t=>t.status==='cancelled')?'cancelled':'collecting';
  const artifacts=[];
  for(const ref of meta?.artifacts||[]){
    const file=await first(db,`SELECT sha,size,name,status FROM files WHERE project=? AND sha=? AND ${fileScope(n)}`,firstTask.project,ref.sha);
    if(file?.status==='complete'&&file.size===ref.size)artifacts.push(file);
  }
  if(rows.every(t=>t.status==='accepted')&&meta?.phase==='completed'&&artifacts.length>0&&artifacts.length===meta.artifacts.length&&json(meta.taskIds)===json(rows.map(t=>t.id).sort()))status='completed';
  return {id,kind:'parallel',workflowId:spec.workflowId,creator:firstTask.creator,project:firstTask.project,name:meta?.name||spec.workflowId,status,totalSteps:steps.length,steps,
    canManage:!!n.admin||((!n.browser||n.role==='operator')&&n.id===firstTask.creator),
    controllerNode:meta?.controllerNode||firstTask.creator,createdAt:firstTask.created,updatedAt:[...rows.map(t=>t.updated),meta?.updatedAt||''].sort().at(-1),
    controllerUpdatedAt:meta?.updatedAt||null,result:artifacts.length?{summary:meta?.summary||'',artifacts}:null};
}
export async function listWorkflows(db,n,url){
  const limit=Number(url.searchParams.get('limit')||20),cursor=Number(url.searchParams.get('cursor')||0);
  assert(Number.isSafeInteger(limit)&&limit>0&&limit<=50&&Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=100000,'Invalid workflow pagination');
  const access=[nodeScope(n,'t.target')];
  if(!n.admin&&(!n.browser||n.kind==='device'))access.push('t.project IN(SELECT value FROM json_each(?))');
  if(consoleView(n))access.push(visibleItem('task','t.id'));
  const args=!n.admin&&(!n.browser||n.kind==='device')?[n.projects]:[];
  const groups=await all(db,`SELECT t.creator,t.project,json_extract(t.spec,'$.workflowId') AS workflow_id,MAX(t.updated) AS updated
    FROM tasks t WHERE json_type(t.spec,'$.workflowId')='text' AND length(json_extract(t.spec,'$.workflowId')) BETWEEN 1 AND 100
    GROUP BY t.creator,t.project,json_extract(t.spec,'$.workflowId')
    HAVING SUM(CASE WHEN ${access.join(' AND ')} THEN 1 ELSE 0 END)=COUNT(*)
    ORDER BY updated DESC,t.creator,t.project,workflow_id LIMIT ? OFFSET ?`,...args,limit+1,cursor);
  const workflows=await Promise.all(groups.slice(0,limit).map(async g=>view(db,n,await rowsFor(db,g.creator,g.project,g.workflow_id))));
  return {workflows,nextCursor:groups.length>limit?String(cursor+limit):null,serverTime:now()};
}
async function controlledRows(db,n,b){
  assert(validId(b.workflowId)&&validProject(b.project),'Invalid workflow identity');
  const creator=b.creator||n.id;assert(typeof creator==='string'&&(n.admin||creator===n.id),'Only the workflow controller or administrator can change it',403);
  assert(can(n,b.project),'Project access denied',403);
  const rows=await rowsFor(db,creator,b.project,b.workflowId);assert(rows.length>0&&rows.length<=100,'Workflow tasks missing or too numerous',404);
  for(const t of rows)await assertNodeAccess(db,n,t.target);
  return rows;
}
export async function registerWorkflow(db,n,b){
  writer(n);const rows=await controlledRows(db,n,b),ids=rows.map(t=>t.id).sort();
  assert(typeof b.name==='string'&&b.name.trim()&&b.name.length<=160,'Workflow name required');
  assert(['running','collecting','completed'].includes(b.phase),'Invalid workflow phase');
  assert(Array.isArray(b.taskIds)&&json([...b.taskIds].sort())===json(ids),'Workflow task set changed',409);
  assert(typeof (b.summary||'')==='string'&&(b.summary||'').length<=4000,'Invalid workflow summary');
  const artifacts=b.artifacts||[];assert(Array.isArray(artifacts)&&artifacts.length<=20,'Invalid workflow artifacts');
  for(const ref of artifacts){const f=await fileRow(db,n,b.project,ref.sha);assert(f.status==='complete'&&f.size===ref.size,'Summary file has not finished uploading',409);}
  if(b.phase==='completed')assert(rows.every(t=>t.status==='accepted')&&artifacts.length>0,'Verify every task and upload summary files before completing the workflow',409);
  const id=keyFor(rows[0].creator,b.project,b.workflowId),previous=await first(db,'SELECT value FROM settings WHERE key=?','workflow:'+id);
  assert(!await first(db,'SELECT key FROM settings WHERE key=?','workflow_cancelled:'+id),'Workflow was cancelled',409);
  assert(!previous||parse(previous.value).phase!=='completed'||b.phase==='completed','Completed workflow cannot regress',409);
  const metadata={name:b.name.trim(),phase:b.phase,taskIds:ids,controllerNode:rows[0].creator,summary:b.summary||'',artifacts:artifacts.map(r=>({sha:r.sha,size:r.size})),updatedAt:now()};
  await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','workflow:'+id,json(metadata));
  return view(db,n,rows);
}
export async function cancelWorkflow(db,n,b){
  writer(n);const rows=await controlledRows(db,n,b);
  assert(rows.some(t=>active.has(t.status)||['uncertain','blocked'].includes(t.status)),'Workflow has no unfinished tasks',409);
  // Persist the stop before re-reading: late controller retries cannot add new
  // tasks between this request and the last worker acknowledgement.
  await run(db,'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)','workflow_cancelled:'+keyFor(rows[0].creator,b.project,b.workflowId),json({at:now(),by:n.id}));
  for(const t of await rowsFor(db,rows[0].creator,b.project,b.workflowId))if(active.has(t.status)||['uncertain','blocked'].includes(t.status))await changeTask(db,n,t.id,'cancel',{});
  return view(db,n,await rowsFor(db,rows[0].creator,b.project,b.workflowId));
}
