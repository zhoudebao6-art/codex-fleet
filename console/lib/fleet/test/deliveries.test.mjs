import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now,canonical} from '../util.mjs';
import {advanceAutomations,automationTaskId} from '../orchestration.mjs';
import {chooseDeliveryNode} from '../delivery-loop.mjs';
import {relayOriginalMessage} from '../delivery-relay.mjs';
import {continueDesktop} from '../native-continuation.mjs';
import {advanceSkillCycles} from '../skill-cycles.mjs';
import {advanceMaintenanceRequests} from '../skill-maintenance.mjs';
import {SKILL_SOURCE_NODE} from '../delivery-preflight.mjs';
import {SUPPLEMENTAL_SKILL} from '../delivery-supplements.mjs';

test('pausing a device preserves unchanged stale bindings but rejects a new invalid binding',async t=>{
 const f=await localControllerFixture(t);
 const cfg=(await f.req('/v1/delivery/settings')).body.settings;
 f.db.db.prepare("UPDATE desktop_threads SET archived=1 WHERE thread_id=?").run(f.threadId);
 const update={...cfg,excludedNodes:[...cfg.excludedNodes,f.worker.id]};
 assert.equal((await f.post('/v1/delivery/settings',update,f.adminToken)).status,200);
 assert.equal((await f.post('/v1/delivery/settings',{...update,localControllers:[{...f.binding,threadId:'missing-thread'}]},f.adminToken)).status,409);
});

test('batch handoff uses one existing controller for multiple items and collects only actual returned files',async t=>{
 const f=await localControllerFixture(t),second=await f.upload('材料二.docx','second input');
 const spec={...f.spec,dispatchPolicy:'batch-controller-v1',inputs:[f.input||f.spec.inputs[0],second]};
 assert.equal((await f.create(spec)).body.status,'producing');
 await f.tick();await f.tick();
 const tasks=f.db.db.prepare('SELECT * FROM tasks').all();assert.equal(tasks.length,1);
 const task=tasks[0];assert.equal(JSON.parse(task.spec).desktopThreadId,f.threadId);assert.match(JSON.parse(task.spec).prompt,/批内案件拆分/);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_jobs').get().n,1);
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM artifact_refs WHERE direction='input'").get().n,2);
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
 await f.tick();assert.equal((await f.get()).body.status,'producing','A finished message is not a finished delivery');
 assert.equal((await f.get()).body.jobs[0].status,'received');
 const report=b=>f.post('/v1/deliveries/'+spec.id+'/batch-report',b,f.worker.token);
 assert.equal((await f.post('/v1/deliveries/'+spec.id+'/batch-report',{id:'wrong-node',items:[]},f.master.token)).status,403);
 assert.equal((await report({id:'missing-files',items:[{itemIndex:0,status:'completed',summary:'done',files:[]}]})).status,409);
 const zip=await f.upload('交付.zip','actual delivered bytes');
 const r={id:'result-one',items:[{itemIndex:0,status:'completed',summary:'first item delivered',files:[zip]}]};
 assert.equal((await report(r)).status,200);assert.equal((await report(r)).body.replayed,true);
 const download=await f.req('/v1/artifacts/'+zip.sha+'?task='+task.id,{token:f.master.token});assert.equal(download.status,200);assert.equal(download.body.toString(),'actual delivered bytes');
 assert.equal((await report({...r,items:[{...r.items[0],summary:'changed'}]})).status,409);
 assert.equal((await f.get()).body.files.length,1);assert.equal((await f.get()).body.jobs[1].status,'received');
 const zip2=await f.upload('交付二.zip','second delivered bytes');
 assert.equal((await report({id:'result-two',items:[{itemIndex:1,status:'completed',summary:'second item delivered',files:[zip2]}]})).status,200);
 await f.tick();assert.equal((await f.get()).body.status,'collecting');
 const op=(await f.tick()).body.operations[0];assert.equal(op.kind,'collect');assert.equal(op.files.length,2);
 assert.equal((await f.ack({kind:'collect',relativeDirectory:'deliveries/'+spec.id,files:op.files.map(({name,sha,size})=>({name,sha,size}))})).status,200);
 assert.equal((await f.get()).body.status,'completed');
 f.worker.capabilities.skills.push('supplemental-delivery');await f.poll(f.worker,[],true);
 const child=await f.post('/v1/deliveries/'+spec.id+'/supplements',{id:'batch-supplement',name:'历史追加',itemIndex:1,sourceTaskId:task.id,nodes:[f.worker.id],notes:'请结合原交付材料补充视频解说词。',attachments:[],maxRepairs:2});
 assert.equal(child.status,200,JSON.stringify(child.body));assert.equal(child.body.dispatchPolicy,'batch-controller-v1');assert.equal(child.body.supplementSource.artifacts.length,1);
});

test('each selected device receives one immutable batch portion and excluded nodes cannot be selected',async t=>{
 const f=await localControllerFixture(t),ts=now(),threadId=uid(),workspaceId=uid();
 f.master.capabilities.desktopContinuation=true;f.master.capabilities.conversationReady=true;await f.poll(f.master,[],true);
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','主控','E:/automation',?,?,?)").run(f.master.id,threadId,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','主控','E:/automation','e:/automation','registered','ready',?,'hash',?,?)").run(workspaceId,f.master.id,f.master.id,ts,ts);
 await f.configure({allowControllerWork:true,localControllers:[f.binding,{nodeId:f.master.id,profile:'software',workspaceId,threadId}]});
 const inputs=[f.spec.inputs[0],await f.upload('second.docx','second'),await f.upload('third.docx','third'),await f.upload('fourth.docx','fourth')];
 const spec={...f.spec,inputs,nodes:[f.master.id,f.worker.id],dispatchPolicy:'batch-controller-v1'};
 assert.equal((await f.create(spec)).status,200);await f.tick();await f.tick();
 const jobs=f.db.db.prepare('SELECT * FROM delivery_jobs ORDER BY item_index').all();assert.equal(jobs.length,2);
 assert.deepEqual(jobs.map(j=>JSON.parse(j.spec).batchItems),[[0,2],[1,3]]);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
 assert.equal((await f.create({...spec,id:'excluded-batch',nodes:[f.excluded.id]})).status,409);
 assert.equal((await f.post('/v1/deliveries/'+spec.id+'/batch-report',{id:'wrong-item',items:[{itemIndex:0,status:'working',summary:'other node item'}]},f.worker.token)).status,400);
 await f.post('/v1/deliveries/'+spec.id+'/cancel',{});await f.tick();assert.equal((await f.get()).body.status,'cancelled','Queued handoffs cancel without opening a new controller message');
});

test('batch handoff survives unavailable original connection without fallback, respects pause and safe cancellation',async t=>{
 const f=await localControllerFixture(t);await f.create({...f.spec,dispatchPolicy:'batch-controller-v1'});
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01' WHERE id=?").run(f.worker.id);
 await f.tick();assert.equal((await f.get()).body.status,'producing');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 await f.poll(f.worker,[],true);
 await f.tick();await f.tick();
 const task=f.db.db.prepare('SELECT * FROM tasks').get();assert.ok(task);
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(task.id);
 await f.tick();assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1,'Unknown send never starts a fallback or duplicate');
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
 const note={id:'new-requirement',prompt:'补充最终文件命名要求'};
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/message',note)).status,200);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/message',note)).status,200);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
 f.db.db.prepare("UPDATE tasks SET status='submitted'").run();
 await f.post('/v1/deliveries/'+f.spec.id+'/pause',{});await f.tick();
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/message',{id:'paused-note',prompt:'do not send'})).status,409);
 await f.post('/v1/deliveries/'+f.spec.id+'/cancel',{});await f.tick();
 assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'submitted','Cancel never kills an original controller');
 const res=await f.post('/v1/deliveries/'+f.spec.id+'/batch-report',{id:'stopped',cancelled:true},f.worker.token);assert.equal(res.status,200);
 await f.tick();assert.equal((await f.get()).body.status,'cancelled');
});

test('maintenance is explicit and idempotent; ordinary delivery ticks do not invent a repair',async t=>{
 const f=await skillFixture(t),request={id:'quality-request',profile:'software',project:'workspace',trigger:'quality_gap',description:'交付数据导出缺少必要的计算依据，需要改进通用流程。',expected:'每份交付数据可从原始输入复算，并与网页结果逐项一致。'};
 for(let i=0;i<3;i++)await f.tick();assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_maintenance_requests').get().n,0);
 const identity=f.member('operator'),options={method:'POST',data:request,token:null,identity};
 assert.equal((await f.req('/v1/skill-maintenance',options)).status,200);assert.equal((await f.req('/v1/skill-maintenance',options)).body.origin,'human');
 assert.equal((await f.req('/v1/skill-maintenance',{...options,data:{...request,expected:'changed expectation changed expectation'}})).status,409);
 assert.equal((await f.req('/v1/skill-maintenance',{...options,identity:f.member('viewer'),data:{...request,id:'viewer-ask'}})).status,403);
 assert.equal((await f.req('/v1/skill-maintenance',{...options,data:{...request,id:'vague',expected:''}})).status,400);
 const tick=()=>advanceMaintenanceRequests(f.db,f.env,f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id));await tick();await tick();
 const row=f.db.db.prepare('SELECT * FROM skill_maintenance_requests').get();assert.equal(row.state,'assessing');assert.equal(f.db.db.prepare("SELECT count(*) n FROM tasks WHERE id LIKE 'maintenance-assess-%'").get().n,1);
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(row.task_id);await tick();assert.equal(f.db.db.prepare("SELECT count(*) n FROM tasks WHERE id LIKE 'maintenance-assess-%'").get().n,1);
 assert.equal((await f.req('/v1/skill-maintenance/quality-request/cancel',{method:'POST',data:{},identity,token:null})).status,200);assert.equal((await f.req('/v1/tasks/'+row.task_id)).body.status,'uncertain','Cancellation never kills an unknown assessment');
});
test('main controller distinguishes environment recovery from shared skill maintenance using a real receipt',async t=>{
 const f=await skillFixture(t),b={id:'connection-only',profile:'software',project:'workspace',trigger:'defect',description:'交付上传时网络连接中断，需要判断是否是通用技能问题。',expected:'恢复同一文件传输且不要修改正在运行的业务技能。'};
 assert.equal((await f.post('/v1/skill-maintenance',b)).status,200);
 const tick=()=>advanceMaintenanceRequests(f.db,f.env,f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id));await tick();
 const row=f.db.db.prepare('SELECT * FROM skill_maintenance_requests').get();await f.poll(f.master);const task=(await f.req('/v1/tasks/'+row.task_id)).body;
 await f.output(f.master,task,task.spec.outputs[0],JSON.stringify({requestId:b.id,decision:'runtime_recovery',reason:'已核对原传输任务，属于网络断开且原文件校验一致，应恢复同一传输记录；没有技能代码缺陷。'}));await f.finish(f.master,task);await tick();
 assert.equal(f.db.db.prepare('SELECT state FROM skill_maintenance_requests').get().state,'no_maintenance');assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_cycles').get().n,0);
});
test('new requirement is assessed then produces one scoped repair with immutable acceptance scripts',async t=>{
 const f=await skillFixture(t);
 assert.equal((await f.post('/v1/skill-release-policy',{profile:'software',enabled:true,project:'workspace',helper:f.declaration.helper,reviewerNode:f.worker.id})).status,200);
 const b={id:'requirement-ask',profile:'software',project:'workspace',trigger:'requirement_change',description:'新增导出后核对后台结果的步骤，当前通用技能没有该步骤。',expected:'导出数据必须与同一输入的后端计算结果一致，否则验收失败。'};
 await f.post('/v1/skill-maintenance',b);const actor=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id),tick=()=>advanceMaintenanceRequests(f.db,f.env,actor);await tick();
 const row=f.db.db.prepare('SELECT * FROM skill_maintenance_requests').get();await f.poll(f.master);const task=(await f.req('/v1/tasks/'+row.task_id)).body;
 const check=await f.upload('acceptance.py','assert quality_contract_is_satisfied');
 await f.output(f.master,task,task.spec.outputs[0],JSON.stringify({requestId:b.id,decision:'maintain',reason:'已读取当前技能和导出路径，缺少通用一致性检查，新增独立验收脚本固定这个差距，修改技能步骤即可修复。',baseCommit:'a'.repeat(40),allowedPaths:['SKILL.md'],tests:[],frozenTests:[{...check,runtime:'python',args:[]}]}));await f.finish(f.master,task);await tick();assert.equal(f.db.db.prepare('SELECT state FROM skill_maintenance_requests').get().state,'planned');
 await tick();await tick();const updated=f.db.db.prepare('SELECT * FROM skill_maintenance_requests').get();assert.equal(updated.state,'maintaining');
 const cycle=JSON.parse(f.db.db.prepare('SELECT declaration FROM skill_cycles WHERE id=?').get(updated.cycle_id).declaration);assert.equal(cycle.trigger.type,'requirement_change');assert.equal(cycle.frozenTests[0].sha,check.sha);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_cycles').get().n,1);
});

