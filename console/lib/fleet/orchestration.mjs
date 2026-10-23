import {visibleItem,visibleDirectory,visibleDesktop,consoleView} from './console-cleanup.mjs';
import {assert,now,json,parse,hash,canonical,validId,validProject,validateSpec,taskView} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {can,writer} from './auth.mjs';
import {withAccess,flowScope,assertNodeAccess} from './access.mjs';
import {validateTaskWorkspace} from './workspaces.mjs';
import {submit,taskAccess} from './tasks.mjs';
import {fileRow} from './files.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';

const SUCCESS=new Set(['submitted','accepted']);
const ATTENTION=new Set(['failed','blocked','uncertain','cancel_requested','cancelled']);
const ACTIVE="'claimed','running','uncertain','cancel_requested'";
const scoped=n=>!n.admin&&(!n.browser||n.kind==='device');
const identity=n=>n.id;
const creatorKind=n=>n.id==='admin'&&!n.browser?'service':n.kind==='device'?'device':!n.browser?'node':'member';
const pathKey=name=>name.replace(/\\/g,'/').toLowerCase();
export const automationTaskId=(id,index)=>'auto-'+hash(id).slice(0,40)+'-'+String(index+1).padStart(2,'0');

// The claim runs inside one SQL write. Pausing/revoking a flow owner after a
// scheduler read still cannot allow its queued step to start.
export const AUTOMATION_CLAIM_GUARD=`AND (
  NOT EXISTS(SELECT 1 FROM automation_steps acs WHERE acs.task_id=t.id)
  OR EXISTS(SELECT 1 FROM automation_steps acs JOIN automation_flows acf ON acf.id=acs.flow
    WHERE acs.task_id=t.id AND acf.status='running' AND (
      acf.creator_kind='service'
      OR (acf.creator_kind='node' AND EXISTS(SELECT 1 FROM nodes cn WHERE cn.id=acf.creator AND cn.revoked=0 AND EXISTS(SELECT 1 FROM json_each(cn.projects) cp WHERE cp.value=acf.project)))
      OR (acf.creator_kind IN('device','member')
        AND EXISTS(SELECT 1 FROM claim_actor_targets cat WHERE cat.creator=acf.creator AND cat.target=t.target)
        AND NOT EXISTS(SELECT 1 FROM json_each(acf.declaration,'$.steps') ags
          WHERE NOT EXISTS(SELECT 1 FROM claim_actor_targets cat WHERE cat.creator=acf.creator AND cat.target=json_extract(ags.value,'$.targetNode'))))
    )))`;

