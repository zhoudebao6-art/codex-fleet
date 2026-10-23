import {assert,parse,json,hash,canonical,now,relativeFile,validId} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {fileRow} from './files.mjs';

export const BATCH_HANDOFF='batch-controller-v1';
export const isBatchHandoff=row=>parse(row.loop_policy)?.dispatchPolicy===BATCH_HANDOFF;
export const groupItems=job=>parse(job.spec)?.batchItems||[job.item_index];
export function batchGroups(spec){
 return spec.nodes.map((node,index)=>({node,items:spec.inputs.map((_,i)=>i).filter(i=>i%spec.nodes.length===index)})).filter(g=>g.items.length);
}
const taskId=(row,node)=>'batch-handoff-'+hash(row.id+':'+node).slice(0,36);
function prompt(row,route,items){
 const owner=parse(row.loop_policy)?.skillOwner;
 const s=parse(row.declaration),files=items.map(i=>({itemIndex:i,...s.inputs[i]}));
 return `批次交接：${s.name}\n批次编号 ${row.id}；技能 ${s.profile}；项目 ${row.project}。你是这台电脑原有技能总控，本批交给你的材料：${json(files)}。其他电脑仅处理各自分配材料。批内案件拆分、并发、子对话和必要质量处理由你决定，Fleet不要求逐案新对话，不另套制作/审核/维护链路。沿原案件接续，禁止重复制作或影响其他任务。${s.mode==='probe'?'本轮仅短流程验证，不完整制作。':''}\n要求：${s.notes||'按材料和本机技能制作'}\n${s.supplemental?`追加要求：${json(s.supplemental)}\n`:''}${s.supplementSource?`历史版本只读参照：${json(s.supplementSource)}；只制作此次新增要求，不覆盖原成果。\n`:''}材料附件可用 fleet_download 按当前交接任务 ${taskId(row,route.nodeId)} 的 SHA 下载到本机项目。先读材料，再安排本批工作。${route.nodeId===owner?.nodeId?'本机发布源直接使用现有技能，不重复预检。':'先核对本批技能发布版本与 Fleet 兼容性，复用当前有效同步记录；仅缺失或变更时针对性核对，不另开逐件预检。'}实际技能问题只转交该技能主负责总控：${owner?json(owner):'尚未绑定，保留问题待绑定后转达'}；不另建维护链路。\n回传：用 fleet_upload 上传成果并等待 complete，再提交批次回报。不需要额外独立审核收据。报告格式 {id:稳定回报编号,items:[{itemIndex:上面的编号,status:"working|blocked|completed",summary:"进度或完成范围",files:[{name:"成品.zip",sha:"真实SHA256",size:字节数}]}]}，可分次回报，同一个id重试内容不变，completed必须有实际已上传成果；候选稿不能报completed。\n提交回报：使用本机 Fleet 安装目录 app/src/common.mjs 的 readJson、httpRequest，读取该安装的 config/node.json，调用 httpRequest(config.hubUrl,"/v1/deliveries/${row.id}/batch-report",{method:"POST",body:报告对象,token:config.nodeToken,sitesToken:config.sitesToken})；沿用本机已配置网络，不输出配置或令牌。主控收到文件后自动下载汇总。暂停/取消后不新增工作；取消时安全停止本批，保留其他任务，回报 {id:稳定编号,cancelled:true}。`;
}