async function skillFixture(t){
 const f=await localControllerFixture(t),ts=now(),masterThread=uid(),masterWorkspace=uid();
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','主控','D:/master',?,?,?)").run(f.master.id,masterThread,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','主控','D:/master','d:/master','registered','ready',?,'hash',?,?)").run(masterWorkspace,f.master.id,f.master.id,ts,ts);
 await f.configure({localControllers:[f.binding,{nodeId:f.master.id,profile:'software',workspaceId:masterWorkspace,threadId:masterThread}]});
 const id='cycle-'+uid(),helper=await f.upload('Skill-Release.py','Frozen helper fixture'),declaration={id,profile:'software',project:'workspace',mode:'validation',baseCommit:'a'.repeat(40),defect:'Reproducible isolated normalization fixture failure',allowedPaths:['fleet_validation/'+id],tests:[],reviewerNode:f.worker.id,helper};
 const create=()=>f.post('/v1/skill-cycles',declaration),get=()=>f.req('/v1/skill-cycles/'+id);
 const tick=()=>advanceSkillCycles(f.db,f.env,f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id));
 const current=()=>f.db.db.prepare('SELECT s.*,t.attempt AS claim,t.thread_id FROM skill_cycle_steps s JOIN tasks t ON t.id=s.id WHERE cycle_id=? ORDER BY created_at DESC,s.id DESC LIMIT 1').get(id);
 async function done(phase,data,zip){
  const row=await get(),s=row.body.steps.find(x=>x.phase===phase&&x.attempt===row.body.attempt),n=s.node===f.master.id?f.master:f.worker;
  await f.poll(n,[],true);const task=(await f.req('/v1/tasks/'+s.id)).body;f.db.db.prepare('UPDATE tasks SET thread_id=? WHERE id=?').run(uid(),task.id);
  const ref=await f.output(n,task,task.spec.outputs[0],JSON.stringify({cycleId:id,passed:true,...data}));
  if(zip)await f.output(n,task,task.spec.outputs[1],zip);
  await f.finish(n,task);await f.poll(n,[],true);await tick();return ref;
 }
 return {...f,id,declaration,create,get,tick,current,done};
}

test('skill cycle enforces independent review, exact publication, both sync receipts and deterministic restart',async t=>{
 const f=await skillFixture(t);assert.equal((await f.create()).status,200);await f.tick();await f.tick();
 assert.equal((await f.get()).body.steps.length,1);
 const zip='candidate test bytes',candidateSha=hash(zip),treeSha='b'.repeat(40),commit='c'.repeat(40);
 const shared={candidateSha,treeSha,tests:{passed:true},changed:['fleet_validation/'+f.id+'/normalize.py']};
 await f.done('repair',{...shared,phase:'pack',reproduction:{passed:false}},zip);assert.equal((await f.get()).body.state,'review');await f.tick();
 await f.done('review',{...shared,phase:'review-check',decision:'pass',findings:'Independent code and regression fixture inspected; checks passed.'});assert.equal((await f.get()).body.state,'publish');await f.tick();
 f.env.SKILL_GITHUB_FETCH=async url=>({ok:true,json:async()=>url.includes('/git/ref/')?{object:{sha:commit}}:{tree:{sha:treeSha}}});
 await f.done('publish',{...shared,phase:'publish',commit,mode:'validation',branch:'fleet-repair/'+f.id});assert.equal((await f.get()).body.state,'canary');await f.tick();
 await f.done('canary',{phase:'sync',commit,treeSha,tests:{passed:true},directory:'D:/versions/'+commit,filesVerified:5,installedSkillsUntouched:true});assert.equal((await f.get()).body.state,'sync');await f.tick();
 await f.done('sync',{phase:'sync',commit,treeSha,tests:{passed:true},directory:'E:/versions/'+commit,filesVerified:5,installedSkillsUntouched:true});assert.equal((await f.get()).body.state,'completed');
 await f.tick();assert.equal((await f.get()).body.steps.length,5);assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_deployments').get().n,2);
});
test('skill cycle uncertain or paused phase never publishes or creates a second execution',async t=>{
 const f=await skillFixture(t);await f.create();await f.tick();const s=(await f.get()).body.steps[0];
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(s.id);await f.tick();await f.tick();assert.equal((await f.get()).body.steps.length,1);
 await f.post('/v1/skill-cycles/'+f.id+'/pause',{});await f.tick();assert.equal((await f.get()).body.state,'paused');
 f.db.db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(s.id);assert.equal((await f.poll(f.master)).body.tasks.length,0);
});

test('excluding a reviewer blocks already queued skill phases without touching running work',async t=>{
 const f=await skillFixture(t);await f.create();await f.tick();
 const zip='review scope fixture',shared={candidateSha:hash(zip),treeSha:'b'.repeat(40),tests:{passed:true},changed:['fleet_validation/'+f.id+'/normalize.py']};
 await f.done('repair',{...shared,phase:'pack',reproduction:{passed:false}},zip);await f.tick();
 f.db.db.prepare("UPDATE settings SET value=json_set(value,'$.excludedNodes',json(?)) WHERE key='delivery_controller'").run(JSON.stringify([f.worker.id]));
 assert.equal((await f.poll(f.worker)).body.tasks.length,0,'Exclusion applies at claim time');
 assert.equal((await f.get()).body.steps.find(x=>x.phase==='review').status,'queued');
 await f.post('/v1/skill-cycles/'+f.id+'/cancel',{});
 assert.equal((await f.get()).body.steps.find(x=>x.phase==='review').status,'cancelled');
});
test('failed independent review returns to an isolated candidate and cannot publish',async t=>{
 const f=await skillFixture(t);await f.create();await f.tick();const zip='candidate',shared={candidateSha:hash(zip),treeSha:'b'.repeat(40),tests:{passed:true},changed:['fleet_validation/'+f.id+'/normalize.py']};
 await f.done('repair',{...shared,phase:'pack',reproduction:{passed:false}},zip);await f.tick();
 await f.done('review',{...shared,phase:'review-check',passed:false,decision:'fail',findings:'Regression is insufficient; retain the existing installed skill.'});
 assert.equal((await f.get()).body.state,'repair');assert.equal((await f.get()).body.attempt,1);await f.tick();assert.equal((await f.get()).body.steps.filter(s=>s.phase==='publish').length,0);
});


test('known failed publication resumes the same frozen candidate; unknown execution does not retry',async t=>{
 const f=await skillFixture(t);await f.create();await f.tick();const zip='candidate',shared={candidateSha:hash(zip),treeSha:'b'.repeat(40),tests:{passed:true},changed:['fleet_validation/'+f.id+'/normalize.py']};
 await f.done('repair',{...shared,phase:'pack',reproduction:{passed:false}},zip);await f.tick();
 await f.done('review',{...shared,phase:'review-check',decision:'pass',findings:'Independent review checks frozen tests and exact candidate contents.'});await f.tick();
 const original=(await f.get()).body.steps.find(x=>x.phase==='publish');f.db.db.prepare("UPDATE tasks SET status='failed',result=? WHERE id=?").run(JSON.stringify({error:'TLS disconnected before tool execution'}),original.id);
 await f.tick();await f.tick();const retry=(await f.get()).body.steps.find(x=>x.phase==='publish');assert.notEqual(retry.id,original.id);assert.equal(retry.retries,1);
 const saved=f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(retry.id);assert.match(JSON.parse(saved.spec).prompt,/published.json/);
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(retry.id);await f.tick();assert.equal((await f.get()).body.steps.find(x=>x.phase==='publish').id,retry.id);
});
test('on-demand policy needs an enrolled controller and frozen helper, but creates no rehearsal or production work',async t=>{
 const f=await skillFixture(t);
 const policy={profile:'software',enabled:true,project:'workspace',reviewerNode:f.worker.id,helper:f.declaration.helper};
 assert.equal((await f.req('/v1/skill-release-policy',{method:'POST',data:policy,token:f.worker.token})).status,403);
 assert.notEqual((await f.post('/v1/skill-release-policy',{...policy,helper:{...policy.helper,sha:'0'.repeat(64)}})).status,200);
 assert.notEqual((await f.post('/v1/skill-release-policy',{...policy,reviewerNode:f.master.id})).status,200);
 assert.equal((await f.post('/v1/skill-release-policy',policy)).status,200);
 const beforeTasks=f.db.db.prepare('SELECT count(*) n FROM tasks').get().n;
 for(let i=0;i<4;i++){await f.tick();await advanceMaintenanceRequests(f.db,f.env,f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id));}
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_cycles').get().n,0);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_maintenance_requests').get().n,0);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,beforeTasks);
 const view=(await f.req('/v1/skill-maintenance',{token:null,identity:f.member('viewer')})).body;
 assert.deepEqual(view.policies,[{profile:'software',enabled:true,triggerMode:'on_demand'}]);
 assert.equal((await f.post('/v1/skill-cycles',{...f.declaration,mode:'production',allowedPaths:['SKILL.md'],tests:[{runtime:'python',path:'tests/check.py'}]})).status,400,'An enabled policy still requires a concrete production trigger');
 await f.create();
 assert.equal((await f.post('/v1/skill-cycles',{...f.declaration,id:'second-cycle',allowedPaths:['fleet_validation/second-cycle']})).status,409,'Only one maintenance owns a skill');
});

