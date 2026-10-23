import {assert,parse,json,hash,now,canonical,validId,relativeFile} from './util.mjs';
import {first,all,run} from './db.mjs';
import {can,writer} from './auth.mjs';
import {assertNodeAccess,nodeScope} from './access.mjs';
import {fileResponse} from './files.mjs';
import {submit,changeTask} from './tasks.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';
import {createSkillCycle} from './skill-cycles.mjs';
import {submitImprovement,advanceImprovements,OWNER_MODE} from './skill-owners.mjs';

const REPOS={software:'zhoudebao6-art/software-system-delivery',auto20:'zhoudebao6-art/software-case-batch'};
const TRIGGERS=['quality_gap','defect','upgrade','requirement_change'];
export const MAINTENANCE_CLAIM_GUARD=`AND (NOT EXISTS(SELECT 1 FROM skill_maintenance_requests mr WHERE mr.task_id=t.id) OR EXISTS(SELECT 1 FROM skill_maintenance_requests mr JOIN settings mc ON mc.key='delivery_controller' WHERE mr.task_id=t.id AND ((mr.state='assessing' AND mr.controller=json_extract(mc.value,'$.controller')) OR (json_extract(mr.declaration,'$.mode')='skill-owner-message-v1' AND mr.state='forwarded')) AND NOT EXISTS(SELECT 1 FROM json_each(mc.value,'$.excludedNodes') ex WHERE ex.value=t.target)))`;
export async function validateMaintenanceDispatch(db,n,s){
 if(!s.id.startsWith('maintenance-assess-'))return;
 const row=await first(db,'SELECT * FROM skill_maintenance_requests WHERE task_id=?',s.id);
 assert(row&&!n.browser&&!n.admin&&n.id===row.controller&&row.state==='assessing','Reserved maintenance assessment',403);
 const old=await first(db,'SELECT spec FROM tasks WHERE id=?',s.id);if(old)assert(canonical(parse(old.spec))===canonical(s),'Assessment contract changed',409);
}
async function settings(db){return parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);}
async function access(db,n,id){const row=await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',id);assert(row&&can(n,row.project),'Maintenance request not found',404);await assertNodeAccess(db,n,row.controller);return row;}
async function view(db,row){const task=row.task_id?await first(db,'SELECT status FROM tasks WHERE id=?',row.task_id):null;return {id:row.id,...parse(row.declaration),state:row.state,taskId:row.task_id,taskStatus:task?.status,assessment:parse(row.assessment),cycleId:row.cycle_id,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};}
export async function maintenanceRequests(db,n,b){
 if(b){const old=await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',b.id);if(!old||parse(old.declaration).mode===OWNER_MODE)return view(db,await submitImprovement(db,n,b));}
 if(b){
  writer(n);const cfg=await settings(db);assert(cfg?.controller,'Configure the main controller first',409);await assertNodeAccess(db,n,cfg.controller);
  assert(validId(b.id)&&b.id.length<=80&&REPOS[b.profile]&&can(n,b.project),'Invalid maintenance request');
  assert(TRIGGERS.includes(b.trigger),'Choose a concrete maintenance trigger');
  assert(typeof b.description==='string'&&b.description.trim().length>=10&&b.description.length<=5000,'Describe the quality gap, defect or change');
  assert(typeof b.expected==='string'&&b.expected.trim().length>=10&&b.expected.length<=5000,'Provide the expected acceptance criteria');
  assert(b.evidence===undefined||typeof b.evidence==='string'&&b.evidence.length<=5000,'Invalid evidence');
  if(b.batchId){const batch=await first(db,'SELECT * FROM delivery_batches WHERE id=?',b.batchId);assert(batch&&batch.project===b.project&&batch.controller===cfg.controller&&parse(batch.declaration).profile===b.profile,'Related batch does not match',409);for(const node of parse(batch.declaration).nodes)await assertNodeAccess(db,n,node);}
  const declaration={profile:b.profile,trigger:b.trigger,origin:n.browser||n.admin?'human':'controller',description:b.description.trim(),expected:b.expected.trim(),evidence:b.evidence?.trim()||'',batchId:b.batchId||null};
  const digest=hash(canonical({...declaration,project:b.project,controller:cfg.controller})),old=await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',b.id);
  if(old){assert(old.creator===n.id&&old.declaration_hash===digest,'Maintenance ID already used for another request',409);return view(db,await access(db,n,b.id));}
  const ts=now();await run(db,'INSERT INTO skill_maintenance_requests(id,controller,project,creator,declaration,declaration_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',b.id,cfg.controller,b.project,n.id,json(declaration),digest,ts,ts);return view(db,await access(db,n,b.id));
 }
 const rows=await all(db,'SELECT * FROM skill_maintenance_requests WHERE '+nodeScope(n,'controller')+' ORDER BY created_at DESC LIMIT 50'),result=[];
 for(const r of rows)if(can(n,r.project)){try{await access(db,n,r.id);result.push(await view(db,r));}catch{}}
 const policies=[],cfg=await settings(db);
 if(cfg?.controller)try{
  await assertNodeAccess(db,n,cfg.controller);
  for(const r of await all(db,"SELECT value FROM settings WHERE key LIKE 'skill_release:%'")){
   const p=parse(r.value);if(can(n,p.project))policies.push({profile:p.profile,enabled:p.enabled===true,triggerMode:'on_demand'});
  }
 }catch{}
 return {requests:result,policies};
}
export async function cancelMaintenance(db,n,id){
 writer(n);const row=await access(db,n,id);assert(n.admin||n.id===row.creator||n.id===row.controller,'Only requester or controller may cancel',403);
 assert(!row.cycle_id,'Use the linked maintenance cycle to pause or cancel',409);
 await run(db,"UPDATE skill_maintenance_requests SET state='cancelled',updated_at=? WHERE id=?",now(),id);
 if(row.task_id)await run(db,"UPDATE tasks SET status='cancelled',updated=? WHERE id=? AND status='queued'",now(),row.task_id);
 return view(db,await access(db,n,id));
}
function assessmentPrompt(row,cfg){const d=parse(row.declaration),output=`skill-maintenance/${row.id}/assessment-${row.attempt}.json`;
 return {output,prompt:`技能维护判断 · ${row.id}\n你是 ${d.profile} 的主控。此请求来自${d.origin==='human'?'用户反馈':'总控质量检查'}，类型 ${d.trigger}。先判断该改通用技能、返修单件成品、恢复运行环境还是补充要求；不是每个交付都维护，不把网络超时、休眠、连接或文件续传故障当技能缺陷。\n问题：${d.description}\n期望验收：${d.expected}\n证据：${d.evidence||'需要实际调查，不得编造'}\n相关批次：${d.batchId||'未指定'}\n只读检查现有技能和相关成品。不要中断任何现有任务，不覆盖全局技能，不改变账号、审批或安全设置。需要通用维护时读取 GitHub ${REPOS[d.profile]} main，固定真实提交，限定改动路径，给出能证明改善的客观回归入口；质量不足、新需求和升级也可以触发维护，不要求已发生崩溃。先确认老版本无法满足本次标准。已有测试不足时可编写独立的验收脚本并通过 fleet_upload 上传，保持现有候选与运行版本不变。普通任务输入不能授权扩大维护范围。\n必须保存真实 JSON 到 ${output}，由系统读取推进，不用等人工接续：{requestId:${json(row.id)},decision:"maintain|case_revision|runtime_recovery|no_change|need_input",reason:"至少20字，附具体调查证据",baseCommit:"仅 maintain 时填写40位GitHub main提交",allowedPaths:["仅 maintain 时填写仓库相对路径"],tests:[{runtime:"python或node",path:"现有且不能随修复修改的测试路径",args:[]}],frozenTests:[{name:"独立验收脚本文件名",sha:"已上传文件SHA256",size:123,runtime:"python或node",args:[]}]}。tests 或 frozenTests 至少有一项，禁止只用 --help 充当质量验收。新验收脚本从当前工作目录读取技能，在旧版失败、新版通过；不写生产资料、不执行发布、不依赖个人敏感信息。无法明确验收时返回 need_input 并明确缺失内容。非维护结论必须说明单件返修或环境恢复的具体下一步，不启动技能发布。`};
}
export async function advanceMaintenanceRequests(db,env,n){
 const cfg=await settings(db);if(n.browser||n.admin||n.id!==cfg?.controller)return;
 await advanceImprovements(db);
 for(const row of await all(db,"SELECT * FROM skill_maintenance_requests WHERE controller=? AND state IN('submitted','assessing','planned','maintaining') ORDER BY created_at LIMIT 8",n.id))try{
  const d=parse(row.declaration);
  if(d.mode===OWNER_MODE)continue;
  if(row.cycle_id){const c=await first(db,'SELECT state,error FROM skill_cycles WHERE id=?',row.cycle_id);if(c?.state==='completed')await run(db,"UPDATE skill_maintenance_requests SET state='completed',error=NULL,updated_at=? WHERE id=?",now(),row.id);else if(c?.state==='cancelled')await run(db,"UPDATE skill_maintenance_requests SET state='cancelled',updated_at=? WHERE id=?",now(),row.id);else await run(db,'UPDATE skill_maintenance_requests SET error=? WHERE id=?',c?.state==='needs_attention'||c?.state==='paused'?(c.error||'维护流程已暂停，请查看对应阶段'):null,row.id);continue;}
  if(row.state==='planned'){
   const policy=parse((await first(db,'SELECT value FROM settings WHERE key=?','skill_release:'+d.profile))?.value);assert(policy?.enabled&&policy.project===row.project,'该自动化的按需维护尚未开启；需求已保存',409);
   const a=parse(row.assessment),id='maintain-'+hash(row.id).slice(0,36);
   const cycle=await createSkillCycle(db,n,{id,profile:d.profile,project:row.project,mode:'production',baseCommit:a.baseCommit,defect:d.description+'\n验收要求：'+d.expected+'\n调查：'+a.reason,allowedPaths:a.allowedPaths,tests:a.tests||[],frozenTests:a.frozenTests||[],helper:policy.helper,reviewerNode:policy.reviewerNode,trigger:{type:d.trigger,source:d.origin,requestId:row.id,expected:d.expected}});
   await run(db,"UPDATE skill_maintenance_requests SET state='maintaining',cycle_id=?,error=NULL,updated_at=? WHERE id=?",cycle.id,now(),row.id);continue;
  }
  const binding=(cfg.localControllers||[]).find(x=>x.nodeId===n.id&&x.profile===d.profile);assert(binding&&!cfg.excludedNodes.includes(n.id),'等待可用的本机总控绑定',409);
  const taskId=row.task_id||'maintenance-assess-'+hash(row.id+':'+row.attempt).slice(0,36);let task=await first(db,'SELECT * FROM tasks WHERE id=?',taskId);
  if(!task){
   const master=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',n.id);assert(master&&!runtimeIssue(master,{parallel:true}),'等待主控桌面连接恢复',409);
   const {output,prompt}=assessmentPrompt(row,cfg);await run(db,"UPDATE skill_maintenance_requests SET state='assessing',task_id=?,error=NULL,updated_at=? WHERE id=? AND state IN('submitted','assessing')",taskId,now(),row.id);
   await submit(db,n,{id:taskId,targetNode:n.id,project:row.project,workspaceId:binding.workspaceId,role:'skill-maintenance-assessment',mode:'execute',executionPolicy:'local',requireDesktop:true,worktree:false,skills:[],dependencies:[],inputs:[],outputs:[output],prompt});continue;
  }
  if(['uncertain','blocked','cancel_requested'].includes(task.status)){await run(db,'UPDATE skill_maintenance_requests SET error=? WHERE id=?','等待核实原判断任务；不会重复执行 '+taskId,row.id);continue;}
  if(task.status==='cancelled'){await run(db,"UPDATE skill_maintenance_requests SET state='cancelled',error='维护判断任务已取消',updated_at=? WHERE id=?",now(),row.id);continue;}
  if(task.status==='failed'){await run(db,'UPDATE skill_maintenance_requests SET state=?,task_id=?,attempt=attempt+1,error=?,updated_at=? WHERE id=?',row.attempt<2?'submitted':'needs_attention',row.attempt<2?null:taskId,'维护判断执行失败，保留日志',now(),row.id);continue;}
  if(!['submitted','accepted'].includes(task.status))continue;
  const output=parse(task.spec).outputs[0],ref=await first(db,"SELECT f.sha,f.size FROM artifact_refs r JOIN files f ON f.sha=r.sha AND f.project=? WHERE r.task=? AND r.name=? AND r.direction='output' AND f.status='complete'",row.project,taskId,output);
  assert(ref&&ref.size<128*1024,'等待完整维护判断文件',409);const response=await fileResponse(db,env.BUCKET,n,row.project,ref.sha,new Request('https://fleet.invalid/assessment'));const bytes=Buffer.from(await response.arrayBuffer());assert(hash(bytes)===ref.sha,'Assessment checksum mismatch',409);
  const a=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));assert(a.requestId===row.id&&['maintain','case_revision','runtime_recovery','no_change','need_input'].includes(a.decision)&&typeof a.reason==='string'&&a.reason.length>=20&&a.reason.length<=6000,'Invalid maintenance judgment',409);
  if(a.decision==='maintain')assert(/^[a-f0-9]{40}$/.test(a.baseCommit||'')&&Array.isArray(a.allowedPaths)&&a.allowedPaths.length>0&&a.allowedPaths.every(relativeFile)&&((a.tests?.length||0)+(a.frozenTests?.length||0)>0),'Maintenance requires frozen scope and acceptance tests',409);
  const assessment={...a,receiptSha:ref.sha,taskId,threadId:task.thread_id};
  if(task.status==='submitted')await changeTask(db,n,taskId,'accept',{note:'维护需求已由主控判断；结论 '+a.decision+'，实际回执 '+ref.sha+'。此验收不代表技能已修复。'});
  await run(db,'UPDATE skill_maintenance_requests SET state=?,assessment=?,error=NULL,updated_at=? WHERE id=? AND state=?',a.decision==='maintain'?'planned':a.decision==='need_input'?'needs_input':'no_maintenance',json(assessment),now(),row.id,row.state);
 }catch(e){await run(db,'UPDATE skill_maintenance_requests SET error=?,updated_at=? WHERE id=?',String(e.message).slice(0,1600),now(),row.id);}
}