// One original conversation per selected device. No model-generated child jobs,
// fallback conversations, periodic diagnostic tasks or implicit business retries.
export async function tickBatchHandoff(db,actor,row){
 const s=parse(row.declaration),groups=batchGroups(s),routes=parse(row.routing)||[];
 if(row.status==='collecting')return [{kind:'collect',batchId:row.id,project:row.project,name:s.name,mode:s.mode,files:await returnedFiles(db,row)}];
 if(row.status==='cancelling'){
  const jobs=await all(db,'SELECT * FROM delivery_jobs WHERE batch_id=?',row.id);
  for(const j of jobs){
   if(parse(j.verified)?.cancelled||parse(j.verified)?.passed)continue;
   const queued=await run(db,"UPDATE tasks SET status='cancelled',updated=? WHERE id=? AND status='queued'",now(),j.task_id);
   if(queued.meta.changes){await run(db,'UPDATE delivery_jobs SET verified=? WHERE id=?',json({...parse(j.verified),cancelled:true}),j.id);continue;}
   const route=routes.find(r=>r.nodeId===j.node),id='batch-stop-'+hash(j.id).slice(0,36);
   try{await continueDesktop(db,actor,j.node,route.threadId,{id,prompt:`用户取消批次 ${row.id}。停止本批新增工作，安全停止属于本批的制作，保留成果及所有无关任务，不结束整个总控。完成后通过本批 batch-report 接口回报 {id:"${id}",cancelled:true}。`});}
   catch(e){await run(db,'UPDATE delivery_batches SET error=? WHERE id=?',String(e.message).slice(0,1800),row.id);}
  }
  const remaining=await all(db,'SELECT verified FROM delivery_jobs WHERE batch_id=?',row.id);
  if(remaining.every(j=>parse(j.verified)?.cancelled||parse(j.verified)?.passed))await run(db,"UPDATE delivery_batches SET status='cancelled',updated_at=? WHERE id=? AND status='cancelling'",now(),row.id);
  return [];
 }
 if(row.status!=='producing')return [];
 for(const g of groups){
  const id=taskId(row,g.node),route=routes.find(r=>r.nodeId===g.node);
  assert(route,'Original skill controller is not bound',409);
  if(await first(db,'SELECT id FROM delivery_jobs WHERE id=?',id))continue;
  const text=prompt(row,route,g.items);
  await run(db,'INSERT OR IGNORE INTO delivery_handoffs(id,batch_id,node,thread_id,task_id,job_ids,prompt,created_at) VALUES(?,?,?,?,?,?,?,?)',id,row.id,g.node,route.threadId,id,json([id]),text,now());
  try{await continueDesktop(db,actor,g.node,route.threadId,{id,prompt:text});}
  catch(e){if(e.status===403)throw e;await run(db,'UPDATE delivery_batches SET error=? WHERE id=?',String(e.message).slice(0,1800),row.id);continue;}
  const actual=await first(db,'SELECT spec FROM tasks WHERE id=?',id);
  const inputs=[...g.items.map(i=>s.inputs[i]),...(s.supplemental?.attachments||[]),...(s.supplementSource?.artifacts||[])];
  await batch(db,[
   ['INSERT OR IGNORE INTO delivery_jobs(id,batch_id,phase,item_index,node,attempt,task_id,spec,created_at) VALUES(?,?,?,?,?,0,?,?,?)',id,row.id,'produce',g.items[0],g.node,id,json({...parse(actual.spec),batchItems:g.items}),now()],
   ...inputs.map(f=>['INSERT OR IGNORE INTO artifact_refs(task,sha,name,direction) VALUES(?,?,?,?)',id,f.sha,f.name,'input']),
   ['UPDATE delivery_batches SET error=NULL WHERE id=?',row.id]
  ]);
 }
 const jobs=await all(db,'SELECT * FROM delivery_jobs WHERE batch_id=?',row.id);
 if(jobs.length===groups.length&&jobs.every(j=>parse(j.verified)?.passed))await run(db,"UPDATE delivery_batches SET status='collecting',error=NULL,updated_at=? WHERE id=? AND status='producing'",now(),row.id);
 return [];
}
export async function returnedFiles(db,row){return all(db,"SELECT j.task_id AS taskId,r.name,r.sha,f.size FROM delivery_jobs j JOIN artifact_refs r ON r.task=j.task_id JOIN files f ON f.project=? AND f.sha=r.sha WHERE j.batch_id=? AND r.direction='output' AND f.status='complete'",row.project,row.id);}

export async function messageBatch(db,actor,row,b){
 assert(['producing','needs_attention'].includes(row.status),'Resume the batch before adding requirements',409);
 assert(validId(b.id)&&typeof b.prompt==='string'&&b.prompt.trim().length>0&&b.prompt.length<=6000,'Provide message and stable ID');
 const cfg=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value)||{};
 assert(cfg.controller===row.controller,'Controller changed',409);
 const routes=parse(row.routing)||[],groups=batchGroups(parse(row.declaration));
 for(const group of groups)assert(!cfg.excludedNodes?.includes(group.node),'A selected device is paused; no new messages sent',409);
 const results=[];
 for(const group of groups){const r=routes.find(x=>x.nodeId===group.node),id='batch-note-'+hash(row.id+':'+b.id+':'+r.nodeId).slice(0,36);
  // Stable original-thread messages are resumable after partial cross-device delivery.
  await continueDesktop(db,actor,r.nodeId,r.threadId,{id,prompt:`批次 ${row.id} 追加要求：\n${b.prompt}\n请在原批次中接续处理，不重复制作已有成果；未接到本批材料时等待原交接，不另行创建一批。`});results.push(id);
 }
 return {ok:true,messages:results};
}