test('stopped or completed rehearsals never change production policy and cannot schedule maintenance',async t=>{
 const f=await skillFixture(t);await f.create();
 const policy={profile:'software',enabled:false,project:'workspace',reviewerNode:f.worker.id,helper:f.declaration.helper,activateAfterCycle:f.id};
 assert.equal((await f.post('/v1/skill-release-policy',policy)).status,409);
 assert.equal((await f.post('/v1/skill-release-policy',{...policy,activateAfterCycle:undefined,triggerMode:'periodic'})).status,409);
 // A stored legacy deferred activation must not restart a disabled policy.
 f.db.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('skill_release:software',JSON.stringify(policy));
 const current=()=>JSON.parse(f.db.db.prepare("SELECT value FROM settings WHERE key='skill_release:software'").get().value);
 f.db.db.prepare("UPDATE skill_cycles SET state='completed' WHERE id=?").run(f.id);
 await f.tick();assert.equal(current().enabled,false);
 assert.equal((await f.post('/v1/skill-release-policy',{...policy,activateAfterCycle:undefined,enabled:true})).status,200);
 await f.post('/v1/skill-cycles/'+f.id+'/cancel',{});await f.tick();
 assert.equal(current().enabled,true,'Cancelling a rehearsal does not disable real issue handling');
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_cycles').get().n,1);
});

class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
  async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const results=items.map(i=>{const r=this.db.prepare(i.sql).run(...i.args);return {results:[],meta:{changes:Number(r.changes)}};});this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class MemoryR2 {constructor(){this.objects=new Map();}async put(key,data){this.objects.set(key,Buffer.from(data));return {key};}async get(key,options){let b=this.objects.get(key);if(!b)return null;if(options?.range)b=b.subarray(options.range.offset,options.range.offset+options.range.length);return {body:new Response(b).body,size:b.length};}}

test('initial supplemental attachments reach production without becoming separate cases',async t=>{
 const f=await deliveryFixture(t),attachment=await f.upload('原材料.docx','supplemental notice');
 f.spec.supplemental={text:'按通知补充与实际系统一致的视频解说词',attachments:[attachment]};
 const task=await f.preflight();
 assert.equal((await f.get()).body.inputs.length,1);
 assert.ok(task.spec.inputs.some(x=>x.name==='supplemental/attachments/1/原材料.docx'&&x.sha===attachment.sha));
 assert.match(task.spec.prompt,/视频解说词/);
 assert.match(task.spec.prompt,/requirementsReview/);
 assert.equal((await f.create({...f.spec,supplemental:{text:'changed',attachments:[attachment]}})).status,409);
 assert.equal((await f.create({...f.spec,id:uid(),supplemental:{text:'explain',attachments:[{...attachment,sha:'0'.repeat(64)}]}})).status,404);
});

test('new supplemental delivery reports a missing local skill and freezes the actual configured release',async t=>{
 const f=await deliveryFixture(t),request={...f.spec,supplemental:{text:'按通知要求补充解释，同时保留正常研发材料。',attachments:[]}};
 f.db.db.prepare("UPDATE nodes SET capabilities=json_remove(capabilities,'$.skills') WHERE id=?").run(f.worker.id);
 const blocked=await f.create(request);assert.equal(blocked.status,409);assert.equal(blocked.body.code,'SUPPLEMENTAL_SKILL_REQUIRED');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 await f.poll(f.worker);const created=await f.create(request);assert.equal(created.status,200,JSON.stringify(created.body));assert.deepEqual(created.body.supplementalSkill,SUPPLEMENTAL_SKILL);
 f.db.db.prepare("UPDATE nodes SET capabilities=json_remove(capabilities,'$.skills') WHERE id=?").run(f.worker.id);
 assert.equal((await f.create(request)).status,200,'Unchanged retry recovers the frozen declaration after capability drift');
 assert.equal((await f.create({...request,id:uid(),mode:'probe'})).body.code,'SUPPLEMENTAL_PRODUCTION_REQUIRED');
});

test('a frozen 1.0 delivery retry retains its original pin, declaration hash and existing running task after the 1.1 default changes',async t=>{
 const f=await deliveryFixture(t),request={...f.spec,supplemental:{text:'历史已冻结的1.0补充要求',attachments:[]}};assert.equal((await f.create(request)).status,200);
 const initial=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),frozen=JSON.parse(initial.declaration);
 frozen.supplementalSkill={id:'supplemental-delivery',version:'1.0.0',repository:'zhoudebao6-art/software-system-delivery',path:'skills/supplemental-delivery',commit:'67bf813b4d3939497680ad0027832d7c698903ad'};
 f.db.db.prepare("UPDATE delivery_batches SET declaration=?,declaration_hash=?,baseline=?,status='producing' WHERE id=?").run(JSON.stringify(frozen),hash(canonical(frozen)),JSON.stringify(f.baseline),f.spec.id);
 const task={id:'frozen-task-'+uid(),targetNode:f.worker.id,project:'workspace',prompt:'原1.0任务的完整冻结提示词；不得替换入口或修改正在运行的任务。',mode:'execute',skills:['software-system-delivery','supplemental-delivery'],inputs:[],outputs:[],worktree:false};
 assert.equal((await f.post('/v1/tasks',task)).status,200);f.db.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
 f.db.db.prepare("INSERT INTO delivery_jobs(id,batch_id,phase,item_index,node,attempt,task_id,spec,created_at) VALUES(?,?,'produce',0,?,0,?,?,?)").run(uid(),f.spec.id,f.worker.id,task.id,JSON.stringify(task),now());
 const before=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),beforeTask=f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
 const retried=await f.create(request);assert.equal(retried.status,200,JSON.stringify(retried.body));assert.deepEqual(retried.body.supplementalSkill,frozen.supplementalSkill);assert.equal(retried.body.supplementalSkill.versionDirectoryHint,undefined);
 assert.deepEqual(f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),before);assert.deepEqual(f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),beforeTask);
 const newDeclaration=await f.create({...request,id:uid()});assert.equal(newDeclaration.status,200);assert.equal(newDeclaration.body.supplementalSkill.version,'1.1.0');assert.equal(newDeclaration.body.supplementalSkill.commit,'661b18140f4831c0d4db6f2e418cc88110e53d20');assert.ok(newDeclaration.body.supplementalSkill.versionDirectoryHint.includes(SUPPLEMENTAL_SKILL.commit));
});