function short(value,name,max,{required=false}={}) {
  if(value===undefined||value===null){assert(!required,`${name} required`);return '';}
  assert(typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0),`Invalid automation ${name}`);return value;
}
function uniquePaths(paths) {
  const keys=paths.map(pathKey);assert(new Set(keys).size===keys.length,'Duplicate output paths on Windows');
  assert(!keys.some((key,i)=>keys.some((other,j)=>i!==j&&other.startsWith(key+'/'))),'Output file paths conflict with a parent path');
}
function declaration(b) {
  assert(b&&typeof b==='object'&&validId(b.id)&&validProject(b.project),'Invalid automation identity');
  const name=short(b.name,'name',160,{required:true});assert(Array.isArray(b.steps)&&b.steps.length>=2&&b.steps.length<=12,'An automation requires 2–12 sequential steps');
  const parallel=b.executionMode==='parallel';assert(b.executionMode===undefined||['parallel','sequential'].includes(b.executionMode),'Invalid execution mode');
  const keys=new Set(),steps=b.steps.map((input,index)=>{
    assert(input&&typeof input==='object','Invalid automation step');const key=input.key||'step-'+(index+1);assert(validId(key)&&!keys.has(key),'Invalid or repeated automation step key');keys.add(key);
    const mode=input.mode||'execute';
    const step={key,name:short(input.name,'step name',160,{required:true}),targetNode:input.targetNode,prompt:short(input.prompt,'step prompt',48000,{required:true}),mode,executionPolicy:input.executionPolicy||(mode==='execute'?'local':'project'),skills:input.skills||[],outputs:input.outputs||[],worktree:input.worktree??true,...(input.workspaceId?{workspaceId:input.workspaceId}:{})};
    assert(['execute','question'].includes(step.mode),'Invalid automation execution mode');
    if(parallel){
      assert(Array.isArray(input.dependsOn||[])&&new Set(input.dependsOn||[]).size===(input.dependsOn||[]).length&&(input.dependsOn||[]).every(k=>k!==key&&keys.has(k)),'Dependencies must refer to distinct earlier steps');
      Object.assign(step,{dependsOn:input.dependsOn||[],inputs:input.inputs||[],requireDesktop:input.requireDesktop!==false});
    }else if(input.requireDesktop!==undefined)step.requireDesktop=input.requireDesktop;
    validateSpec({...step,id:automationTaskId(b.id,index),project:b.project,dependencies:[],inputs:step.inputs||[]});
    assert(parallel||input.inputs===undefined||(Array.isArray(input.inputs)&&input.inputs.length===0),'Step inputs are supplied by the preceding completed step');
    uniquePaths(step.outputs);return step;
  });
  if(parallel){
    const ancestors=new Set(),visit=key=>{if(ancestors.has(key))return;ancestors.add(key);for(const dep of steps.find(s=>s.key===key).dependsOn)visit(dep);};visit(steps.at(-1).key);
    assert(ancestors.size===steps.length,'The final collection step must depend on every work branch');
    assert(steps.at(-1).outputs.length>0,'Declare at least one final collection output');
  }
  if(b.parentTaskId!==undefined)assert(validId(b.parentTaskId),'Invalid controller task');
  const value={id:b.id,name,project:b.project,steps,...(parallel?{executionMode:'parallel'}:{}),...(b.parentTaskId?{parentTaskId:b.parentTaskId}:{})};assert(Buffer.byteLength(json(value),'utf8')<=640000,'Automation declaration too large',413);return value;
}
export async function currentCreator(db,flow) {
  if(flow.creator_kind==='service')return {id:flow.creator,admin:true,browser:false,role:'admin'};
  if(flow.creator_kind==='device'){const node=await first(db,"SELECT * FROM nodes WHERE 'device:'||id=? AND revoked=0",flow.creator);assert(node&&node.console_role==='operator'&&parse(node.projects).includes(flow.project),'Device browser creator permission was revoked',403);return withAccess({...node,id:flow.creator,nodeId:node.id,kind:'device',browser:true,admin:false,role:node.console_role},node.console_access);}
  if(flow.creator_kind==='node') {
    const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',flow.creator);assert(node&&parse(node.projects).includes(flow.project),'Automation creator no longer has project access',403);
    return {...node,admin:false,browser:false,role:'node'};
  }
  const member=await first(db,"SELECT m.*,a.active AS account_active FROM members m LEFT JOIN local_accounts a ON a.member_id=m.id WHERE 'member:'||m.id=?",flow.creator);
  assert(member&&['admin','operator'].includes(member.role)&&member.account_active!==0,'Automation creator is disabled or cannot dispatch tasks',403);
  return withAccess({id:flow.creator,memberId:member.id,role:member.role,admin:member.role==='admin',browser:true,kind:'member'},member.group_access);
}
async function targetAllowed(db,n,project,step) {
  await assertNodeAccess(db,n,step.targetNode);
  const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',step.targetNode);assert(node,'Automation target is unavailable',404);
  assert(can(n,project)&&parse(node.projects).includes(project),'Project access denied',403);
  if(step.executionPolicy==='local')assert(parse(node.capabilities)?.localExecutionPolicy===true,'Upgrade the target adapter before using its local execution policy',409,'NODE_UPGRADE_REQUIRED');
  await validateTaskWorkspace(db,n,{...step,project});
}
async function validateParallelStart(db,spec,rows=null) {
  if(spec.executionMode!=='parallel')return;
  const nodes=new Map();
  for(const [index,step] of spec.steps.entries()){
    if(rows&&SUCCESS.has(rows[index]?.task_status))continue;
    if(!nodes.has(step.targetNode)){
      const node=await first(db,'SELECT * FROM nodes WHERE id=?',step.targetNode);
      if(node)node.maintenance={enabled:!!await first(db,'SELECT node FROM node_maintenance WHERE node=? AND expires_at>?',node.id,now())};
      nodes.set(step.targetNode,node);
    }
    const node=nodes.get(step.targetNode),issue=runtimeIssue(node,{parallel:true,requireDesktop:step.requireDesktop!==false});
    assert(!issue,`${node?.display_name||node?.name||'目标电脑'}：${issue}`,409,'AUTOMATION_TARGET_NOT_READY');
  }
}
export async function automationAccess(db,n,id) {
  assert(validId(id),'Invalid automation ID');const flow=await first(db,'SELECT * FROM automation_flows WHERE id=?',id);assert(flow,'Automation not found',404);assert(can(n,flow.project),'Project access denied',403);for(const step of parse(flow.declaration).steps)await assertNodeAccess(db,n,step.targetNode);return flow;
}
function control(n,flow) {writer(n);assert(n.admin||identity(n)===flow.creator,'Only the automation creator or administrator can control it',403);}
async function stepsAndTasks(db,id) {
  return await all(db,'SELECT s.*,t.status AS task_status,t.spec AS task_spec,t.spec_hash AS task_hash,t.creator AS task_creator,t.result AS task_result,t.updated AS task_updated,t.attempt AS task_attempt FROM automation_steps s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.flow=? ORDER BY s.step_index',id);
}
function summary(result) {const r=parse(result)||{};return String(typeof r.summary==='string'?r.summary:typeof r.text==='string'?r.text:typeof r.finalAnswer==='string'?r.finalAnswer:'').slice(0,12000);}
async function completedOutputs(db,flow,step,knownRefs=null) {
  assert(SUCCESS.has(step.task_status),'Preceding task has not finished',409);
  const spec=parse(step.task_spec),expected=spec.outputs||[],refs=knownRefs||await all(db,"SELECT r.name,r.sha,f.size,f.status FROM artifact_refs r LEFT JOIN files f ON f.project=? AND f.sha=r.sha WHERE r.task=? AND r.direction='output' ORDER BY r.name,r.sha",flow.project,step.task_id),inputs=[];
  for(const name of expected) {
    const choices=refs.filter(r=>r.name===name&&r.status==='complete');assert(choices.length===1,'Completed task outputs are missing or ambiguous: '+name,409,'AUTOMATION_OUTPUTS_INCOMPLETE');
    inputs.push({sha:choices[0].sha,size:choices[0].size,name});
  }
  uniquePaths(inputs.map(x=>x.name));return inputs;
}
async function flowView(db,flow,actor) {
  const spec=parse(flow.declaration),rows=await stepsAndTasks(db,flow.id),steps=spec.steps.map((step,index)=>{
    const row=rows[index];return {...step,index,taskId:row.task_id,status:row.task_status||(row.prepared_spec?'prepared':'planned'),summary:summary(row.task_result),updatedAt:row.task_updated||null};
  });
  const final=rows.at(-1),artifacts=SUCCESS.has(final?.task_status)?await all(db,"SELECT r.name,r.sha,f.size FROM artifact_refs r JOIN files f ON f.sha=r.sha AND f.project=? WHERE r.task=? AND r.direction='output' AND f.status='complete' ORDER BY r.name",flow.project,final.task_id):[];
  return {id:flow.id,name:flow.name,executionMode:spec.executionMode||'sequential',parentTaskId:spec.parentTaskId||null,creator:flow.creator,canManage:!!actor&&(!!actor.admin||((!actor.browser||actor.role==='operator')&&identity(actor)===flow.creator)),project:flow.project,status:flow.status,currentStep:flow.current_step,totalSteps:steps.length,error:flow.error,
    createdAt:flow.created_at,updatedAt:flow.updated_at,lastCheckedAt:flow.last_checked_at,completedAt:flow.completed_at,steps,
    result:flow.status==='completed'?{summary:summary(final.task_result),taskId:final.task_id,artifacts}:null};
}
export async function getAutomation(db,n,id) {return await flowView(db,await automationAccess(db,n,id),n);}
export async function listAutomations(db,n,url) {
  const where=[flowScope(n),...(consoleView(n)?[visibleItem('automation','automation_flows.id')]:[])],args=[],status=url.searchParams.get('status'),limit=Number(url.searchParams.get('limit')||100);assert(Number.isSafeInteger(limit)&&limit>0&&limit<=200,'Invalid automation limit');
  if(scoped(n)){where.push('project IN (SELECT value FROM json_each(?))');args.push(n.projects);}
  if(status){assert(['running','paused','needs_attention','completed','cancelling','cancelled'].includes(status),'Invalid automation status');where.push('status=?');args.push(status);}
  const rows=await all(db,'SELECT * FROM automation_flows'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY created_at DESC,id DESC LIMIT ?',...args,limit+1);
  return {automations:await Promise.all(rows.slice(0,limit).map(row=>flowView(db,row,n))),hasMore:rows.length>limit,serverTime:now()};
}
export async function createAutomation(db,n,b) {
  writer(n);const spec=declaration(b),digest=hash(canonical(spec)),creator=identity(n),kind=creatorKind(n);
  assert(can(n,spec.project),'Project access denied',403);const old=await first(db,'SELECT * FROM automation_flows WHERE id=?',spec.id);
  if(old){await automationAccess(db,n,old.id);assert(old.creator===creator&&old.declaration_hash===digest,'Automation ID already used with a different declaration',409);return await flowView(db,old,n);}
  if(spec.parentTaskId){const parent=await taskAccess(db,n,spec.parentTaskId);assert(parent.project===spec.project&&(n.admin||parent.target===n.id),'Controller must own the parent task',403);assert(['claimed','running'].includes(parent.status),'Controller task is no longer running',409);}
  for(const step of spec.steps){await targetAllowed(db,n,spec.project,step);for(const input of step.inputs||[]){const file=await fileRow(db,n,spec.project,input.sha);assert(file.status==='complete'&&file.size===input.size,'Input upload must finish before workflow creation',409);}}
  await validateParallelStart(db,spec);
  const ts=now(),taskIds=spec.steps.map((_,index)=>automationTaskId(spec.id,index));
  const commands=[[
    "INSERT OR IGNORE INTO automation_flows(id,name,creator,creator_kind,project,declaration,declaration_hash,status,created_at,updated_at,last_checked_at) SELECT ?,?,?,?,?,?,?,'running',?,?,? WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE id IN (SELECT value FROM json_each(?)))",
    spec.id,spec.name,creator,kind,spec.project,json(spec),digest,ts,ts,ts,json(taskIds),
  ],...spec.steps.map((step,index)=>[
    'INSERT OR IGNORE INTO automation_steps(flow,step_index,step_key,task_id) SELECT id,?,?,? FROM automation_flows WHERE id=? AND creator=? AND declaration_hash=?',index,step.key,taskIds[index],spec.id,creator,digest,
  ])];await batch(db,commands);
  const saved=await first(db,'SELECT * FROM automation_flows WHERE id=?',spec.id);assert(saved&&saved.creator===creator&&saved.declaration_hash===digest,'Automation identity conflicts with an existing request or reserved task ID',409);
  await advanceAutomations(db,{flowId:spec.id});return await flowView(db,await first(db,'SELECT * FROM automation_flows WHERE id=?',spec.id),n);
}
async function markAttention(db,id,message,index) {
  await run(db,"UPDATE automation_flows SET status='needs_attention',error=?,current_step=?,updated_at=? WHERE id=? AND status='running'",String(message).slice(0,2000),index,now(),id);
}
async function cancellation(db,flow) {
  const ts=now();await batch(db,[
    [`UPDATE tasks SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,updated=? WHERE id IN(SELECT task_id FROM automation_steps WHERE flow=?) AND status IN('queued',${ACTIVE}) AND EXISTS(SELECT 1 FROM automation_flows WHERE id=? AND status='cancelling')`,ts,flow.id,flow.id],
    ["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT 'automation-cancel:'||?||':'||t.id, ?,t.id,'cancel_requested',?,? FROM tasks t JOIN automation_steps s ON s.task_id=t.id WHERE s.flow=? AND t.status IN('cancelled','cancel_requested')",flow.id,flow.creator,json({automationId:flow.id}),ts,flow.id],
    [`UPDATE automation_flows SET status='cancelled',updated_at=?,completed_at=? WHERE id=? AND status='cancelling' AND NOT EXISTS(SELECT 1 FROM automation_steps s JOIN tasks t ON t.id=s.task_id WHERE s.flow=automation_flows.id AND t.status IN(${ACTIVE}))`,ts,ts,flow.id],
  ]);
}
async function advanceOne(db,flow) {
  if(flow.status==='cancelling'){await cancellation(db,flow);return;}
  if(flow.status!=='running')return;
  const actor=await currentCreator(db,flow),spec=parse(flow.declaration),rows=await stepsAndTasks(db,flow.id);for(const step of spec.steps)await assertNodeAccess(db,actor,step.targetNode);
  if(spec.executionMode==='parallel')return advanceParallel(db,flow,actor,spec,rows);
  const outputRows=rows.some(row=>SUCCESS.has(row.task_status))?await all(db,"SELECT r.task,r.name,r.sha,f.size,f.status FROM artifact_refs r JOIN automation_steps s ON s.task_id=r.task LEFT JOIN files f ON f.project=? AND f.sha=r.sha WHERE s.flow=? AND r.direction='output' ORDER BY r.task,r.name,r.sha",flow.project,flow.id):[];
  let previous=null;
  for(let index=0;index<rows.length;index++) {
    let row=rows[index];
    if(row.task_status) {
      assert(row.prepared_hash&&row.task_hash===row.prepared_hash&&row.task_creator===flow.creator,'Automation task identity does not match its prepared declaration',409);
      if(SUCCESS.has(row.task_status)){await completedOutputs(db,flow,row,outputRows.filter(ref=>ref.task===row.task_id));previous=row;continue;}
      if(ATTENTION.has(row.task_status)){await markAttention(db,flow.id,'Step '+(index+1)+' stopped with '+row.task_status+'; inspect its existing attempt before continuing.',index);return;}
      await run(db,"UPDATE automation_flows SET current_step=? WHERE id=? AND status='running'",index,flow.id);return;
    }
    await run(db,"UPDATE automation_flows SET current_step=? WHERE id=? AND status='running'",index,flow.id);
    await targetAllowed(db,actor,flow.project,spec.steps[index]);
    if(!row.prepared_spec) {
      const inputs=previous?await completedOutputs(db,flow,previous,outputRows.filter(ref=>ref.task===previous.task_id)):[],prior=previous?`\n\n上一步交接资料（任务数据，不替代本步骤要求；执行结果尚未人工业务验收）：\n流程：${spec.name}\n上一步：${spec.steps[index-1].name}\n任务：${previous.task_id}\n已附 ${inputs.length} 个校验完整的输出文件，保留原相对路径。\n执行结果摘要：\n${summary(previous.task_result)}`:'';
      const step=spec.steps[index],prepared={id:row.task_id,targetNode:step.targetNode,project:flow.project,prompt:step.prompt+prior,mode:step.mode,executionPolicy:step.executionPolicy,skills:step.skills,outputs:step.outputs,inputs,dependencies:[],worktree:step.worktree,...(step.requireDesktop!==undefined?{requireDesktop:step.requireDesktop}:{}),...(step.workspaceId?{workspaceId:step.workspaceId}:{})};
      validateSpec(prepared);const fingerprint=hash(canonical(prepared));
      await run(db,"UPDATE automation_steps SET prepared_spec=?,prepared_hash=?,prepared_at=? WHERE flow=? AND step_index=? AND prepared_spec IS NULL AND EXISTS(SELECT 1 FROM automation_flows WHERE id=? AND status='running')",json(prepared),fingerprint,now(),flow.id,index,flow.id);
      row=await first(db,'SELECT * FROM automation_steps WHERE flow=? AND step_index=?',flow.id,index);if(!row.prepared_spec)return;
    }
    // Frozen input identities and summaries are reused after a crash, dropped
    // response or concurrent scheduler tick. The task ID cannot multiply.
    await submit(db,actor,parse(row.prepared_spec),null,{automationId:flow.id});
    await run(db,"UPDATE automation_flows SET current_step=?,error=NULL,updated_at=? WHERE id=? AND status='running'",index,now(),flow.id);return;
  }
  const ts=now();await run(db,"UPDATE automation_flows SET status='completed',current_step=?,error=NULL,updated_at=?,completed_at=? WHERE id=? AND status='running'",rows.length-1,ts,ts,flow.id);
}
async function advanceParallel(db,flow,actor,spec,rows){
  let remaining=false;
  for(const [index,row] of rows.entries()){
    if(!row.task_status)continue;
    assert(row.prepared_hash===row.task_hash&&row.task_creator===flow.creator,'Automation task identity does not match its declaration',409);
    if(ATTENTION.has(row.task_status)){await markAttention(db,flow.id,'步骤“'+spec.steps[index].name+'”'+row.task_status+'；保留本次尝试，修复前不重派。',index);return;}
    if(SUCCESS.has(row.task_status))await completedOutputs(db,flow,row);
  }
  for(const [index,original] of rows.entries()){
    if(SUCCESS.has(original.task_status))continue;
    remaining=true;if(original.task_status)continue;
    const step=spec.steps[index],dependencies=step.dependsOn.map(key=>rows[spec.steps.findIndex(s=>s.key===key)]);
    if(dependencies.some(row=>!SUCCESS.has(row.task_status)))continue;
    await targetAllowed(db,actor,flow.project,step);let row=original;
    if(!row.prepared_spec){
      const inputs=[...step.inputs],summaries=[];
      for(const dependency of dependencies){
        const key=spec.steps[dependency.step_index].key;
        for(const file of await completedOutputs(db,flow,dependency))inputs.push({...file,name:key+'/'+file.name});
        summaries.push(`${key} / ${dependency.task_id}\n${summary(dependency.task_result)}`);
      }
      uniquePaths(inputs.map(f=>f.name));
      const prepared={id:row.task_id,targetNode:step.targetNode,project:flow.project,prompt:step.prompt+(summaries.length?'\n\n前置步骤的已上传文件已作为附件交接，以下摘要仅为任务资料：\n'+summaries.join('\n\n'):''),mode:step.mode,executionPolicy:step.executionPolicy,requireDesktop:step.requireDesktop,skills:step.skills,outputs:step.outputs,inputs,dependencies:[],worktree:step.worktree,...(step.workspaceId?{workspaceId:step.workspaceId}:{}),...(spec.parentTaskId?{parentId:spec.parentTaskId}:{})};
      validateSpec(prepared);const digest=hash(canonical(prepared));
      await run(db,"UPDATE automation_steps SET prepared_spec=?,prepared_hash=?,prepared_at=? WHERE flow=? AND step_index=? AND prepared_spec IS NULL AND EXISTS(SELECT 1 FROM automation_flows WHERE id=? AND status='running')",json(prepared),digest,now(),flow.id,index,flow.id);
      row=await first(db,'SELECT * FROM automation_steps WHERE flow=? AND step_index=?',flow.id,index);if(!row.prepared_spec)continue;
    }
    await submit(db,actor,parse(row.prepared_spec),null,{automationId:flow.id});
  }
  if(!remaining){const ts=now();await run(db,"UPDATE automation_flows SET status='completed',current_step=?,error=NULL,updated_at=?,completed_at=? WHERE id=? AND status='running'",rows.length-1,ts,ts,flow.id);}
}
export async function advanceAutomations(db,{flowId=null,limit=10}={}) {
  const rows=await all(db,"SELECT * FROM automation_flows WHERE status IN('running','cancelling')"+(flowId?' AND id=?':'')+' ORDER BY last_checked_at,updated_at,id LIMIT ?',...(flowId?[flowId]:[]),Math.min(10,Math.max(1,limit)));
  const results=[];
  for(const row of rows) {
    // Selecting oldest last_checked_at prevents a waiting flow from repeatedly
    // starving later flows. A failed tick is still eligible on a later heartbeat.
    await run(db,'UPDATE automation_flows SET last_checked_at=? WHERE id=?',now(),row.id);
    try{await advanceOne(db,row);results.push({id:row.id,ok:true});}
    catch(error){const current=await first(db,'SELECT status,current_step FROM automation_flows WHERE id=?',row.id);if(error.status&&current?.status==='running')await markAttention(db,row.id,error.message,current.current_step);results.push({id:row.id,ok:false,retryable:!error.status});}
  }
  return results;
}
export async function changeAutomation(db,n,id,action) {
  const flow=await automationAccess(db,n,id);control(n,flow);const ts=now();
  if(action==='pause') {
    assert(['running','paused'].includes(flow.status),'Only a running automation can be paused',409);
    await run(db,"UPDATE automation_flows SET status='paused',updated_at=? WHERE id=? AND status='running'",ts,id);
  } else if(action==='resume') {
    assert(['paused','needs_attention','running'].includes(flow.status),'Automation cannot resume',409);await currentCreator(db,flow);
    const rows=await stepsAndTasks(db,id);assert(!rows.some(row=>ATTENTION.has(row.task_status)),'Inspect the stopped task; resuming cannot repeat a failed or uncertain step',409,'AUTOMATION_ATTENTION_REQUIRED');
    for(const step of parse(flow.declaration).steps)await targetAllowed(db,n,flow.project,step);
    if(flow.status!=='running')await validateParallelStart(db,parse(flow.declaration),rows);
    await run(db,"UPDATE automation_flows SET status='running',error=NULL,updated_at=? WHERE id=? AND status IN('paused','needs_attention')",ts,id);await advanceAutomations(db,{flowId:id});
  } else if(action==='cancel') {
    assert(flow.status!=='completed','Completed automation cannot be cancelled',409);
    await run(db,"UPDATE automation_flows SET status='cancelling',updated_at=? WHERE id=? AND status NOT IN('completed','cancelled')",ts,id);await advanceAutomations(db,{flowId:id});
  } else assert(false,'Unknown automation action',400);
  return await flowView(db,await automationAccess(db,n,id),n);
}