export async function reportBatchHandoff(db,n,row,b){
 assert(isBatchHandoff(row)&&!n.browser&&!n.admin,'Assigned device credentials required',403);
 const job=await first(db,'SELECT * FROM delivery_jobs WHERE batch_id=? AND node=?',row.id,n.id);assert(job,'This device has no batch assignment',403);
 assert(validId(b.id),'Stable report ID required');
 const key='batch-report:'+row.id+':'+n.id+':'+b.id,digest=hash(canonical(b)),old=await first(db,'SELECT value FROM settings WHERE key=?',key);
 if(old){assert(parse(old.value).digest===digest,'Report ID changed',409);return {ok:true,replayed:true};}
 assert(['producing','paused','needs_attention','cancelling'].includes(row.status),'Batch is closed',409);
 const assigned=groupItems(job),prior=parse(job.verified)||{items:[]},items=new Map((prior.items||[]).map(i=>[i.itemIndex,i]));
 const refs=[];
 if(b.cancelled){assert(row.status==='cancelling','Cancellation was not requested',409);}
 else {
  assert(Array.isArray(b.items)&&b.items.length>0&&b.items.length<=assigned.length&&new Set(b.items.map(i=>i.itemIndex)).size===b.items.length,'Invalid item progress');
  for(const i of b.items){
   assert(assigned.includes(i.itemIndex)&&['working','blocked','completed'].includes(i.status)&&typeof i.summary==='string'&&i.summary.length<=2000,'Invalid assigned item');
   assert(!items.has(i.itemIndex)||items.get(i.itemIndex).status!=='completed','Completed version is immutable; submit a supplement',409);
   assert(Array.isArray(i.files||[])&&(i.files||[]).length<=40&&new Set((i.files||[]).map(f=>f.name.toLowerCase())).size===(i.files||[]).length,'Invalid file list');
   assert(i.status!=='completed'||i.files?.length>0,'Completed item must include delivery files',409);
   for(const f of i.files||[]){
    assert(relativeFile(f.name)&&!f.name.includes('/')&&!f.name.includes('\\')&&/^[a-f0-9]{64}$/.test(f.sha)&&Number.isSafeInteger(f.size)&&f.size>0,'Invalid delivery file');
    const stored=await fileRow(db,n,row.project,f.sha);assert(stored.status==='complete'&&stored.size===f.size,'Finish file transfer before reporting completion',409);
    if(i.status==='completed')refs.push(['INSERT OR IGNORE INTO artifact_refs(task,sha,name,direction) VALUES(?,?,?,?)',job.task_id,f.sha,`batch/item-${i.itemIndex+1}/${f.name}`,'output']);
   }
   items.set(i.itemIndex,{itemIndex:i.itemIndex,status:i.status,summary:i.summary,files:i.files||[]});
  }
 }
 const proof={...prior,items:[...items.values()],passed:assigned.every(i=>items.get(i)?.status==='completed'),cancelled:!!b.cancelled,transferOnly:true};
 await batch(db,[['SELECT json(CASE WHEN EXISTS(SELECT 1 FROM delivery_jobs WHERE id=? AND verified IS ?) THEN \'true\' ELSE \'concurrent-report-retry\' END)',job.id,job.verified],...refs,['UPDATE delivery_jobs SET verified=? WHERE id=?',json(proof),job.id],['INSERT INTO settings(key,value) VALUES(?,?)',key,json({digest,at:now()})],['UPDATE delivery_batches SET updated_at=?,error=NULL WHERE id=?',now(),row.id],['INSERT INTO events(id,node,task,type,payload,created) VALUES(?,?,?,?,?,?)','batch-report-'+hash(key).slice(0,40),n.id,job.task_id,'progress',json({kind:'assistant_message',source:'batch-controller-report',message:b.cancelled?'原总控确认本批已停止':b.items.map(i=>i.summary).join('\n').slice(0,2000)}),now()]]);
 return {ok:true,completed:proof.passed};
}