test('historical supplement freezes exact verified version, is idempotent, and never mutates source',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight(),job=(await f.get()).body.jobs.find(x=>x.phase==='produce');
 const endpoint='/v1/deliveries/'+f.spec.id+'/supplements';
 const request={id:uid(),name:'历史补充说明',itemIndex:0,sourceTaskId:task.id,nodes:[f.worker.id],notes:'解释原视频各步骤对应的代码与界面',attachments:[],maxRepairs:2};
 assert.equal((await f.post(endpoint,request)).status,409,'Unverified output cannot be used');
 const zip=await f.output(f.worker,task,task.spec.outputs[1],'verified original ZIP');
 const r=f.receipt(task,{status:'published',inputSha:f.spec.inputs[0].sha,packageSha:zip.sha,skillInvoked:true,...f.evidence(),qualityChecks:{sourceFidelity:true,data:true,web:true,backend:true,video:true,sourcePackage:true}});
 const receipt=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(r));await f.finish(f.worker,task);
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:receipt.sha})).body.ok,true);
 await f.poll(f.worker,[],true);
 const original=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),oldTask=f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
 const created=await f.post(endpoint,request);assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal(created.body.supplementSource.taskId,task.id);assert.equal(created.body.supplementSource.artifacts.find(x=>x.name.endsWith('/delivery.zip')).sha,zip.sha);
 assert.equal(created.body.supplementSource.declarationHash,original.declaration_hash);
 assert.deepEqual(f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),original);
 assert.deepEqual(f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),oldTask);
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01' WHERE id=?").run(f.worker.id);
 assert.deepEqual((await f.post(endpoint,request)).body.supplementSource,created.body.supplementSource,'Readiness change does not break retry');
 assert.equal((await f.post(endpoint,{...request,notes:'different'})).status,409);
 assert.equal((await f.post(endpoint,{...request,id:uid(),sourceTaskId:uid()})).status,409);
 assert.equal((await f.post(endpoint,{...request,id:uid(),sourceDeclarationHash:'f'.repeat(64)})).status,409);
 const denied=f.node('unrelated',['other']);assert.equal((await f.post(endpoint,{...request,id:uid()},denied.token)).status,403);
 await f.poll(f.worker,[],true);
 const newAck=b=>f.post('/v1/deliveries/'+request.id+'/ack',b);
 assert.equal((await newAck({kind:'baseline',baseline:f.baseline})).status,200);
 await f.tick();f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='E:/supplement/project',root_key='e:/supplement/project' WHERE status!='ready'").run();await f.tick();
 const prep=(await f.poll(f.worker)).body.tasks.find(x=>x.spec.role==='delivery-preflight');assert.ok(prep);
 const ready=f.receipt(prep,{batchId:request.id,status:'ready',installedCommit:f.baseline.commit,filesVerified:1,manifestSha:f.baseline.manifest.sha,verifiedFiles:[{path:'SKILL.md',size:7,sha256:'b'.repeat(64)}],configPreserved:true});
 const readyRef=await f.output(f.worker,prep,prep.spec.outputs[0],JSON.stringify(ready));await f.finish(f.worker,prep);
 let state=(await f.req('/v1/deliveries/'+request.id)).body;
 assert.equal((await newAck({kind:'inspect',jobId:state.jobs[0].id,receiptSha:readyRef.sha})).body.ok,true);
 await f.tick();await f.poll(f.worker,[],true);await f.tick();const build=(await f.poll(f.worker)).body.tasks.find(x=>x.spec.role==='delivery-build');assert.ok(build);
 assert.ok(build.spec.inputs.some(x=>x.sha===zip.sha&&x.name.startsWith('supplemental/source/')));
 assert.match(build.spec.prompt,/不重做未要求的 Web/);
 const resultZip=await f.output(f.worker,build,build.spec.outputs[1],'supplemental explanation only');
 const reviewerId=uid(),sourceHash=created.body.supplementSource.sourceHash,artifact={path:'解说词.txt',sha256:'d'.repeat(64)};
 const publication=JSON.stringify({schema:'supplement-v1',status:'published',runId:'supplement-run',published:'E:/deliveries/new',sourceHash,snapshot:{[artifact.path]:artifact.sha256}});
 const report=JSON.stringify({schema:1,runId:'supplement-run',inputSha:f.spec.inputs[0].sha,items:[{id:'explanation',requirement:request.notes,source:'补充需求第1项',acceptance:'逐项对应原视频及实际代码',artifacts:[artifact]}],figures:[],review:{reviewerId,decision:'pass',checkedItems:['explanation'],checkedFigures:[],findings:'按原视频步骤核对代码与界面一致'}});
 const review='独立核对来源 '+sourceHash+' 需求报告 '+hash(report);
 const supplementalReceipt=f.receipt(build,{batchId:request.id,status:'published',inputSha:f.spec.inputs[0].sha,packageSha:resultZip.sha,skillInvoked:true,sourceHash,qualityChecks:{sourceFidelity:true},publishReceipt:{runId:'supplement-run',rawText:publication,sha256:hash(publication)},independentReview:{decision:'pass',reviewerId,rawText:review,evidenceSha256:hash(review)},requirementsReview:{rawText:report,sha256:hash(report)}});
 const newRef=await f.output(f.worker,build,build.spec.outputs[0],JSON.stringify(supplementalReceipt));await f.finish(f.worker,build);
 state=(await f.req('/v1/deliveries/'+request.id)).body;
 assert.equal((await newAck({kind:'inspect',jobId:state.jobs.find(x=>x.phase==='produce').id,receiptSha:newRef.sha})).body.ok,true,'Supplement-only scoped publication passes without invented Web/video checks');
 assert.equal(f.db.db.prepare('SELECT declaration_hash FROM delivery_batches WHERE id=?').get(f.spec.id).declaration_hash,original.declaration_hash);
 await f.poll(f.worker,[],true);
 const previous=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(request.id);
 const next={...request,id:uid(),name:'第二轮补充',sourceTaskId:build.id,notes:'根据原版系统和上轮解说词进一步解释算法'};
 const nextEndpoint='/v1/deliveries/'+request.id+'/supplements';
 const second=await f.post(nextEndpoint,next);assert.equal(second.status,200,JSON.stringify(second.body));
 const lineage=second.body.supplementSource.artifacts;
 assert.ok(lineage.some(x=>x.sha===zip.sha&&x.origins.some(o=>o.taskId===task.id)),'Original delivery remains available');
 assert.ok(lineage.some(x=>x.sha===resultZip.sha&&x.origins.some(o=>o.taskId===build.id)),'Previous supplement remains available');
 assert.deepEqual(f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(request.id),previous);
 const nextAck=b=>f.post('/v1/deliveries/'+next.id+'/ack',b);
 await nextAck({kind:'baseline',baseline:f.baseline});await f.tick();
 f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='E:/supplement/second',root_key='e:/supplement/second' WHERE status!='ready'").run();await f.tick();
 const prep2=(await f.poll(f.worker)).body.tasks.find(x=>x.spec.role==='delivery-preflight');assert.ok(prep2);
 const prep2Ref=await f.output(f.worker,prep2,prep2.spec.outputs[0],JSON.stringify({...ready,batchId:next.id}));await f.finish(f.worker,prep2);
 const nextState=(await f.req('/v1/deliveries/'+next.id)).body;
 assert.equal((await nextAck({kind:'inspect',jobId:nextState.jobs[0].id,receiptSha:prep2Ref.sha})).body.ok,true);
 await f.tick();await f.poll(f.worker,[],true);await f.tick();
 const build2=(await f.poll(f.worker)).body.tasks.find(x=>x.spec.role==='delivery-build');assert.ok(build2);
 for(const sha of [zip.sha,resultZip.sha])assert.ok(build2.spec.inputs.some(x=>x.sha===sha&&x.name.startsWith('supplemental/source/')),'Both generations are dispatched');
 assert.equal(f.db.db.prepare('SELECT declaration_hash FROM delivery_batches WHERE id=?').get(f.spec.id).declaration_hash,original.declaration_hash);
 assert.equal(f.db.db.prepare('SELECT declaration_hash FROM delivery_batches WHERE id=?').get(request.id).declaration_hash,previous.declaration_hash);
});
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const adminToken=secret(),env={DB:db,BUCKET:new MemoryR2(),FLEET_ADMIN_TOKEN:adminToken};
  function node(name,projects=['workspace'],capabilities={localExecutionPolicy:true,workspaceExecution:true},id=uid()){const token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities) VALUES(?,?,?,?,?,?,?)').run(id,name,hash(token),JSON.stringify(projects),name,now(),JSON.stringify(capabilities));return {id,token,projects,capabilities};}
  function member(role='operator'){const id=uid(),user='user-'+id,email=id+'@example.test';db.db.prepare('INSERT INTO members(id,user_id,email,role,created) VALUES(?,?,?,?,?)').run(id,user,email,role,now());db.db.prepare('UPDATE members SET group_access=? WHERE id=?').run(JSON.stringify({mode:'all',groupIds:[]}),id);return {'oai-authenticated-user-id':user,'oai-authenticated-user-email':email};}
  async function req(route,{method='GET',data,token=adminToken,identity,origin}={}) {
    const headers={...identity};if(token)headers.authorization='Bearer '+token;if(identity&&method!=='GET')headers.origin='https://fleet.example.test';if(origin)headers.origin=origin;
    if(data!==undefined)headers['content-type']=Buffer.isBuffer(data)?'application/octet-stream':'application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)}),env);return {status:r.status,body:(r.headers.get('content-type')||'').startsWith('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};
  }
  const spec=nodes=>({id:uid(),name:'开发、审查、汇总',project:'workspace',steps:nodes.map((n,i)=>({key:'step-'+i,name:['开发','审查','汇总'][i]||'步骤 '+i,targetNode:n.id,prompt:'Complete step '+i,mode:'execute',skills:[],outputs:[],worktree:false}))});
  const create=(spec,options={})=>req('/v1/automations',{method:'POST',data:spec,...options});
  const get=id=>req('/v1/automations/'+id);
  const action=(id,action,options={})=>req('/v1/automations/'+id+'/'+action,{method:'POST',data:{},...options});
  const poll=(n,events=[],ready=true)=>req('/v1/sync',{method:'POST',token:n.token,data:{events,capabilities:{...n.capabilities,ready,projects:n.projects}}});
  const finish=(n,task,status='submitted',summary='Task complete')=>poll(n,[{id:uid(),type:'finished',taskId:task.id,attemptId:task.attempt,status,result:{summary}}],false);
  async function output(n,task,name,bytes){const data=Buffer.from(bytes),sha=hash(data),url='/v1/artifacts/'+sha+'?task='+task.id;assert.equal((await req(url,{method:'POST',token:n.token,data:{name,size:data.length}})).status,200);assert.equal((await req(url+'&offset=0',{method:'PUT',token:n.token,data})).body.complete,true);return {name,sha,size:data.length};}
  return {db,env,adminToken,node,member,req,spec,create,get,action,poll,finish,output};
}

async function deliveryFixture(t,{identity,masterId}={}){
 const f=fixture(t),caps={ready:true,parallelExecution:true,desktopSessionBridge:true,conversationDispatch:true,localExecutionPolicy:true,workspaceExecution:true,skills:['supplemental-delivery']};
 const master=f.node('PC-01',undefined,caps,masterId),worker=f.node('PC-03',undefined,caps),excluded=f.node('PC-02',undefined,caps);
 const post=(route,data,token=master.token)=>f.req(route,{method:'POST',data,token});
 assert.equal((await post('/v1/delivery/settings',{controller:master.id,excludedNodes:[excluded.id]},f.adminToken)).status,200);
 async function upload(name,bytes){bytes=Buffer.from(typeof bytes==='string'?bytes:JSON.stringify(bytes));const sha=hash(bytes),project='workspace',url='/v1/files/'+sha+'?project='+project;
  assert.equal((await post('/v1/files',{id:uid(),name,project,sha,size:bytes.length})).status,200);
  assert.equal((await f.req(url+'&offset=0',{method:'PUT',data:bytes,token:master.token})).status,200);
  return {name,sha,size:bytes.length};
 }
 const input=await upload('原材料.docx','original input');
 const spec={id:'batch-'+uid(),name:'两套自动化验收',project:'workspace',profile:'software',mode:'production',nodes:[worker.id],inputs:[input],notes:'独立交付',requirements:[],maxRepairs:2};
 const create=s=>post('/v1/deliveries',s);
 const get=()=>f.req('/v1/deliveries/'+spec.id);
 const tick=()=>post('/v1/delivery/tick',{});
 const ack=b=>post('/v1/deliveries/'+spec.id+'/ack',b);
 const pack=await upload('package.zip','fixed source'),files=[{path:'SKILL.md',size:7,gitBlob:'a'.repeat(40),sha256:'b'.repeat(64)}];
 const manifest=await upload('manifest.json',{repository:'zhoudebao6-art/software-system-delivery',commit:'c'.repeat(40),archiveVerified:true,archiveSha256:pack.sha,files});
 const baseline={repository:'zhoudebao6-art/software-system-delivery',commit:'c'.repeat(40),checkedAt:now(),package:pack,manifest};
 const ready=async()=>{
  assert.equal((await create(spec)).status,200);
  assert.equal((await ack({kind:'baseline',baseline})).status,200);
  await tick();f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='D:/isolated/project',root_key='d:/isolated/project'").run();
  await tick();const task=(await f.poll(worker)).body.tasks[0];assert.ok(task,'Preflight claimed');
  return task;
 };
 const receipt=(task,fields)=>{
  const extra={};if(task.spec.skills.includes('supplemental-delivery')){
   extra.supplementalSkill={id:SUPPLEMENTAL_SKILL.id,commit:SUPPLEMENTAL_SKILL.commit,entryPath:`E:/研发自动化/${SUPPLEMENTAL_SKILL.versionDirectoryHint}/SKILL.md`,verified:true,invoked:true};
   if(fields.packageSha){const ids=JSON.parse(fields.requirementsReview?.rawText||'{"items":[]}').items.map(x=>x.id),rawText=JSON.stringify({schema_version:1,tool:{name:'pack_feedback'},case_id:fields.batchId||spec.id,version:fields.publishReceipt?.runId,parent_version:fields.sourceHash||fields.publishReceipt?.runId,main_skill:'software-system-delivery',output_zip:{sha256:fields.packageSha},validation_scope:{file_hashes_verified:true,zip_members_verified:true},requirements:ids.map(id=>({id,members:['补充材料/说明.txt']})),files:[{kind:'normal',arcname:'normal/delivery.zip',sha256:'a'.repeat(64),requirement_ids:[]},{kind:'supplemental',arcname:'补充材料/说明.txt',sha256:'b'.repeat(64),requirement_ids:ids}]});extra.feedbackPack={rawText,sha256:hash(rawText)};}
  }
  return {schema:1,batchId:spec.id,profile:spec.profile,mode:spec.mode,commit:baseline.commit,itemIndex:0,attempt:0,skill:'software-system-delivery',...extra,...fields};
 };
 const evidence=()=>{const publication=JSON.stringify({schema_version:1,run_id:'actual-run',published:'D:/published/example',snapshot:{'系统材料/源代码.zip':'a'.repeat(64)},finalize_sha256:'b'.repeat(64)}),review='Independent reviewer fixture report: PASS';
  return {publishReceipt:{sha256:hash(publication),runId:'actual-run',rawText:publication},independentReview:{decision:'pass',reviewerId:uid(),evidenceSha256:hash(review),rawText:review}};};
 async function preflight(){
  const task=await ready();
  const r=receipt(task,{status:'ready',installedCommit:baseline.commit,filesVerified:files.length,manifestSha:manifest.sha,verifiedFiles:files.map(({path,size,sha256})=>({path,size,sha256})),configPreserved:true});
  const ref=await f.output(worker,task,task.spec.outputs[0],JSON.stringify(r));await f.finish(worker,task);
  const job=(await get()).body.jobs[0];assert.equal((await ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).body.ok,true);
  assert.equal((await f.req('/v1/tasks/'+task.id)).body.status,'accepted','Verified preflight does not require a human confirmation');
  await tick();await f.poll(worker,[],true);await tick();const production=(await f.poll(worker)).body.tasks.find(t=>t.spec.role==='delivery-build');assert.ok(production,'Production claimed');return production;
 }
 return {...f,master,worker,excluded,post,upload,spec,create,get,tick,ack,baseline,ready,receipt,preflight,evidence};
}

