import {assert,parse,json,hash,now,validId} from './util.mjs';
import {first,all,run} from './db.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';
import {requestSkillRecovery} from './skill-cycles.mjs';
import {submit} from './tasks.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {relayOriginalMessage} from './delivery-relay.mjs';

export const loopEnabled=row=>parse(row.loop_policy)?.version===1;
export async function loopView(db,row){
 if(!loopEnabled(row))return null;
 const issues=await all(db,'SELECT r.*,t.status AS message_status FROM delivery_recovery r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.batch_id=? ORDER BY r.created_at DESC,r.id',row.id);
 return {perDevice:parse(row.loop_policy).perDevice,issues:issues.map(r=>({id:r.id,jobId:r.job_id,kind:r.kind,state:r.state,detail:r.detail,taskId:r.task_id,messageStatus:r.message_status,report:parse(r.response),at:r.updated_at}))};
}
// Include other batches, ordinary Fleet work and observed native activity.
// Reserved but not-yet-submitted jobs consume capacity too.
export async function chooseDeliveryNode(db,row){
 const spec=parse(row.declaration),limit=parse(row.loop_policy)?.perDevice||2,candidates=[];
 for(const id of spec.nodes){
  const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',id);
  if(!node)continue;
  node.maintenance={enabled:!!await first(db,'SELECT node FROM node_maintenance WHERE node=? AND expires_at>?',id,now())};
  if(runtimeIssue(node,{parallel:true}))continue;
  const caps=parse(node.capabilities)||{};
  const tasks=await all(db,"SELECT id,spec,thread_id FROM tasks WHERE target=? AND status IN('queued','claimed','running','uncertain','cancel_requested')",id);
  const business=tasks.filter(t=>!parse(t.spec)?.desktopThreadId);
  const reservations=await all(db,"SELECT j.id FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id LEFT JOIN tasks t ON t.id=j.task_id WHERE j.node=? AND t.id IS NULL AND b.status IN('preflight','producing')",id);
  const native=Array.isArray(caps.activeConversations)?caps.activeConversations:[],known=new Set(tasks.flatMap(t=>[t.id,t.thread_id]).filter(Boolean));
  const fresh=new Date(Date.now()-120000).toISOString();
  const observed=await all(db,"SELECT thread_id FROM desktop_threads WHERE node=? AND status IN('running','waiting') AND status_source='app_server_runtime' AND observed_at>=? AND received_at>=?",id,fresh,fresh);
  const nativeIds=new Set([...native.map(t=>typeof t==='string'?t:t.threadId||t.id),...observed.map(t=>t.thread_id)].filter(tid=>tid&&!known.has(tid)));
  const nativeLoad=nativeIds.size;
  const configuredLimit=await first(db,'SELECT value FROM settings WHERE key=?','parallel_limit:'+id);
  const slotLimit=Math.max(1,Math.min(16,Number(caps.maxRunning)||4,Number(configuredLimit?.value)||4));
  const same=await first(db,"SELECT count(*) n FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id LEFT JOIN tasks t ON t.id=j.task_id WHERE j.node=? AND json_extract(b.declaration,'$.profile')=? AND b.status IN('preflight','producing') AND (t.id IS NULL OR t.status IN('queued','claimed','running','uncertain','cancel_requested'))",id,spec.profile);
  const load=business.length+reservations.length+nativeLoad;
  if(same.n>=limit||load>=slotLimit)continue;
  const allocated=await first(db,"SELECT count(*) n FROM delivery_jobs WHERE batch_id=? AND phase='produce' AND node=? AND attempt=0",row.id,id);
  candidates.push({id,load,allocated:allocated.n});
 }
 candidates.sort((a,b)=>a.load-b.load||a.allocated-b.allocated||spec.nodes.indexOf(a.id)-spec.nodes.indexOf(b.id));
 return candidates[0]?.id||null;
}
export async function recordRecovery(db,row,job,kind,detail){
 if(!loopEnabled(row))return null;
 const existing=await first(db,"SELECT id FROM delivery_recovery WHERE batch_id=? AND job_id=? AND state!='resolved' LIMIT 1",row.id,job.id);
 if(existing)return existing.id;
 const id='recovery-'+hash(row.id+':'+job.id+':'+kind).slice(0,36),ts=now();
 await run(db,"INSERT OR IGNORE INTO delivery_recovery(id,batch_id,job_id,kind,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",id,row.id,job.id,kind,String(detail).slice(0,1800),ts,ts);
 return id;
}
export async function reconcileRecovery(db,row){
 for(const r of await all(db,"SELECT r.*,j.verified,t.status AS task_status FROM delivery_recovery r JOIN delivery_jobs j ON j.id=r.job_id LEFT JOIN tasks t ON t.id=j.task_id WHERE r.batch_id=? AND r.state!='resolved'",row.id)){
  const newer=await first(db,'SELECT n.id FROM delivery_jobs old JOIN delivery_jobs n ON n.batch_id=old.batch_id AND n.phase=old.phase AND n.item_index=old.item_index AND n.attempt>old.attempt WHERE old.id=? LIMIT 1',r.job_id);
  if(parse(r.verified)?.passed||newer||(['execution','handoff'].includes(r.kind)&&['claimed','running','submitted','accepted'].includes(r.task_status)))
   await run(db,"UPDATE delivery_recovery SET state='resolved',updated_at=? WHERE id=?",now(),r.id);
  else if(r.state==='observing'&&Date.now()-Date.parse(r.updated_at)>30*60000)
   await run(db,"UPDATE delivery_recovery SET state='needs_input',updated_at=? WHERE id=?",now(),r.id);
 }
}
export async function sendRecoveryRequests(db,actor,row){
 if(!loopEnabled(row)||!['preflight','producing'].includes(row.status))return;
 const route=parse(row.loop_policy)?.master;
 if(!route)return; // Old installations retain durable issues until a controller is bound.
 for(const r of await all(db,"SELECT r.*,t.status AS message_status FROM delivery_recovery r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.batch_id=? AND r.state='diagnosing' ORDER BY created_at LIMIT 2",row.id)){
  if(r.task_id){
   const source=await first(db,'SELECT spec,result FROM tasks WHERE id=?',r.task_id),result=parse(source?.result);
   const refused=r.message_status==='blocked'&&result?.desktop?.reason==='NATIVE_CONTINUATION_BUSY'&&result.desktop.state==='busy';
   const missed=['submitted','accepted'].includes(r.message_status)&&Date.now()-Date.parse(r.updated_at)>120000;
   if((refused||missed)&&!r.task_id.startsWith('diagnose-')){
    const id='diagnose-'+hash(r.id).slice(0,36);
    await submit(db,actor,{id,targetNode:row.controller,project:row.project,workspaceId:route.workspaceId,role:'delivery-recovery',mode:'execute',executionPolicy:'local',requireDesktop:true,worktree:false,outputs:[],prompt:parse(source.spec).prompt+'\n原总控未完成结构化回报，由你在独立桌面会话执行以上诊断并回报，不要等待其他会话人工接续。'});
    await run(db,'UPDATE delivery_recovery SET task_id=?,updated_at=? WHERE id=? AND task_id=?',id,now(),r.id,r.task_id);continue;
   }
   // Unknown delivery is not permission to resend. Finished messages get a
   // bounded response window, then surface precisely this item.
   if(['submitted','accepted','failed','blocked'].includes(r.message_status)&&Date.now()-Date.parse(r.updated_at)>15*60000)
    await run(db,"UPDATE delivery_recovery SET state='needs_input',updated_at=? WHERE id=? AND state='diagnosing'",now(),r.id);
   continue;
  }
  const id='loop-'+hash(r.id).slice(0,36),spec=parse(row.declaration);
  const prompt=`自动交付闭环排障 · ${spec.name}\n你是本机既有 ${spec.profile} 总控。主控检测到单项阻碍，其他材料继续运行。批次 ${row.id}，问题 ${r.id}，原子任务 ${r.job_id}，类别 ${r.kind}，现象：${r.detail}\n先查询原任务、事件及收据，核对目标电脑实际状态。可向其原总控查询；不得凭超时推断任务停止，不重派未知状态的执行，不中断其他工作、不降低审核标准。优先复用已有环境和原成果，恢复网络后续传。先区分单件返修、运行故障和通用技能维护。成品未达要求、质量不足、漏洞、明确升级或用户调整需求且根因属于通用技能时才维护；网络、休眠和续传故障仅恢复运行。维护须记录不达标证据和期望标准。同一技能的确定性差距应在独立候选副本中重现、修复、回归并独立审核；不要覆盖正在使用或含本地未发布改动的技能。修复记录写入 report 的 learning 字段（原因、候选路径、测试、回滚、审核证据），后续新批次读取该记录，但仍以 GitHub 固定版本与文件校验为准。不能把候选修复自动当成已发布版本。\n完成诊断后在主控 Fleet 安装目录运行 scripts/Report-DeliveryRecovery.mjs --batch ${row.id} --issue ${r.id} --report <本机JSON路径>。JSON 格式 {action:"observe|retry|repair_skill|need_input",note:"具体依据与处理",learning?:"可复用的故障与修复证据"}。observe 表示原任务仍运行或等待原通道恢复；retry 仅用于已明确终止的失败任务且返修次数未耗尽，服务端复核后接续；need_input 仅用于材料/权限缺失或已耗尽安全恢复方式。如已实际复现通用技能缺陷或验收差距，report 使用 action:"repair_skill"，skillRepair:{baseCommit:"本机发布源仅在本次具体维护时读取的真实40位Git提交；其他批次沿原固定基线",trigger:"defect或quality_gap或upgrade或requirement_change",expected:"具体验收标准",allowedPaths:["实际仓库相对路径"],tests:[{runtime:"python或node",path:"现有回归脚本相对路径",args:[]}]}。服务按固定基线启动独立修复、另一电脑审核、真实发布及两机校验，再自动接续失败材料；不得自己改全局技能。若当前 Report-DeliveryRecovery.mjs 未转发 skillRepair，仿照该脚本认证方式直接提交同一 recovery 接口完整 JSON。不要自行更改任务合同、版本基线或伪造完成。未确认的远端状态只报告 observe。`;
  try{
   // Stable ID survives a crash between send and persistence.
   await continueDesktop(db,actor,row.controller,route.threadId,{id,prompt});
   await run(db,'UPDATE delivery_recovery SET task_id=?,updated_at=? WHERE id=? AND task_id IS NULL',id,now(),r.id);
  }catch{}
 }
}
export async function recoveryReport(db,n,row,issueId,b){
 assert(!n.browser&&!n.admin&&n.id===row.controller,'Only the main controller may report recovery',403);
 assert(loopEnabled(row)&&['preflight','producing'].includes(row.status),'Batch is paused or stopped',409);
 assert(validId(issueId)&&['observe','retry','repair_skill','need_input'].includes(b.action)&&typeof b.note==='string'&&b.note.trim().length>=10&&b.note.length<=5000,'Provide a concrete recovery report');
 assert(b.learning===undefined||typeof b.learning==='string'&&b.learning.length<=5000,'Invalid learning record');
 const issue=await first(db,'SELECT * FROM delivery_recovery WHERE id=? AND batch_id=?',issueId,row.id);
 assert(issue,'Unknown recovery issue',404);
 const report={action:b.action,note:b.note,learning:b.learning||'',at:now()};
 if(issue.state==='resolved')return {ok:true,state:'resolved'};
 if(b.action==='repair_skill'){const cycle=await requestSkillRecovery(db,n,row,issue,b);await run(db,"UPDATE delivery_recovery SET state='repairing',response=?,updated_at=? WHERE id=?",json({...report,cycleId:cycle.id}),now(),issue.id);return {ok:true,state:'repairing',cycleId:cycle.id};}
 if(b.action==='retry'){
  const job=await first(db,'SELECT j.*,t.status AS task_status FROM delivery_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.id=?',issue.job_id);
  assert(['failed','submitted','accepted'].includes(job?.task_status)&&!parse(job.verified)?.passed,'The original execution must have ended without a verified delivery',409);
  assert(job.attempt<parse(row.declaration).maxRepairs,'Repair limit reached',409);
  assert(!await first(db,'SELECT id FROM delivery_jobs WHERE batch_id=? AND phase=? AND item_index=? AND attempt>?',row.id,job.phase,job.item_index,job.attempt),'A later attempt already exists',409);
  const proof={...parse(job.verified),passed:false,error:issue.detail,retryAuthorized:true,resolution:{id:issue.id,note:b.note,actor:n.id,at:report.at}};
  await run(db,'UPDATE delivery_jobs SET verified=? WHERE id=?',json(proof),job.id);
 }
 await run(db,'UPDATE delivery_recovery SET state=?,response=?,updated_at=? WHERE id=?',b.action==='retry'?'resolved':b.action==='need_input'?'needs_input':'observing',json(report),now(),issue.id);
 return {ok:true,state:b.action==='retry'?'resolved':b.action==='need_input'?'needs_input':'observing'};
}
