import {maintenanceCommit} from './delivery-preflight.mjs';
import {assert,parse,json,hash,now,canonical,validId,relativeFile} from './util.mjs';
import {first,all,run} from './db.mjs';
import {can,writer} from './auth.mjs';
import {assertNodeAccess,nodeScope} from './access.mjs';
import {fileRow,fileResponse} from './files.mjs';
import {submit,changeTask} from './tasks.mjs';
import {validateLocalControllers} from './delivery-routing.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';
import {createDelivery} from './deliveries.mjs';

const REPOS={software:'zhoudebao6-art/software-system-delivery',auto20:'zhoudebao6-art/software-case-batch'};
const ACTIVE=['repair','review','publish','canary','sync'];
const FINISHED=['submitted','accepted'];
const STEP_IDS="(SELECT id AS task_id,id AS original_id,spec FROM skill_cycle_steps UNION ALL SELECT retry_id AS task_id,original_id,spec FROM skill_phase_retries)";
export const SKILL_CLAIM_GUARD=`AND (NOT EXISTS(SELECT 1 FROM ${STEP_IDS} si WHERE si.task_id=t.id) OR EXISTS(SELECT 1 FROM ${STEP_IDS} si JOIN skill_cycle_steps s ON s.id=si.original_id JOIN skill_cycles c ON c.id=s.cycle_id WHERE si.task_id=t.id AND s.phase=c.state AND s.attempt=c.attempt AND c.state IN('repair','review','publish','canary','sync') AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=c.controller AND n.revoked=0) AND EXISTS(SELECT 1 FROM settings cfg WHERE cfg.key='delivery_controller' AND json_extract(cfg.value,'$.controller')=c.controller AND NOT EXISTS(SELECT 1 FROM json_each(cfg.value,'$.excludedNodes') excluded WHERE excluded.value=t.target))))`;
export async function validateSkillCycleDispatch(db,n,s){const r=await first(db,'SELECT si.spec,c.controller,c.state FROM '+STEP_IDS+' si JOIN skill_cycle_steps s ON s.id=si.original_id JOIN skill_cycles c ON c.id=s.cycle_id WHERE si.task_id=?',s.id);if(!r)return;assert(!n.browser&&!n.admin&&n.id===r.controller&&ACTIVE.includes(r.state)&&canonical(parse(r.spec))===canonical(s),'Skill phase contract changed or paused',409);}
async function effectiveStep(db,s){if(!s)return s;const r=await first(db,'SELECT r.retry_id,r.retry_no,r.spec,t.status,t.thread_id,t.result FROM skill_phase_retries r LEFT JOIN tasks t ON t.id=r.retry_id WHERE r.original_id=? ORDER BY retry_no DESC LIMIT 1',s.id);return r?{...s,...r,originalId:s.id,id:r.retry_id}:s;}
async function access(db,n,id){const r=await first(db,'SELECT * FROM skill_cycles WHERE id=?',id);assert(r&&can(n,r.project),'Skill cycle not found',404);await assertNodeAccess(db,n,r.controller);for(const b of parse(r.declaration).bindings)await assertNodeAccess(db,n,b.nodeId);return r;}
async function view(db,r){return {id:r.id,...parse(r.declaration),state:r.state,attempt:r.attempt,error:r.error,result:parse(r.result),createdAt:r.created_at,updatedAt:r.updated_at,steps:await Promise.all((await all(db,'SELECT s.id,s.phase,s.node,s.attempt,s.proof,t.status FROM skill_cycle_steps s LEFT JOIN tasks t ON t.id=s.id WHERE s.cycle_id=? ORDER BY s.created_at,s.id',r.id)).map(async s=>{const current=await effectiveStep(db,s);return {...s,id:current.id,status:current.status,retries:current.retry_no||0,proof:parse(s.proof)};}))};}
export async function listSkillCycles(db,n){const rows=await all(db,'SELECT * FROM skill_cycles c WHERE '+nodeScope(n,'c.controller')+' ORDER BY created_at DESC LIMIT 30');const result=[];for(const r of rows)try{await access(db,n,r.id);result.push(await view(db,r));}catch{}return {cycles:result};}
export async function getSkillCycle(db,n,id){return view(db,await access(db,n,id));}
export async function createSkillCycle(db,n,b){
 writer(n);const cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 assert(cfg&&!n.browser&&!n.admin&&n.id===cfg.controller,'Only the enrolled main controller may start skill repair',403);
 assert(validId(b.id)&&b.id.length<=80&&REPOS[b.profile]&&can(n,b.project),'Invalid skill cycle');
 assert(['validation','production'].includes(b.mode)&&/^[a-f0-9]{40}$/.test(b.baseCommit||''),'Freeze an exact base commit');
 assert(typeof b.defect==='string'&&b.defect.length>=12&&b.defect.length<=18000,'Describe the reproducible defect or acceptance gap');
 assert(Array.isArray(b.allowedPaths)&&b.allowedPaths.length>0&&b.allowedPaths.length<=40&&b.allowedPaths.every(p=>relativeFile(p)&&!p.startsWith('.')&&!p.includes('*')),'Freeze narrow repair paths');
 if(b.mode==='validation')assert(b.allowedPaths.length===1&&b.allowedPaths[0]==='fleet_validation/'+b.id,'Validation writes only its isolated fixture');
 assert(Array.isArray(b.tests)&&b.tests.length<=12&&(b.mode==='validation'||b.tests.length>0||b.frozenTests?.length>0),'Freeze regression tests');
 for(const t of b.tests)assert(['python','node'].includes(t.runtime)&&relativeFile(t.path)&&Array.isArray(t.args||[])&&(t.args||[]).every(a=>typeof a==='string'&&a.length<500),'Invalid regression command');
 const frozenTests=b.frozenTests||[];assert(Array.isArray(frozenTests)&&frozenTests.length<=8,'Invalid frozen acceptance tests');
 assert(new Set(frozenTests.map(t=>t.name?.toLowerCase())).size===frozenTests.length&&!frozenTests.some(t=>t.name?.toLowerCase()==='skill-release.py'),'Acceptance script names must be unique and distinct from the release helper');
 for(const t of frozenTests){assert(['python','node'].includes(t.runtime)&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(t.name||'')&&Array.isArray(t.args||[])&&(t.args||[]).every(a=>typeof a==='string'&&a.length<500),'Invalid acceptance script');const f=await fileRow(db,n,b.project,t.sha);assert(f.status==='complete'&&f.size===t.size&&f.size<=128*1024,'Verified acceptance script required');}
 if(b.mode==='production')assert(['quality_gap','defect','upgrade','requirement_change'].includes(b.trigger?.type)&&['human','controller'].includes(b.trigger?.source)&&typeof b.trigger?.expected==='string'&&b.trigger.expected.length>=10,'Production maintenance requires a specific trigger and acceptance criteria');
 const bindings=(cfg.localControllers||[]).filter(r=>r.profile===b.profile&&[n.id,b.reviewerNode].includes(r.nodeId));
 assert(b.reviewerNode!==n.id&&bindings.length===2&&!cfg.excludedNodes.includes(b.reviewerNode),'An independent enrolled reviewer is required');
 assert(!await first(db,"SELECT id FROM skill_cycles WHERE controller=? AND json_extract(declaration,'$.profile')=? AND state IN('repair','review','publish','canary','sync','paused') AND id!=?",n.id,b.profile,b.id),'Another repair owns this skill; retain this issue until it completes',409);
 await validateLocalControllers(db,n,bindings);for(const r of bindings)await assertNodeAccess(db,n,r.nodeId);
 const helper=await fileRow(db,n,b.project,b.helper?.sha);assert(helper.status==='complete'&&helper.size===b.helper.size&&b.helper.name==='Skill-Release.py','Verified release helper required');
 const declaration={profile:b.profile,project:b.project,repository:REPOS[b.profile],baseCommit:b.baseCommit,mode:b.mode,defect:b.defect,allowedPaths:b.allowedPaths,tests:b.tests,helper:b.helper,reviewerNode:b.reviewerNode,bindings,maxRepairs:2,...(frozenTests.length?{frozenTests}:{}),...(b.trigger?{trigger:b.trigger}:{})};
 if(b.mode==='production'){const p=parse((await first(db,'SELECT value FROM settings WHERE key=?','skill_release:'+b.profile))?.value);assert(p?.enabled&&p.project===b.project&&p.helper?.sha===b.helper.sha&&p.reviewerNode===b.reviewerNode,'Production maintenance must use the validated release policy',409);}
 const digest=hash(canonical(declaration)),ts=now();await run(db,'INSERT OR IGNORE INTO skill_cycles(id,controller,project,declaration,declaration_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',b.id,n.id,b.project,json(declaration),digest,ts,ts);
 const r=await access(db,n,b.id);assert(r.declaration_hash===digest,'Cycle ID already has another declaration',409);return view(db,r);
}
export async function controlSkillCycle(db,n,id,action){
 writer(n);const row=await access(db,n,id);assert(n.admin||n.id===row.controller,'Only the controller may stop skill repair',403);
 assert(['pause','resume','cancel'].includes(action),'Invalid skill action');
 if(action==='pause'&&ACTIVE.includes(row.state))await run(db,"UPDATE skill_cycles SET result=?,state='paused',updated_at=? WHERE id=?",json({resumeState:row.state}),now(),id);
 if(action==='resume'&&row.state==='paused')await run(db,'UPDATE skill_cycles SET state=?,result=NULL,updated_at=? WHERE id=?',parse(row.result).resumeState,now(),id);
 if(action==='cancel'){
  // Cancellation stops future phases; preserve a running repair/review to avoid
  // interrupting tools. Its result is retained but never published afterwards.
  await run(db,"UPDATE skill_cycles SET state='cancelled',updated_at=? WHERE id=?",now(),id);
  await run(db,"UPDATE tasks SET status='cancelled',updated=? WHERE id IN(SELECT si.task_id FROM "+STEP_IDS+" si JOIN skill_cycle_steps s ON s.id=si.original_id WHERE s.cycle_id=?) AND status='queued'",now(),id);
 }
 return view(db,await access(db,n,id));
}
async function files(db,row,taskId){return all(db,"SELECT r.name,r.sha,f.size FROM artifact_refs r JOIN files f ON f.sha=r.sha AND f.project=? WHERE r.task=? AND r.direction='output' AND f.status='complete' ORDER BY r.name",row.project,taskId);}
async function readProof(db,env,n,row,step){
 const refs=await files(db,row,step.id),proof=refs.find(f=>f.name===parse(step.spec).outputs[0]);assert(proof&&proof.size<=512*1024,'Waiting for the complete phase receipt',409);
 const response=await fileResponse(db,env.BUCKET,n,row.project,proof.sha,new Request('https://fleet.invalid/receipt'));const bytes=Buffer.from(await response.arrayBuffer());assert(hash(bytes)===proof.sha,'Receipt hash mismatch',409);
 let data;try{data=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{assert(false,'Invalid skill receipt',409);}
 assert(data.cycleId===row.id&&typeof data.passed==='boolean','Phase did not provide a concrete receipt',409);
 return {data,receiptSha:proof.sha,refs,threadId:step.thread_id,taskId:step.id,node:step.node};
}
function planFor(row){const s=parse(row.declaration);return {id:row.id,repository:s.repository,baseCommit:s.baseCommit,mode:s.mode,allowedPaths:s.allowedPaths,tests:s.tests,...(s.frozenTests?.length?{frozenTests:s.frozenTests}:{})};}
function phasePrompt(row,phase,output,upstream){
 const s=parse(row.declaration),plan=planFor(row),root=`skill-cycles/${row.id}/attempt-${row.attempt}/${phase}`;
 const pre=`技能无人值守维护 · ${row.id} · ${phase}\n用户授权本主控与 PC-03 自动修复、独立审核、发布和同步同类技能。这是独立维护子任务，保留已有业务会话、账号和技能。仅在当前项目下 ${root} 操作；临时文件用 D:\\codex+。不要等待原总控人工接续。此轮 ${s.mode==='validation'?'隔离验证，禁止写 main 或覆盖已安装技能':'正式修复，审核通过后只允许无强推快进 main；不覆盖任何在用版本'}。不要运行完整业务案件。\n附件中 Skill-Release.py 是本批冻结的执行器，先核对 SHA256 ${s.helper.sha}，不得修改它。把如下 JSON 原样保存到 ${root}/plan.json：\n${json(plan)}\n使用本机现有 Python 运行附件脚本。每步均传 --plan ${root}/plan.json --root ${root}/work --output ${output}。不要在输出目录内生成会污染候选的缓存。不得编辑回执来伪造通过，任何测试失败均保留真实日志。故障：${s.defect}\n`;
 const frozen=s.frozenTests?.length?`\n先把冻结验收脚本附件原样复制到 ${root}/work/frozen-tests/<name>，逐个校验 SHA256：${json(s.frozenTests)}。不得编辑这些脚本以通过验收。\n`:'';
 const refs=upstream.flatMap(p=>p.refs||[]).map(f=>({name:f.name,sha:f.sha,size:f.size}));
 if(phase==='repair')return pre+frozen+`先运行 prepare，确认 work/prepared.json 有真实失败复现。读取 candidate 中相关代码和技能，再修复允许范围 ${s.allowedPaths.join('、')}。验证模式只修复新增 fixture 的 normalize_name，不改业务技能。随后运行 pack（同一 root），会执行冻结回归并产生 result.json 与同目录 candidate.zip。将这两个文件保存在 outputs 的精确路径。${row.attempt?'上轮审核意见：'+String(row.error||'读取前次审核回执'):''}`;
 const sources=`上游文件由系统作为附件交接，使用适配器给出的真实本机路径：${json(refs)}\n`;
 if(phase==='review')return pre+frozen+sources+`你是独立审核者，不修改候选。运行 review-check --archive <candidate.zip> --repair <repair/result.json>，实际读取候选变更并检查冻结范围、原技能不受影响、回归覆盖和失败复现。随后将审核报告保存至 ${output}：保留 helper 结果的 cycleId、passed、candidateSha、treeSha、tests；增加 decision:"pass" 或 "fail"、至少20字 findings。只有真实检查与回归通过才 pass；失败时 passed:false、decision:fail，保留证据。不要发布。`;
 if(phase==='publish')return pre+frozen+sources+`只运行 publish --archive <candidate.zip> --repair <repair/result.json> --review <review/result.json>。由冻结脚本执行 GitHub 内容寻址提交、审核过的树比对、稳定分支及正式模式下的非强制快进。未知网络结果先读取同一分支，不重复生成另一发布。保留真实发布回执 ${output}。禁止修改候选或审核结论。`;
 return pre+frozen+sources+`只运行 sync --publication <publish/result.json>。它从 GitHub 精确提交下载，在版本目录独立校验所有文件及回归，成功才更新本轮 active.json。原全局技能及业务目录不动。返回 ${output}，报告实际目录和文件数；不可仅复制上游回执。`;
}
async function stepFor(db,n,row,phase,upstream){
 const s=parse(row.declaration),node=['review','canary'].includes(phase)?s.reviewerNode:row.controller,id='skill-'+hash(row.id+':'+phase+':'+row.attempt).slice(0,40);
 let old=await first(db,'SELECT s.*,t.status,t.thread_id,t.result FROM skill_cycle_steps s LEFT JOIN tasks t ON t.id=s.id WHERE s.id=?',id);if(old)return effectiveStep(db,old);
 const target=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',node);if(!target||runtimeIssue(target,{parallel:true})){await run(db,'UPDATE skill_cycles SET error=? WHERE id=?','等待 '+(target?.name||node)+' 可用的桌面连接；记录已保存，恢复后自动接续',row.id);return null;}
 const binding=s.bindings.find(b=>b.nodeId===node),output=`skill-cycles/${row.id}/attempt-${row.attempt}/${phase}/result.json`,inputs=[s.helper,...(s.frozenTests||[]).map(({name,sha,size})=>({name,sha,size})),...upstream.flatMap(p=>p.refs||[])];
 const spec={id,targetNode:node,project:row.project,workspaceId:binding.workspaceId,role:'skill-'+phase,mode:'execute',executionPolicy:'local',requireDesktop:true,worktree:false,skills:[],dependencies:[],inputs:inputs.filter((x,i,a)=>a.findIndex(y=>y.sha===x.sha)===i),outputs:[output,...(phase==='repair'?[output.replace('result.json','candidate.zip')]:[])],prompt:phasePrompt(row,phase,output,upstream)};
 await run(db,'INSERT OR IGNORE INTO skill_cycle_steps(id,cycle_id,phase,node,attempt,spec,created_at) VALUES(?,?,?,?,?,?,?)',id,row.id,phase,node,row.attempt,json(spec),now());
 await submit(db,n,spec);await run(db,'UPDATE skill_cycles SET error=NULL WHERE id=?',row.id);return first(db,'SELECT s.*,t.status,t.thread_id,t.result FROM skill_cycle_steps s LEFT JOIN tasks t ON t.id=s.id WHERE s.id=?',id);
}
async function githubProof(env,repository,publication){
 const request=env.SKILL_GITHUB_FETCH||fetch;
 for(const suffix of ['git/ref/heads/'+(publication.mode==='production'?'main':publication.branch),'git/commits/'+publication.commit]){
  const res=await request('https://api.github.com/repos/'+repository+'/'+suffix,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Codex-Fleet','Accept':'application/vnd.github+json'}});assert(res.ok,'GitHub publication verification unavailable',503);const data=await res.json();
  if(suffix.startsWith('git/ref'))assert(data.object?.sha===publication.commit,'Published ref differs from reviewed commit',409);
  else assert(data.tree?.sha===publication.treeSha,'Published Git tree differs from reviewed candidate',409);
 }
}
export async function advanceSkillCycles(db,env,n){
 const cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);if(n.browser||n.admin||n.id!==cfg?.controller)return;
 await resumeRepairedDeliveries(db,n);
 // A rehearsal never changes production policy. Only an explicit controller
 // policy update enables maintenance; ordinary ticks only advance real issues.
 for(let row of await all(db,"SELECT * FROM skill_cycles WHERE controller=? AND state IN('repair','review','publish','canary','sync') ORDER BY updated_at LIMIT 5",n.id))try{
  const s=parse(row.declaration);assert(!cfg.excludedNodes.includes(s.reviewerNode),'Reviewer is currently excluded',409);
  for(const b of s.bindings)await assertNodeAccess(db,n,b.nodeId);
  const completed=await all(db,'SELECT proof FROM skill_cycle_steps WHERE cycle_id=? AND attempt=? AND proof IS NOT NULL ORDER BY created_at,id',row.id,row.attempt),upstream=completed.map(p=>parse(p.proof));
  const step=await stepFor(db,n,row,row.state,upstream);if(!step)continue;
  if(!step.status){await submit(db,n,parse(step.spec));continue;}
  if(['uncertain','blocked','cancel_requested','cancelled'].includes(step.status)){
   await run(db,'UPDATE skill_cycles SET error=?,updated_at=? WHERE id=?','原执行需核实，保持原任务编号；未重新执行 '+step.id,now(),row.id);continue;
  }
  if(step.status==='failed'){
   if(['publish','canary','sync'].includes(row.state)&&(step.retry_no||0)<2){
    const original=step.originalId||step.id,retryNo=(step.retry_no||0)+1,id='skill-resume-'+hash(original+':'+retryNo).slice(0,36);
    const spec={...parse(step.spec),id,prompt:parse(step.spec).prompt+'\n前一次执行已明确失败。按相同 root 读取 published.json、commit.json、版本目录及已有回执，先核实后接续；不可新建发布分支、修改候选或覆盖在用技能。前次错误：'+String(parse(step.result)?.error||'').slice(0,700)};
    await run(db,'INSERT OR IGNORE INTO skill_phase_retries(original_id,retry_id,retry_no,spec,created_at) VALUES(?,?,?,?,?)',original,id,retryNo,json(spec),now());await submit(db,n,spec);continue;
   }
   if(['repair','review'].includes(row.state)&&row.attempt<2)await run(db,"UPDATE skill_cycles SET state='repair',attempt=attempt+1,error=?,updated_at=? WHERE id=? AND state=? AND attempt=?",'上次维护明确失败，独立候选返修',now(),row.id,row.state,row.attempt);
   else await run(db,"UPDATE skill_cycles SET state='needs_attention',error=?,updated_at=? WHERE id=?",'维护已明确失败：'+step.id,now(),row.id);
   continue;
  }
  if(!FINISHED.includes(step.status))continue;
  const proof=await readProof(db,env,n,row,step),p=proof.data,repair=upstream.find(x=>x.data.phase==='pack'),review=upstream.find(x=>x.data.phase==='review-check'),publication=upstream.find(x=>x.data.phase==='publish');
  if(p.passed===false&&['repair','review'].includes(row.state)){
   await run(db,'UPDATE skill_cycle_steps SET proof=? WHERE id=? AND proof IS NULL',json(proof),step.originalId||step.id);
   await run(db,'UPDATE skill_cycles SET state=?,attempt=?,error=?,updated_at=? WHERE id=? AND state=? AND attempt=?',row.attempt<2?'repair':'needs_attention',row.attempt<2?row.attempt+1:row.attempt,String(p.findings||'Frozen regression failed').slice(0,1200),now(),row.id,row.state,row.attempt);continue;
  }
  if(p.passed===false){await run(db,"UPDATE skill_cycles SET state='needs_attention',error=?,updated_at=? WHERE id=?",'维护阶段未通过，未启用新版本：'+String(p.error||p.findings||p.reason||row.state).slice(0,1000),now(),row.id);continue;}
  assert(p.passed===true,'Phase verification failed; publication or activation stopped',409);
  if(row.state==='repair'){
   assert(p.phase==='pack'&&p.reproduction?.passed===false&&p.tests?.passed===true&&/^[a-f0-9]{40}$/.test(p.treeSha),'Repair lacks reproduction or regression evidence',409);
   assert(Array.isArray(p.changed)&&p.changed.length>0&&p.changed.every(k=>s.allowedPaths.some(a=>k===a||k.startsWith(a+'/'))),'Repair escaped frozen paths',409);
   assert(proof.refs.some(f=>f.name.endsWith('/candidate.zip')&&f.sha===p.candidateSha),'Candidate ZIP not complete',409);
  }else if(row.state==='review'){
   assert(repair&&step.node!==repair.node&&step.thread_id&&step.thread_id!==repair.threadId,'Reviewer is not independent',409);
   assert(p.phase==='review-check'&&p.decision==='pass'&&p.candidateSha===repair.data.candidateSha&&p.treeSha===repair.data.treeSha&&p.tests?.passed===true&&typeof p.findings==='string'&&p.findings.length>=20,'Independent review has not passed',409);
  }else if(row.state==='publish'){
   assert(repair&&review&&p.phase==='publish'&&p.candidateSha===repair.data.candidateSha&&p.treeSha===review.data.treeSha&&p.mode===s.mode&&p.branch==='fleet-repair/'+row.id&&/^[a-f0-9]{40}$/.test(p.commit),'Publication differs from reviewed candidate',409);
   await githubProof(env,s.repository,p);
  }else{
   assert(publication&&p.phase==='sync'&&p.commit===publication.data.commit&&p.treeSha===publication.data.treeSha&&p.tests?.passed===true&&p.installedSkillsUntouched===true&&p.filesVerified>0&&typeof p.directory==='string','Synced version not independently verified',409);
   await run(db,'INSERT OR IGNORE INTO skill_deployments(node,profile,commit_sha,cycle_id,directory,receipt_sha,created_at) VALUES(?,?,?,?,?,?,?)',step.node,s.profile,p.commit,row.id,p.directory,proof.receiptSha,now());
  }
  await run(db,'UPDATE skill_cycle_steps SET proof=? WHERE id=? AND proof IS NULL',json(proof),step.originalId||step.id);
  if(step.status==='submitted')await changeTask(db,n,step.id,'accept',{note:'Verified skill cycle '+row.id+' phase '+row.state+', receipt '+proof.receiptSha});
  const next=ACTIVE[ACTIVE.indexOf(row.state)+1]||'completed';
  await run(db,'UPDATE skill_cycles SET state=?,error=NULL,result=?,updated_at=? WHERE id=? AND state=? AND attempt=?',next,next==='completed'?json({commit:p.commit,treeSha:p.treeSha,mode:s.mode,at:now()}):null,now(),row.id,row.state,row.attempt);
 }catch(e){await run(db,'UPDATE skill_cycles SET error=?,updated_at=? WHERE id=?',String(e.message).slice(0,1600),now(),row.id);}
}

export async function skillReleasePolicy(db,n,b){
 const cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 assert(!n.browser&&!n.admin&&n.id===cfg?.controller,'Main controller required',403);
 if(b){
  assert(REPOS[b.profile]&&typeof b.enabled==='boolean','Invalid repair policy');
  const file=await fileRow(db,n,b.project,b.helper?.sha);assert(file.status==='complete'&&file.size===b.helper.size&&b.helper.name==='Skill-Release.py','Verified helper required');
  assert(b.reviewerNode!==n.id&&!cfg.excludedNodes.includes(b.reviewerNode),'Independent reviewer unavailable');
  const bindings=(cfg.localControllers||[]).filter(x=>x.profile===b.profile&&[n.id,b.reviewerNode].includes(x.nodeId));assert(bindings.length===2,'Both controllers must be bound');await validateLocalControllers(db,n,bindings);
  assert(!b.activateAfterCycle&&(!b.triggerMode||b.triggerMode==='on_demand'),'Maintenance is enabled on demand, not by repeated rehearsals',409);
  // Enabling is not a successful release receipt. Each concrete issue still
  // requires frozen regressions, independent review, GitHub and sync proofs.
  const policy={profile:b.profile,enabled:b.enabled,triggerMode:'on_demand',project:b.project,reviewerNode:b.reviewerNode,helper:b.helper};
  await run(db,"INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",'skill_release:'+b.profile,json(policy));
 }
 return {policies:(await all(db,"SELECT value FROM settings WHERE key LIKE 'skill_release:%'")).map(r=>parse(r.value))};
}
export async function requestSkillRecovery(db,n,row,issue,b){
 const spec=parse(row.declaration),policy=parse((await first(db,'SELECT value FROM settings WHERE key=?','skill_release:'+spec.profile))?.value);
 assert(policy?.enabled&&policy.project===row.project,'Automatic skill publication is not enabled for this profile',409);
 const original=await first(db,'SELECT j.*,t.status AS task_status FROM delivery_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.id=?',issue.job_id);
 assert(['failed','submitted','accepted'].includes(original?.task_status)&&!parse(original.verified)?.passed,'Original execution must be known to have ended',409);
 const cycleId='repair-'+hash(issue.id).slice(0,36);
 const cycle=await createSkillCycle(db,n,{id:cycleId,profile:spec.profile,project:row.project,mode:'production',baseCommit:maintenanceCommit(row,b.skillRepair),defect:b.note,allowedPaths:b.skillRepair?.allowedPaths,tests:b.skillRepair?.tests||[],frozenTests:b.skillRepair?.frozenTests||[],helper:policy.helper,reviewerNode:policy.reviewerNode,trigger:{type:b.skillRepair?.trigger||'defect',source:'controller',issueId:issue.id,expected:b.skillRepair?.expected||b.note}});
 await run(db,'INSERT OR IGNORE INTO skill_recovery_links(cycle_id,batch_id,issue_id,created_at) VALUES(?,?,?,?)',cycleId,row.id,issue.id,now());
 return cycle;
}
async function resumeRepairedDeliveries(db,n){
 for(const link of await all(db,"SELECT l.*,c.result FROM skill_recovery_links l JOIN skill_cycles c ON c.id=l.cycle_id WHERE c.controller=? AND c.state='completed'",n.id))try{
  const old=await first(db,'SELECT * FROM delivery_batches WHERE id=?',link.batch_id);
  if(!old||!['preflight','producing','needs_attention'].includes(old.status))continue;
  const spec=parse(old.declaration),tasks=await all(db,'SELECT j.*,t.status AS status FROM delivery_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.batch_id=?',old.id);
  if(tasks.some(t=>!t.status||['queued','claimed','running','uncertain','blocked','cancel_requested'].includes(t.status)))continue;
  const done=new Set(tasks.filter(t=>t.phase==='produce'&&parse(t.verified)?.passed).map(t=>t.item_index));
  const inputs=spec.inputs.filter((_,i)=>!done.has(i));if(!inputs.length)continue;
  const id='resumed-'+hash(link.cycle_id).slice(0,36),commit=parse(link.result).commit;
  await run(db,'UPDATE skill_recovery_links SET successor_id=? WHERE cycle_id=? AND successor_id IS NULL',id,link.cycle_id);
  await createDelivery(db,n,{...spec,id,name:spec.name.slice(0,88)+' · 技能修复后接续',inputs,notes:(spec.notes+'\n接续 '+old.id+' 的未验收材料；已通过两机校验的技能提交 '+commit).slice(0,6000)});
  await run(db,"UPDATE delivery_batches SET status='superseded',error=?,updated_at=? WHERE id=? AND status IN('preflight','producing','needs_attention')",'已修复并自动接续至 '+id,now(),old.id);
  await run(db,"UPDATE delivery_recovery SET state='resolved',response=?,updated_at=? WHERE id=?",json({action:'skill_repaired',note:'修复审核发布与两机同步完成；剩余材料自动接续 '+id,learning:'固定版本 '+commit+'；证据 '+link.cycle_id}),now(),link.issue_id);
 }catch(e){await run(db,'UPDATE skill_cycles SET error=? WHERE id=?','等待接续：'+String(e.message).slice(0,1000),link.cycle_id);}
}