async function localControllerFixture(t){
 const f=await deliveryFixture(t),threadId=uid(),workspaceId=uid(),ts=now();
 f.worker.capabilities.desktopContinuation=true;
 f.worker.capabilities.skills=['software-system-delivery'];
 f.worker.capabilities.conversationReady=true;
 f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(f.worker.capabilities),f.worker.id);
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','原自动化总控','D:/automation',?,?,?)").run(f.worker.id,threadId,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','现有自动化','D:/automation','d:/automation','registered','ready',?,'hash',?,?)").run(workspaceId,f.worker.id,f.master.id,ts,ts);
 const binding={nodeId:f.worker.id,profile:'software',workspaceId,threadId};
 const configure=(changes={})=>f.post('/v1/delivery/settings',{controller:f.master.id,excludedNodes:[f.excluded.id],dispatchMode:'local-controller',localControllers:[binding],...changes},f.adminToken);
 assert.equal((await configure()).status,200);
 const launch=async()=>{
  assert.equal((await f.create(f.spec)).status,200);
  assert.equal((await f.ack({kind:'baseline',baseline:f.baseline})).status,200);
  await f.tick();
  return f.db.db.prepare('SELECT * FROM delivery_handoffs WHERE batch_id=?').get(f.spec.id);
 };
 return {...f,threadId,workspaceId,binding,configure,launch};
}

async function regionalFixture(t){
 const f=await localControllerFixture(t),regional=f.node('PC-05',undefined,{...f.worker.capabilities}),groupId='remote-group',ts=now(),threadId=uid(),workspaceId=uid();
 f.db.db.prepare('INSERT INTO device_groups(id,name,sort_order,created_at,updated_at) VALUES(?,?,0,?,?)').run(groupId,'异地设备',ts,ts);
 f.db.db.prepare('UPDATE nodes SET display_group_id=? WHERE id IN(?,?)').run(groupId,f.worker.id,regional.id);
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','异地原总控','D:/regional',?,?,?)").run(regional.id,threadId,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','区域协调','D:/regional','d:/regional','registered','ready',?,'hash',?,?)").run(workspaceId,regional.id,f.master.id,ts,ts);
 const regionalBinding={nodeId:regional.id,profile:'software',workspaceId,threadId},regions=[{nodeId:regional.id,groupIds:[groupId],profiles:['software']}];
 const configure=(changes={})=>f.configure({localControllers:[f.binding,regionalBinding],regionalControllers:regions,...changes});
 assert.equal((await configure()).status,200);
 return {...f,regional,regions,regionalBinding,groupId,configure};
}
test('regional controller dispatches only the exact delegated child and group changes revoke new claims',async t=>{
 const f=await regionalFixture(t),h=await f.launch(),task=f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(h.task_id);
 assert.equal(task.target,f.regional.id);assert.equal(JSON.parse(task.spec).desktopThreadId,f.regionalBinding.threadId);
 const spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 assert.equal(spec.targetNode,f.worker.id);
 assert.equal((await f.post('/v1/tasks',{...spec,prompt:spec.prompt+'wrong'},f.regional.token)).status,409);
 assert.equal((await f.post('/v1/tasks',spec,f.excluded.token)).status,403);
 assert.equal((await f.post('/v1/tasks',spec,f.regional.token)).status,200);
 assert.equal((await f.post('/v1/tasks',spec,f.regional.token)).status,200);
 assert.equal((await f.post('/v1/delivery/tick',{},f.regional.token)).body.enabled,false,'Regional role is not global controller');
 f.db.db.prepare('UPDATE nodes SET display_group_id=NULL WHERE id=?').run(f.worker.id);
 assert.equal((await f.poll(f.worker)).body.tasks.length,0,'Current group revokes unclaimed delegation');
 f.db.db.prepare('UPDATE nodes SET display_group_id=? WHERE id=?').run(f.groupId,f.worker.id);
 assert.equal((await f.poll(f.worker)).body.tasks.filter(t=>t.id===spec.id).length,1);
});
test('regional unavailability before any message preserves one global fallback, unknown sends never duplicate',async t=>{
 const f=await regionalFixture(t);await f.create(f.spec);
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01T00:00:00Z' WHERE id=?").run(f.regional.id);
 await f.ack({kind:'baseline',baseline:f.baseline});await f.tick();await f.tick();
 const jobs=f.db.db.prepare('SELECT j.task_id,t.creator FROM delivery_jobs j JOIN tasks t ON t.id=j.task_id').all();
 assert.equal(jobs.length,1);assert.equal(jobs[0].creator,f.master.id);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_handoffs').get().n,0);
 const g=await regionalFixture(t),h=await g.launch();
 g.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(h.task_id);
 await g.tick();await g.tick();
 assert.equal(g.db.db.prepare('SELECT count(*) n FROM delivery_dispatch_fallbacks').get().n,0);
 assert.equal(g.db.db.prepare('SELECT count(*) n FROM delivery_handoffs').get().n,1);
});
test('regional roles reject overlapping groups and main controller promotion, pending devices expose real gaps',async t=>{
 const f=await regionalFixture(t);
 assert.equal((await f.configure({regionalControllers:[...f.regions,{nodeId:f.excluded.id,groupIds:[f.groupId],profiles:['software']}]})).status,400);
 assert.equal((await f.configure({regionalControllers:[{nodeId:f.master.id,groupIds:[f.groupId],profiles:['software']}]})).status,400);
 f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify({ready:true,parallelExecution:true,conversationDispatch:false,desktopSessionBridge:false,skills:['codex-fleet']}),f.regional.id);
 const d=(await f.req('/v1/delivery/integration')).body.devices.find(d=>d.nodeId===f.regional.id);
 assert.equal(d.role,'regional');assert.equal(d.ready,false);assert.equal(d.state,'partial');
 assert.ok(d.gaps.some(g=>g.includes('桌面联动')));assert.ok(d.gaps.some(g=>g.includes('缺少技能')));
 assert.ok(d.managedDevices.some(n=>n.nodeId===f.worker.id));
});
test('cancelled assessment stops its maintenance request without scheduling a replacement',async t=>{
 const f=await skillFixture(t);await f.post('/v1/skill-maintenance',{id:'cancelled-assessment',profile:'software',project:'workspace',trigger:'requirement_change',description:'需要核实当前自动化交付的质量问题。',expected:'保证实际质量检查通过，失败时保留调查证据。'});
 const actor=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id);await advanceMaintenanceRequests(f.db,f.env,actor);
 f.db.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=(SELECT task_id FROM skill_maintenance_requests WHERE id='cancelled-assessment')").run();
 await advanceMaintenanceRequests(f.db,f.env,actor);await advanceMaintenanceRequests(f.db,f.env,actor);
 assert.equal(f.db.db.prepare("SELECT state FROM skill_maintenance_requests WHERE id='cancelled-assessment'").get().state,'cancelled');
});
test('deleting a regional group removes its assignment without changing active tasks',async t=>{
 const f=await regionalFixture(t),h=await f.launch();
 const before=f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(h.task_id).status;
 const r=await f.req('/v1/device-groups/'+f.groupId,{method:'DELETE',data:{}});assert.equal(r.status,200);
 const cfg=(await f.req('/v1/delivery/settings')).body.settings;assert.deepEqual(cfg.regionalControllers,[]);
 assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(h.task_id).status,before);
});

async function loopFixture(t){
 const f=await deliveryFixture(t),threadId=uid(),workspaceId=uid(),ts=now();
 Object.assign(f.master.capabilities,{desktopContinuation:true,conversationReady:true});
 f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(f.master.capabilities),f.master.id);
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','原主控','D:/master',?,?,?)").run(f.master.id,threadId,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','主控环境','D:/master','d:/master','registered','ready',?,'hash',?,?)").run(workspaceId,f.master.id,f.master.id,ts,ts);
 const settings={controller:f.master.id,excludedNodes:[f.excluded.id],allowControllerWork:true,localControllers:[{nodeId:f.master.id,profile:'software',workspaceId,threadId}]};
 assert.equal((await f.post('/v1/delivery/settings',settings,f.adminToken)).status,200);
 return {...f,threadId};
}
test('same-skill scheduler distributes capacity, reserves pending jobs and skips offline devices',async t=>{
 const f=await loopFixture(t);
 f.spec.nodes=[f.master.id,f.worker.id];
 for(let i=1;i<6;i++)f.spec.inputs.push(await f.upload(`material-${i}.txt`,'input '+i));
 await f.create(f.spec);await f.ack({kind:'baseline',baseline:f.baseline});
 f.db.db.prepare("UPDATE delivery_batches SET status='producing'").run();
 for(let i=0;i<4;i++){await f.tick();f.db.db.prepare("UPDATE project_workspaces SET status='ready',root=coalesce(root,'D:/work'),root_key=coalesce(root_key,'d:/work')").run();}
 const tasks=f.db.db.prepare("SELECT node,count(*) n FROM delivery_jobs WHERE phase='produce' GROUP BY node").all();
 assert.deepEqual(tasks.map(x=>x.n),[2,2],'Per-device bound also counts reserved work');
 assert.equal((await f.get()).body.jobs.length,4,'Does not flood all six items into a FIFO queue');
 f.db.db.prepare("UPDATE tasks SET status='accepted' WHERE target=? AND json_extract(spec,'$.role')='delivery-build'").run(f.worker.id);
 const row=f.db.db.prepare('SELECT * FROM delivery_batches').get();
 assert.equal(await chooseDeliveryNode(f.db,row),f.worker.id);
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01T00:00:00Z' WHERE id=?").run(f.worker.id);
 assert.equal(await chooseDeliveryNode(f.db,row),null,'Unavailable node cannot receive work and busy node is not overloaded');
});
test('same-skill capacity includes fresh local desktop business but ignores stale activity labels',async t=>{
 const f=await loopFixture(t);f.spec.nodes=[f.master.id,f.worker.id];
 await f.create(f.spec);
 const row=f.db.db.prepare('SELECT * FROM delivery_batches').get(),ts=now();
 for(let i=0;i<4;i++)f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,status,status_source,updated_at,observed_at,received_at) VALUES(?,?,'workspace','本地业务','D:/master','running','app_server_runtime',?,?,?)").run(f.master.id,uid(),ts,ts,ts);
 assert.equal(await chooseDeliveryNode(f.db,row),f.worker.id,'Existing local business consumes execution capacity');
 f.db.db.prepare("UPDATE desktop_threads SET observed_at='2000-01-01' WHERE status='running'").run();
 assert.equal(await chooseDeliveryNode(f.db,row),f.master.id,'Old running labels are not live capacity evidence');
});
test('uncertain item is isolated, master gets one original-thread diagnosis, recovery cannot duplicate it',async t=>{
 const f=await loopFixture(t);f.spec.inputs.push(await f.upload('second.txt','second material'));
 const task=await f.preflight();
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(task.id);
 await f.tick();await f.tick();
 let state=(await f.get()).body;
 assert.equal(state.status,'producing');
 assert.equal(state.jobs.filter(j=>j.phase==='produce').length,2,'Other material is retained');
 assert.equal(state.loop.issues.length,1);
 const issue=state.loop.issues[0],diagnosis=(await f.req('/v1/tasks/'+issue.taskId)).body;
 assert.equal(diagnosis.spec.desktopThreadId,f.threadId);
 const report={issueId:issue.id,action:'retry',note:'Confirmed diagnosis with specific evidence'};
 assert.equal((await f.post(`/v1/deliveries/${f.spec.id}/recovery`,report)).status,409,'Uncertain is not terminal');
 assert.equal((await f.post(`/v1/deliveries/${f.spec.id}/recovery`,{...report,action:'observe'},f.worker.token)).status,403,'Only master reports');
 assert.equal((await f.post(`/v1/deliveries/${f.spec.id}/recovery`,{...report,action:'observe'})).status,200);
 f.db.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
 await f.tick();state=(await f.get()).body;
 assert.equal(state.loop.issues[0].state,'resolved','Original execution recovered, no replacement was created');
 assert.equal(state.jobs.filter(j=>j.phase==='produce'&&j.itemIndex===0).length,1);
});
test('invalid receipts stay unaccepted while master resolves only terminal jobs with bounded retries',async t=>{
 const f=await loopFixture(t),task=await f.preflight();
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(f.receipt(task,{status:'blocked',error:'Missing required material definition'})));
 await f.output(f.worker,task,task.spec.outputs[1],'diagnostic zip fixture');
 await f.finish(f.worker,task);
 const job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
 await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha});await f.tick();
 let b=(await f.get()).body;const issue=b.loop.issues[0];
 assert.equal(b.status,'producing');assert.equal(b.jobs.find(j=>j.id===job.id).status,'failed');
 assert.equal(b.jobs.filter(j=>j.phase==='produce').length,1,'No blind retry for blocked/fabricated receipt');
 const report={issueId:issue.id,action:'retry',note:'Material definition supplied in original project, verified read-only',learning:'Record candidate and regression evidence separately; do not claim a published skill'};
 assert.equal((await f.post(`/v1/deliveries/${f.spec.id}/recovery`,report)).status,200);
 await f.poll(f.worker,[],true);await f.tick();await f.tick();
 b=(await f.get()).body;assert.equal(b.jobs.filter(j=>j.phase==='produce').length,2);
 assert.equal((await f.post(`/v1/deliveries/${f.spec.id}/recovery`,report)).status,200,'Same report cannot repeat execution');
 assert.equal(b.loop.issues[0].state,'resolved');
 assert.equal(b.loop.issues[0].report.learning,report.learning);
});
test('native application relay is limited to explicit pre-send lock refusal, deduplicated and pause guarded',async t=>{
 const f=await loopFixture(t);await f.preflight();
 const row=f.db.db.prepare('SELECT * FROM delivery_batches').get(),route=JSON.parse(row.loop_policy).master;
 const actor=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.master.id),id='handoff-lock-'+uid();
 await continueDesktop(f.db,actor,f.master.id,route.threadId,{id,prompt:'Authorized bounded original-controller message'});
 const result={desktop:{reason:'NATIVE_CONTINUATION_BUSY',state:'busy'}};
 f.db.db.prepare("UPDATE tasks SET status='uncertain',result=? WHERE id=?").run(JSON.stringify(result),id);
 assert.equal(await relayOriginalMessage(f.db,actor,row,route,id),null,'Unknown sends cannot use another transport');
 f.db.db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(id);
 const relay=await relayOriginalMessage(f.db,actor,row,route,id);
 assert.ok(relay);assert.equal(await relayOriginalMessage(f.db,actor,row,route,id),relay);
 const task=f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(relay);
 assert.equal(JSON.parse(task.spec).workspaceId,route.workspaceId);
 assert.match(JSON.parse(task.spec).prompt,/send_message_to_thread/);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_relays').get().n,1);
 await f.post(`/v1/deliveries/${f.spec.id}/pause`,{},f.adminToken);
 assert.equal((await f.poll(f.master)).body.tasks.length,0,'Paused batch cannot claim queued relay');
});

