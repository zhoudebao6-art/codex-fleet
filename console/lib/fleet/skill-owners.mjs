import {assert,parse,json,now,hash,canonical,validId} from './util.mjs';
import {first,all,run} from './db.mjs';
import {admin,writer,can} from './auth.mjs';
import {assertNodeAccess} from './access.mjs';
import {desktopAccess} from './desktop.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {currentCreator} from './orchestration.mjs';
export const OWNER_MODE='skill-owner-message-v1';
const repositories={auto20:'zhoudebao6-art/software-case-batch',software:'zhoudebao6-art/software-system-delivery'};
export async function owners(db){return parse((await first(db,"SELECT value FROM settings WHERE key='skill_owners'"))?.value)||[];}
export async function skillOwners(db,n,b){
 if(b){admin(n);assert(Array.isArray(b.owners)&&b.owners.length<=32,'Invalid skill owners');const seen=new Set(),values=[];
  for(const o of b.owners){assert(repositories[o.profile]&&!seen.has(o.profile)&&validId(o.nodeId)&&validId(o.threadId),'Choose one owner per skill');seen.add(o.profile);const t=await desktopAccess(db,n,o.nodeId,o.threadId);assert(!t.archived&&t.cwd,'Original controller is unavailable',409);values.push({profile:o.profile,nodeId:o.nodeId,threadId:o.threadId,project:t.project,title:t.title,repository:repositories[o.profile]});}
  await run(db,"INSERT INTO settings(key,value) VALUES('skill_owners',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",json(values));
 }
 const visible=[];for(const o of await owners(db)){try{await assertNodeAccess(db,n,o.nodeId);if(can(n,o.project))visible.push(o);}catch{}}
 return {owners:visible};
}
export async function submitImprovement(db,n,b){
 writer(n);assert(validId(b.id)&&repositories[b.profile]&&can(n,b.project),'Invalid improvement request');
 assert(['quality_gap','defect','upgrade','requirement_change'].includes(b.trigger),'Invalid trigger');
 assert(typeof b.description==='string'&&b.description.trim().length>=10&&b.description.length<=5000&&typeof b.expected==='string'&&b.expected.trim().length>=10&&b.expected.length<=5000,'Describe the change and expected result');
 assert(b.evidence===undefined||typeof b.evidence==='string'&&b.evidence.length<=5000,'Invalid evidence');
 const request={profile:b.profile,trigger:b.trigger,description:b.description.trim(),expected:b.expected.trim(),evidence:b.evidence?.trim()||'',batchId:b.batchId||null},digest=hash(canonical({...request,project:b.project}));
 let row=await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',b.id);
 if(row){assert(row.creator===n.id&&row.declaration_hash===digest,'Request ID already used',409);await assertNodeAccess(db,n,row.controller);return row;}
 const owner=(await owners(db)).find(o=>o.profile===b.profile);assert(owner&&owner.project===b.project,'请先绑定该技能的主负责设备和原总控',409);await assertNodeAccess(db,n,owner.nodeId);
 if(b.batchId){const batch=await first(db,'SELECT * FROM delivery_batches WHERE id=?',b.batchId);assert(batch&&batch.project===b.project&&parse(batch.declaration).profile===b.profile,'Related batch differs',409);for(const id of parse(batch.declaration).nodes)await assertNodeAccess(db,n,id);}
 const declaration={...request,mode:OWNER_MODE,owner,creatorKind:n.id==='admin'&&!n.browser?'service':n.kind==='device'?'device':!n.browser?'node':'member',origin:n.browser||n.admin?'human':'controller'};
 await run(db,'INSERT INTO skill_maintenance_requests(id,controller,project,creator,declaration,declaration_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',b.id,owner.nodeId,b.project,n.id,json(declaration),digest,now(),now());
 row=await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',b.id);await forwardImprovement(db,row,n);return await first(db,'SELECT * FROM skill_maintenance_requests WHERE id=?',b.id);
}
export async function forwardImprovement(db,row,actor){
 const d=parse(row.declaration);if(d.mode!==OWNER_MODE||row.state==='cancelled')return;
 try{
  const cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value)||{};
  assert(!cfg.excludedNodes?.includes(row.controller),'主负责设备已暂停，需求保留待发送',409);
  const id=row.task_id||'skill-note-'+hash(row.id).slice(0,36),existing=await first(db,'SELECT status,result FROM tasks WHERE id=?',id);
  if(!existing){actor??=await currentCreator(db,{creator:row.creator,creator_kind:d.creatorKind,project:row.project});
   await continueDesktop(db,actor,row.controller,d.owner.threadId,{id,prompt:`技能改进需求 ${row.id}：${d.profile}\n问题或调整：${d.description}\n期望：${d.expected}\n相关批次：${d.batchId||'无'}\n证据：${d.evidence||'无'}\n你是此技能的主负责总控，按本机原技能流程处理、验证和发布（仓库 ${d.owner.repository}），并在原对话回复结果和版本。不要影响运行中的任务，不重复制作已有案件。Fleet只转达需求和汇总反馈，不另建评估、审核或维护链路。`});
  }
  const task=existing||await first(db,'SELECT status,result FROM tasks WHERE id=?',id);
  const state=['submitted','accepted'].includes(task.status)?'replied':['failed','blocked','uncertain','cancel_requested'].includes(task.status)?'needs_attention':task.status==='cancelled'?'cancelled':'forwarded';
  await run(db,'UPDATE skill_maintenance_requests SET state=?,task_id=?,error=?,updated_at=? WHERE id=?',state,id,['needs_attention'].includes(state)?'请查看原总控消息；未自动重发':null,now(),row.id);
 }catch(e){await run(db,'UPDATE skill_maintenance_requests SET error=?,updated_at=? WHERE id=?',e.code==='NODE_OFFLINE'?'主负责设备暂时离线，恢复连接后自动转达；不会另建任务。':String(e.message).slice(0,1600),now(),row.id);}
}
export async function advanceImprovements(db){for(const row of await all(db,"SELECT * FROM skill_maintenance_requests WHERE json_extract(declaration,'$.mode')=? AND state IN('submitted','forwarded') ORDER BY created_at LIMIT 20",OWNER_MODE))await forwardImprovement(db,row);}