test('local controller receives an original-thread message; delivery-only completion cannot complete a case',async t=>{
 const f=await localControllerFixture(t),h=await f.launch();
 assert.ok(h);assert.equal(h.thread_id,f.threadId);
 const planned=f.db.db.prepare('SELECT * FROM delivery_jobs WHERE batch_id=?').get(f.spec.id),spec=JSON.parse(planned.spec);
 assert.equal(spec.workspaceId,f.workspaceId);assert.equal(spec.parentId,h.id);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM project_workspaces').get().n,1,'No duplicate automation environment');
 assert.equal(f.db.db.prepare('SELECT id FROM tasks WHERE id=?').get(spec.id),undefined,'Global controller does not bypass the local controller');
 const message=(await f.poll(f.worker)).body.tasks[0];
 assert.equal(message.spec.desktopThreadId,f.threadId);
 await f.finish(f.worker,message,'submitted','Message appended to the active original conversation');
 await f.tick();await f.tick();
 assert.equal((await f.get()).body.status,'preflight');
 assert.equal((await f.get()).body.controllers[0].state,'message_received');
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_handoffs').get().n,1,'No duplicate send after a delivered message');
 assert.equal((await f.post('/v1/tasks',spec,f.master.token)).status,403,'Only target local controller submits');
 assert.equal((await f.post('/v1/tasks',{...spec,prompt:spec.prompt+' changed'},f.worker.token)).status,409);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,200);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,200,'Same local submission is idempotent');
 assert.equal((await f.get()).body.controllers[0].state,'delegated');
});

test('local controller child artifacts still require the original verified receipt and global collection',async t=>{
 const f=await localControllerFixture(t);await f.launch();
 const message=(await f.poll(f.worker)).body.tasks[0];await f.finish(f.worker,message);
 const spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,200);
 const task=(await f.poll(f.worker)).body.tasks.find(x=>x.id===spec.id);assert.ok(task);
 const receipt=f.receipt(task,{status:'ready',installedCommit:f.baseline.commit,filesVerified:1,manifestSha:f.baseline.manifest.sha,verifiedFiles:[{path:'SKILL.md',sha256:'b'.repeat(64),size:7}],configPreserved:true});
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(receipt));await f.finish(f.worker,task);
 const job=f.db.db.prepare('SELECT id FROM delivery_jobs').get();
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).body.passed,undefined);
 assert.equal((await f.req('/v1/tasks/'+task.id)).body.status,'accepted','Global controller can accept only its verified delegated artifact');
 await f.poll(f.worker,[],true);await f.tick();await f.tick();
 const jobs=(await f.get()).body.jobs;
 assert.equal(jobs.filter(j=>j.phase==='produce').length,1);
 assert.equal(jobs.find(j=>j.phase==='produce').status,'planned','Production is assigned by local controller, not the website');
 assert.equal((await f.get()).body.status,'producing');
});

test('pause and cancel block queued controller messages and undelegated jobs without interrupting the original conversation',async t=>{
 const f=await localControllerFixture(t),h=await f.launch(),spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 await f.post('/v1/deliveries/'+f.spec.id+'/pause',{},f.adminToken);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,409);
 assert.equal((await f.poll(f.worker)).body.tasks.length,0);
 await f.post('/v1/deliveries/'+f.spec.id+'/resume',{},f.adminToken);
 const message=(await f.poll(f.worker)).body.tasks[0];assert.equal(message.id,h.id);
 await f.post('/v1/deliveries/'+f.spec.id+'/cancel',{},f.adminToken);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,409);
 assert.equal((await f.req('/v1/tasks/'+message.id)).body.status,'claimed','Cancelling a batch must not interrupt unrelated original-thread work');
});

test('controller binding validates host, original project and archive state and is frozen per batch',async t=>{
 const f=await localControllerFixture(t);
 assert.equal((await f.configure({localControllers:[{...f.binding,nodeId:f.master.id}]})).status,409);
 f.db.db.prepare('UPDATE desktop_threads SET archived=1').run();
 assert.equal((await f.create(f.spec)).status,409);
 f.db.db.prepare('UPDATE desktop_threads SET archived=0').run();
 assert.equal((await f.create(f.spec)).status,200);
 assert.equal((await f.configure({localControllers:[]})).status,200);
 assert.equal((await f.create({...f.spec,id:uid()})).status,409,'Missing binding must not silently create an independent worker');
 assert.equal((await f.create(f.spec)).body.controllers[0].threadId,f.threadId,'Retry preserves original binding');
});

test('acknowledged handoffs dispatch the same fixed child without manual continuation; delayed local outbox is idempotent',async t=>{
 const f=await localControllerFixture(t),h=await f.launch(),message=(await f.poll(f.worker)).body.tasks[0];
 await f.finish(f.worker,message);f.db.db.prepare('UPDATE tasks SET updated=? WHERE id=?').run('2000-01-01',h.task_id);
 await f.tick();await f.tick();
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_handoffs').get().n,1);
 const j=f.db.db.prepare('SELECT * FROM delivery_jobs').get();
 assert.ok(f.db.db.prepare('SELECT id FROM tasks WHERE id=?').get(j.task_id));
 assert.equal((await f.post('/v1/tasks',JSON.parse(j.spec),f.worker.token)).status,200);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks WHERE id=?').get(j.task_id).n,1);
});
test('busy before send can recover dispatch but uncertain sends cannot',async t=>{
 for(const state of ['blocked','uncertain']){
  const f=await localControllerFixture(t),h=await f.launch();
  f.db.db.prepare('UPDATE tasks SET status=?,result=? WHERE id=?').run(state,JSON.stringify({desktop:{reason:'NATIVE_CONTINUATION_BUSY',state:'busy'}}),h.task_id);
  await f.tick();await f.tick();const j=f.db.db.prepare('SELECT * FROM delivery_jobs').get();
  assert.equal(!!f.db.db.prepare('SELECT id FROM tasks WHERE id=?').get(j.task_id),state==='blocked');
 }
});

test('master binding requires real completion in the exact original conversation, not delivery-only acknowledgement',async t=>{
 const f=await localControllerFixture(t),h=await f.launch(),message=(await f.poll(f.worker)).body.tasks[0];
 await f.configure({localControllers:[]});
 const request={...f.binding,probeTaskId:message.id},url='/v1/delivery/integration/bind';
 assert.equal((await f.post(url,request,f.worker.token)).status,403);
 await f.poll(f.worker,[{id:uid(),type:'finished',taskId:message.id,attemptId:message.attempt,status:'submitted',threadId:f.threadId,result:{deliveryOnly:true,desktop:{sameThread:true,state:'steered'}}}],false);
 assert.equal((await f.post(url,request)).status,409);
 f.db.db.prepare("UPDATE tasks SET result=? WHERE id=?").run(JSON.stringify({desktop:{sameThread:true,state:'continued'}}),message.id);
 assert.equal((await f.post(url,request)).status,200);
 assert.equal((await f.post(url,request)).status,200,'Repeated binding is safe');
 assert.equal((await f.req('/v1/delivery/integration')).body.devices.find(d=>d.nodeId===f.worker.id).state,'configured');
});

test('new capable device is assessed once by the existing master; excluded devices stay untouched',async t=>{
 const f=await localControllerFixture(t),masterThread=uid(),masterWorkspace=uid(),ts=now();
 f.master.capabilities.desktopContinuation=true;f.master.capabilities.conversationReady=true;
 f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(f.master.capabilities),f.master.id);
 f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,cwd,updated_at,observed_at,received_at) VALUES(?,?,'workspace','主控原对话','D:/master',?,?,?)").run(f.master.id,masterThread,ts,ts,ts);
 f.db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace','主控','D:/master','d:/master','registered','ready',?,'hash',?,?)").run(masterWorkspace,f.master.id,f.master.id,ts,ts);
 await f.configure({autoDiscover:true,localControllers:[{nodeId:f.master.id,profile:'auto20',workspaceId:masterWorkspace,threadId:masterThread}]});
 for(const n of [f.worker,f.excluded]){
  n.capabilities.skills=[{project:'workspace',names:['software-case-batch-pro']}];
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(n.capabilities),n.id);
 }
 await f.tick();await f.tick();
 const tasks=f.db.db.prepare("SELECT * FROM tasks WHERE id LIKE 'integration-%'").all();assert.equal(tasks.length,1);
 const task=JSON.parse(tasks[0].spec);assert.equal(task.desktopThreadId,masterThread);assert.equal(task.targetNode,f.master.id);
 assert.match(task.prompt,new RegExp(f.worker.id));assert.ok(!task.prompt.includes(f.excluded.id));
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_jobs').get().n,0,'Discovery does not start production');
});

test('new source-led batches require a professional requirement review without changing legacy batches',async t=>{
 const f=await deliveryFixture(t);f.spec.requirementsMode='source-led-v1';f.spec.notes='按材料需求分析力学响应，图件参照专业报告规范';
 const task=await f.preflight(),job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
 assert.match(task.spec.prompt,/不限模型图、仿真图/);assert.match(task.spec.prompt,/requirementsReview/);
 const zip=await f.output(f.worker,task,task.spec.outputs[1],'package fixture');
 const receipt=f.receipt(task,{status:'published',inputSha:f.spec.inputs[0].sha,packageSha:zip.sha,skillInvoked:true,...f.evidence(),qualityChecks:{sourceFidelity:true,data:true,web:true,backend:true,video:true,sourcePackage:true}});
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(receipt));await f.finish(f.worker,task);
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).body.passed,false,'File existence alone cannot satisfy the new requirement contract');
 assert.equal((await f.get()).body.status,'needs_attention');
 assert.equal((await f.create({...f.spec,requirementsMode:undefined})).status,409,'An existing batch cannot silently downgrade its frozen criteria');
});
test('structured optional evidence is hashed and verified, and receipt recheck does not repeat production',async t=>{
 const f=await deliveryFixture(t);f.spec.requirements=['model'];
 const task=await f.preflight(),path='附加交付/model.svg',modelSha='d'.repeat(64);
 const pack=await f.output(f.worker,task,task.spec.outputs[1],'verified ZIP fixture');
 const rawText=JSON.stringify({status:'passed',run_id:'actual-run',checks:[{name:'source mapping',passed:true}],artifacts:{[path]:modelSha}});
 const receipt=f.receipt(task,{status:'published',inputSha:f.spec.inputs[0].sha,packageSha:pack.sha,skillInvoked:true,...f.evidence(),qualityChecks:{sourceFidelity:true,data:true,web:true,backend:true,video:true,sourcePackage:true},
  requirementsEvidence:[{type:'model',path,sha256:modelSha,sourceMapping:[{source_sha256:f.spec.inputs[0].sha,location:'P12',definition:'source module'}],validation:{rawText,sha256:hash(rawText)}}]});
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(receipt));await f.finish(f.worker,task);
 const job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
 f.db.db.prepare("UPDATE delivery_batches SET status='needs_attention',error='Old receipt parser' WHERE id=?").run(f.spec.id);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/recheck',{},f.adminToken)).status,200);
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).status,200);
 assert.equal((await f.req('/v1/tasks/'+task.id)).body.status,'accepted');
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE phase='produce'").get().n,1);
});
test('only configured controller advances deliveries; excluded workers and controller production are denied',async t=>{
 const f=await deliveryFixture(t);
 assert.equal((await f.create({...f.spec,nodes:[f.excluded.id]})).status,409);
 assert.equal((await f.create({...f.spec,nodes:[f.master.id]})).status,409);
 assert.equal((await f.create(f.spec)).status,200);
 assert.equal((await f.post('/v1/delivery/tick',{},f.worker.token)).body.enabled,false);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/ack',{kind:'baseline',baseline:f.baseline},f.worker.token)).status,403);
 assert.equal((await f.tick()).body.operations[0].kind,'baseline');
 f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run('2000-01-01',f.worker.id);
 assert.equal((await f.create(f.spec)).status,200,'Lost response recovers old identity while offline');
 assert.equal((await f.create({...f.spec,name:'different'})).status,409);
 assert.equal((await f.create({...f.spec,id:uid()})).status,409);
});
test('real production receipt collects exact outputs and survives repeated ticks and acknowledgements',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight(),job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
 const zip=await f.output(f.worker,task,task.spec.outputs[1],'real package bytes');
 const r=f.receipt(task,{status:'published',inputSha:f.spec.inputs[0].sha,packageSha:zip.sha,skillInvoked:true,...f.evidence(),qualityChecks:{sourceFidelity:true,data:true,web:true,backend:true,video:true,sourcePackage:true}});
 const receipt=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(r));await f.finish(f.worker,task);
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:receipt.sha})).body.ok,true);
 assert.equal((await f.req('/v1/tasks/'+task.id)).body.status,'accepted','Verified delivery automatically closes confirmation');
 await f.tick();const op=(await f.tick()).body.operations.find(o=>o.kind==='collect');assert.equal(op.files.length,2);
 assert.equal((await f.ack({kind:'collect',relativeDirectory:'deliveries/'+f.spec.id,files:[]})).status,409);
 const body={kind:'collect',relativeDirectory:'deliveries/'+f.spec.id,files:op.files.map(({name,sha,size})=>({name,sha,size}))};
 assert.equal((await f.ack(body)).status,200);assert.equal((await f.ack(body)).status,200);
 assert.equal((await f.get()).body.status,'completed');
 const finalProgress=(await f.get()).body.latestProgress;
 assert.equal(finalProgress.node,f.master.id);
 assert.match(finalProgress.message,/主控校验并汇总/);
 assert.equal(finalProgress.taskId,null,'A collection receipt is not an old worker conversation message');
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});
test('batch preview uses the newest actual assistant progress and excludes other batches and tool activity',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight();
 const add=(taskId,kind,message,created)=>f.db.db.prepare('INSERT INTO events(id,node,task,type,payload,created) VALUES(?,?,?,?,?,?)').run(uid(),f.worker.id,taskId,'progress',JSON.stringify({kind,message}),created);
 add(task.id,'assistant_message','Initial question is not the current progress','2026-10-20T10:00:00Z');
 add(task.id,'assistant_message','The source archive is being verified','2026-10-20T10:10:00Z');
 add(task.id,'tool_activity','Do not display tool output','2026-10-20T10:20:00Z');
 add('unrelated-task','assistant_message','Private other batch','2026-10-20T10:30:00Z');
 const state=(await f.get()).body;
 assert.equal(state.latestProgress.message,'The source archive is being verified');
 assert.equal(state.latestProgress.taskId,task.id);
 assert.equal(state.latestProgress.node,f.worker.id);
});
test('production requires exact publication and independent review texts, matching run and a different reviewer',async t=>{
 for(const fault of ['missing','publication-hash','review-hash','foreign-run','self-review']){
  const f=await deliveryFixture(t),task=await f.preflight(),job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
  const zip=await f.output(f.worker,task,task.spec.outputs[1],'ZIP fixture');
  const evidence=f.evidence();
  if(fault==='missing')delete evidence.publishReceipt.rawText;
  if(fault==='publication-hash')evidence.publishReceipt.rawText+=' ';
  if(fault==='review-hash')evidence.independentReview.rawText+=' altered';
  if(fault==='foreign-run')evidence.publishReceipt.runId='foreign';
  if(fault==='self-review')f.db.db.prepare('UPDATE tasks SET thread_id=? WHERE id=?').run(evidence.independentReview.reviewerId,task.id);
  const receipt=f.receipt(task,{status:'published',inputSha:f.spec.inputs[0].sha,packageSha:zip.sha,skillInvoked:true,...evidence,qualityChecks:{sourceFidelity:true,data:true,web:true,backend:true,video:true,sourcePackage:true}});
  const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(receipt));await f.finish(f.worker,task);
  assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).body.passed,false,fault);
  assert.equal((await f.get()).body.status,'needs_attention');
  assert.equal((await f.req('/v1/tasks/'+task.id)).body.status,'submitted');
 }
});
test('unverified source files and fabricated published claims cannot advance',async t=>{
 const f=await deliveryFixture(t),task=await f.ready();
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(f.receipt(task,{status:'ready',installedCommit:f.baseline.commit,filesVerified:1,configPreserved:true})));
 await f.finish(f.worker,task);const job=(await f.get()).body.jobs[0];
 assert.equal((await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha})).body.passed,false);
 assert.equal((await f.get()).body.status,'needs_attention');
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/resume',{})).status,409);
});
test('paused and cancelled deliveries cannot start already queued production',async t=>{
 const f=await deliveryFixture(t);await f.create(f.spec);await f.ack({kind:'baseline',baseline:f.baseline});await f.tick();
 f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='D:/paused',root_key='d:/paused'").run();await f.tick();
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/pause',{})).status,200);
 assert.equal((await f.poll(f.worker)).body.tasks.length,0);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/resume',{})).status,200);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/cancel',{})).status,200);
 assert.equal((await f.poll(f.worker)).body.tasks.length,0);
 await f.tick();assert.equal((await f.get()).body.status,'cancelled');
});
test('uncertain execution is never silently retried',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight();
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(task.id);
 await f.tick();await f.tick();assert.equal((await f.get()).body.status,'needs_attention');
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});
test('terminal, explicitly repairable failure creates only one deterministic repair',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight();
 f.db.db.prepare("UPDATE tasks SET status='failed',result=? WHERE id=?").run(JSON.stringify({error:'Build failed'}),task.id);
 await f.poll(f.worker,[],true);await f.tick();await f.tick();
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE phase='produce'").get().n,2);
 const repair=(await f.poll(f.worker)).body.tasks.find(t=>t.spec.role==='delivery-repair');assert.ok(repair);
 assert.equal(repair.spec.workspaceId,task.spec.workspaceId);
 assert.notEqual(repair.spec.outputs[0],task.spec.outputs[0]);
});
test('resolved terminal blocker continues original workspace exactly once without bypassing uncertain work or limits',async t=>{
 const f=await deliveryFixture(t),task=await f.preflight(),job=(await f.get()).body.jobs.find(j=>j.phase==='produce');
 const blocked=f.receipt(task,{status:'blocked',error:'Desktop metadata needs supported compatibility'});
 await f.output(f.worker,task,task.spec.outputs[1],'diagnostic-only ZIP fixture');
 const ref=await f.output(f.worker,task,task.spec.outputs[0],JSON.stringify(blocked));await f.finish(f.worker,task);
 const inspection=await f.ack({kind:'inspect',jobId:job.id,receiptSha:ref.sha});assert.equal(inspection.status,200,JSON.stringify(inspection.body));assert.equal((await f.get()).body.status,'needs_attention');
 const resolution={id:uid(),taskId:task.id,note:'Compatibility candidate passed independent review; continue existing run. '+ 'x'.repeat(4000)+'LATEST_RESOLUTION_END'};
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(task.id);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/retry',resolution)).status,409);
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
 const resumed=await f.post('/v1/deliveries/'+f.spec.id+'/retry',resolution);assert.equal(resumed.status,200,JSON.stringify(resumed.body));
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/retry',resolution)).status,200);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/retry',{...resolution,note:'Changed interpretation of the same request'})).status,409);
 await f.poll(f.worker,[],true);await f.tick();await f.tick();
 const repair=(await f.poll(f.worker)).body.tasks.find(t=>t.spec.role==='delivery-repair');
 assert.ok(repair);assert.equal(repair.spec.workspaceId,task.spec.workspaceId);assert.match(repair.spec.prompt,/Compatibility candidate passed/);
 assert.ok(repair.spec.prompt.includes(resolution.note));assert.match(repair.spec.prompt,/LATEST_RESOLUTION_END/);
 assert.equal((await f.get()).body.jobs.find(j=>j.taskId===task.id).status,'continued');
 assert.equal((await f.get()).body.resolutions[0].note,resolution.note);
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE phase='produce'").get().n,2);
 f.db.db.prepare("UPDATE tasks SET status='failed',result=? WHERE id=?").run(JSON.stringify({error:'Transient build failure after accepted resolution'}),repair.id);
 await f.poll(f.worker,[],true);await f.tick();await f.tick();
 const second=(await f.poll(f.worker)).body.tasks.find(t=>t.spec.role==='delivery-repair');
 assert.ok(second);assert.ok(second.spec.prompt.includes(resolution.note),'Further repair preserves the approved scope');
 f.db.db.prepare("UPDATE delivery_batches SET status='needs_attention',declaration=json_set(declaration,'$.maxRepairs',0) WHERE id=?").run(f.spec.id);
 f.db.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(repair.id);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/retry',{id:uid(),taskId:repair.id,note:'Attempt cannot exceed configured repair cap'})).status,409);
});
test('completed regional handoff resumes the exact child after regional disconnect',async t=>{
 const f=await regionalFixture(t),h=await f.launch();
 const spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 f.db.db.prepare("UPDATE tasks SET status='submitted',updated='2020-01-01T00:00:00Z' WHERE id=?").run(h.task_id);
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01T00:00:00Z' WHERE id=?").run(f.regional.id);
 await f.tick();await f.tick();
 const child=f.db.db.prepare('SELECT id,creator FROM tasks WHERE id=?').get(spec.id);
 assert.ok(child,'A completed acknowledged handoff must not silently stall when regional node disconnects');
 assert.equal(child.creator,f.master.id);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks WHERE id=?').get(spec.id).n,1);
});

test('local controller worker exclusion blocks already queued business task',async t=>{
 const f=await localControllerFixture(t),h=await f.launch();
 const spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 assert.equal((await f.post('/v1/tasks',spec,f.worker.token)).status,200);
 f.db.db.prepare("UPDATE tasks SET status='accepted' WHERE id=?").run(h.task_id);
 await f.configure({excludedNodes:[f.excluded.id,f.worker.id]});
 const result=await f.poll(f.worker);
 assert.equal(result.body.tasks.some(x=>x.id===spec.id),false,'Excluding a device must prevent a new claim without stopping an already running task');
});

test('direct worker exclusion blocks already queued business task',async t=>{
 const f=await deliveryFixture(t);await f.create(f.spec);await f.ack({kind:'baseline',baseline:f.baseline});await f.tick();
 f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='D:/isolated/project',root_key='d:/isolated/project'").run();
 await f.tick();
 const spec=JSON.parse(f.db.db.prepare('SELECT spec FROM delivery_jobs').get().spec);
 await f.post('/v1/delivery/settings',{controller:f.master.id,excludedNodes:[f.excluded.id,f.worker.id]},f.adminToken);
 const result=await f.poll(f.worker);
 assert.equal(result.body.tasks.some(x=>x.id===spec.id),false,'Exclusion must also block direct mode pending delivery');
});


test('uncertain regional handoff registers a recovery issue while offline and never duplicates',async t=>{
 const f=await regionalFixture(t),h=await f.launch();
 f.db.db.prepare("UPDATE delivery_batches SET loop_policy=? WHERE id=?").run(JSON.stringify({version:1,perDevice:2,master:null}),f.spec.id);
 f.db.db.prepare("UPDATE tasks SET status='uncertain',updated='2020-01-01T00:00:00Z' WHERE id=?").run(h.task_id);
 f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01T00:00:00Z' WHERE id=?").run(f.regional.id);
 await f.tick();await f.tick();
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_handoffs').get().n,1);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_dispatch_fallbacks').get().n,0);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM delivery_recovery').get().n,1,'Unknown offline handoff must expose one durable recovery issue');
});

test('publishing PC skips local preflight only for new batches; remote and old batches keep it',async t=>{
 const f=await deliveryFixture(t,{masterId:SKILL_SOURCE_NODE});
 await f.post('/v1/delivery/settings',{controller:f.master.id,excludedNodes:[],allowControllerWork:true},f.adminToken);
 f.spec.nodes=[f.master.id];
 assert.equal((await f.create(f.spec)).status,200);
 const original=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id);
 assert.equal((await f.create(f.spec)).status,200,'Stable request stays idempotent');
 assert.equal((await f.get()).body.baseline.commit,'local-source');
 assert.equal((await f.get()).body.status,'producing');
 await f.tick();f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='D:/source',root_key='d:/source'").run();await f.tick();
 const task=(await f.poll(f.master)).body.tasks.find(t=>t.spec.role==='delivery-build');assert.ok(task);
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE phase='preflight'").get().n,0);
 assert.ok(!task.spec.inputs.some(i=>i.name.startsWith('skill-baseline/')));
 assert.match(task.spec.prompt,/本机是技能发布源/);assert.doesNotMatch(task.spec.prompt,/必须核对 Git blob/);
 assert.match(task.spec.prompt,/independentReview/,'No exemption from output review');
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/pause',{})).status,200);
 assert.equal((await f.post('/v1/deliveries/'+f.spec.id+'/resume',{})).status,200);
 assert.equal((await f.get()).body.status,'producing');
 const frozen=f.db.db.prepare('SELECT spec,status FROM tasks WHERE id=?').get(task.id);await f.tick();
 assert.deepEqual(f.db.db.prepare('SELECT spec,status FROM tasks WHERE id=?').get(task.id),frozen,'Existing running task untouched');
 assert.equal(f.db.db.prepare('SELECT declaration_hash FROM delivery_batches WHERE id=?').get(f.spec.id).declaration_hash,original.declaration_hash);
 // Simulate a persisted pre-rollout batch. Repeating create must not stamp it.
 f.db.db.prepare("UPDATE delivery_batches SET loop_policy='{}',status='preflight',baseline=? WHERE id=?").run(JSON.stringify(f.baseline),f.spec.id);
 assert.equal((await f.create(f.spec)).status,200);assert.deepEqual((await f.get()).body.skillSourceNodes,[]);
 await f.tick();assert.equal(f.db.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE phase='preflight'").get().n,1);
 const request={...f.spec,id:uid(),nodes:[f.master.id,f.worker.id]};assert.equal((await f.create(request)).status,200);
 await f.post('/v1/deliveries/'+request.id+'/ack',{kind:'baseline',baseline:f.baseline});await f.tick();
 f.db.db.prepare("UPDATE project_workspaces SET status='ready',root='D:/remote',root_key='d:/remote' WHERE node=?").run(f.worker.id);await f.tick();
 const jobs=f.db.db.prepare('SELECT phase,node FROM delivery_jobs WHERE batch_id=?').all(request.id);
 assert.deepEqual(jobs.map(j=>[j.phase,j.node]),[['preflight',f.worker.id]]);
 assert.equal((await f.req('/v1/deliveries/'+request.id)).body.status,'preflight');
});

test('lightweight default and owner feedback preserve original threads without maintenance cycles',async t=>{
 const f=await localControllerFixture(t);
 assert.equal((await f.post('/v1/skill-owners',{owners:[{...f.binding}]},f.adminToken)).status,200);
 const made=await f.create(f.spec);assert.equal(made.status,200);assert.equal(made.body.dispatchPolicy,'batch-controller-v1');
 assert.equal((await f.create(f.spec)).status,200,'old client retry preserves default policy');
 await f.tick();assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 // Finish only the handoff message, not the business batch, to release its thread for a note.
 f.db.db.prepare("UPDATE tasks SET status='accepted'").run();
 const note={id:'owner-note-test',project:'workspace',profile:'software',trigger:'requirement_change',description:'请改善已有技能的数据导出和字段命名规则。',expected:'由原技能总控修改并验证，不要重复创建其他维护任务。'};
 const sent=await f.post('/v1/skill-maintenance',note);assert.equal(sent.status,200,JSON.stringify(sent.body));assert.equal(sent.body.state,'forwarded');
 const job=f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(sent.body.taskId);assert.equal(job.target,f.worker.id);assert.equal(JSON.parse(job.spec).desktopThreadId,f.threadId);
 assert.equal((await f.post('/v1/skill-maintenance',note)).body.taskId,job.id);
 assert.equal((await f.post('/v1/skill-maintenance',{...note,description:note.description+'改动'})).status,409);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM skill_cycles').get().n,0);
 await f.poll(f.worker);assert.notEqual(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(job.id).status,'queued','direct owner message can be claimed');
});

test('paused owner retains improvement without dispatch and retries only once after recovery',async t=>{
 const f=await localControllerFixture(t);await f.post('/v1/skill-owners',{owners:[f.binding]},f.adminToken);
 await f.configure({excludedNodes:[f.worker.id,f.excluded.id]});
 const note={id:'paused-owner-note',project:'workspace',profile:'software',trigger:'defect',description:'已有交付导出缺少字段，请修复技能问题。',expected:'按原技能总控工作方式修复并回报结果。'};
 const r=await f.post('/v1/skill-maintenance',note);assert.equal(r.status,200);assert.equal(r.body.state,'submitted');assert.match(r.body.error,/暂停/);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 await f.configure();await f.tick();await f.tick();assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 const original=f.db.db.prepare('SELECT * FROM tasks').get();f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(original.id);await f.tick();await f.tick();assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 assert.equal(f.db.db.prepare('SELECT state FROM skill_maintenance_requests').get().state,'needs_attention');
});

test('owner changes do not reroute an already recorded improvement',async t=>{
 const f=await localControllerFixture(t);await f.post('/v1/skill-owners',{owners:[f.binding]},f.adminToken);await f.configure({excludedNodes:[f.worker.id]});
 const b={id:'fixed-owner-route',project:'workspace',profile:'software',trigger:'upgrade',description:'需要升级已有技能的数据导出能力。',expected:'保持原有案件不受影响，升级由原负责人完成。'};
 await f.post('/v1/skill-maintenance',b);await f.post('/v1/skill-owners',{owners:[]},f.adminToken);await f.configure();await f.tick();
 assert.equal(f.db.db.prepare('SELECT target FROM tasks').get().target,f.worker.id);
 const missing=await f.post('/v1/skill-maintenance',{...b,id:'missing-owner'});assert.equal(missing.status,409);
});

test('existing legacy batch retry keeps its policy and running work unchanged',async t=>{
 const f=await localControllerFixture(t);await f.create(f.spec);
 const row=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(f.spec.id),d=JSON.parse(row.declaration);delete d.dispatchPolicy;
 const policy=JSON.stringify({version:1,master:f.binding});f.db.db.prepare("UPDATE delivery_batches SET declaration=?,declaration_hash=?,loop_policy=?,status='paused' WHERE id=?").run(JSON.stringify(d),hash(canonical(d)),policy,row.id);
 const before=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(row.id);const retry=await f.create(f.spec);assert.equal(retry.status,200);assert.equal(retry.body.status,'paused');assert.deepEqual(f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(row.id),before);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
