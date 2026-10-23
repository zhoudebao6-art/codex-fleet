import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';

class SqliteD1{
 constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
 prepare(sql){const db=this.db;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args)||null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){const r=db.prepare(sql).run(...this.args);return {meta:{changes:Number(r.changes)}};}};}
 async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const results=items.map(i=>{const s=this.db.prepare(i.sql);if(/^\s*SELECT/i.test(i.sql))return {results:s.all(...i.args),meta:{changes:0}};const r=s.run(...i.args);return {meta:{changes:Number(r.changes)}};});this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class MemoryR2{constructor(){this.objects=new Map();}async put(key,data){this.objects.set(key,Buffer.from(data));return {key};}async get(key,options){let b=this.objects.get(key);if(!b)return null;if(options?.range)b=b.subarray(options.range.offset,options.range.offset+options.range.length);return {body:new Response(b).body,size:b.length};}}
async function fixture(t){
 const db=new SqliteD1();t.after(()=>db.db.close());const token=secret(),env={DB:db,BUCKET:new MemoryR2(),FLEET_ADMIN_TOKEN:token};
 const caps={ready:true,parallelExecution:true,desktopSessionBridge:true,conversationDispatch:true,localExecutionPolicy:true,workspaceExecution:true,projects:['workspace']};
 function node(name){const id=uid(),token=secret(),workspace=uid();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities) VALUES(?,?,?,?,?,?,?)').run(id,name,hash(token),'["workspace"]',name,now(),JSON.stringify(caps));db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,'workspace',?,'E:/existing','e:/existing','registered','ready','admin','fixed',?,?)").run(workspace,id,name,now(),now());return {id,token,workspace};}
 const master=node('PC01'),worker=node('PC03');db.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('delivery_controller',JSON.stringify({controller:master.id,excludedNodes:[],dispatchMode:'direct',allowControllerWork:true,localControllers:[]}));
 async function req(route,{method='GET',data,auth=token,headers={}}={}){if(auth)headers.authorization='Bearer '+auth;if(data!==undefined)headers['content-type']=Buffer.isBuffer(data)?'application/octet-stream':'application/json';const response=await handle(new Request('https://fleet.test'+route,{method,headers,body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)}),env);return {status:response.status,body:(response.headers.get('content-type')||'').startsWith('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};}
 const post=(route,data,auth)=>req(route,{method:'POST',data,auth});
 const poll=(n,events=[])=>post('/v1/sync',{events,capabilities:caps},n.token);
 async function upload(name,text){const bytes=Buffer.from(text),sha=hash(bytes);assert.equal((await post('/v1/files',{name,sha,size:bytes.length,project:'workspace'})).status,200);assert.equal((await req('/v1/files/'+sha+'?project=workspace&offset=0',{method:'PUT',data:bytes})).status,200);return {name,sha,size:bytes.length};}
 async function output(n,task,name,text){const bytes=Buffer.from(typeof text==='string'?text:JSON.stringify(text)),sha=hash(bytes),url='/v1/artifacts/'+sha+'?task='+task.id;assert.equal((await post(url,{name,size:bytes.length},n.token)).status,200);assert.equal((await req(url+'&offset=0',{method:'PUT',data:bytes,auth:n.token})).status,200);return {name,sha,size:bytes.length};}
 const flow={id:'isolated-flow',version:1,name:'独立说明流程',description:'Uses existing native task transport',adapter:'desktop-evidence-v1',taskPrompt:'实际读取材料，根据本次需求输出准确解释。',outputs:['explanation.txt'],requiredSkills:[]};
 assert.equal((await post('/v1/case-flows',flow)).status,200);const input=await upload('material.txt','真实输入数据：参考编号 A-123。');
 const specification={id:'case-'+uid(),name:'持续案件',project:'workspace',flowId:flow.id,mode:'new',nodeIds:[worker.id],inputs:[input],notes:'解释参考编号'};
 const get=()=>req('/v1/cases/'+specification.id),create=(b={})=>post('/v1/cases',{...specification,...b});
 async function claim(phase){const n=phase==='collect'?master:worker;let result=await poll(n);let task=result.body.tasks.find(x=>x.spec.role==='case-'+phase);assert.ok(task,'Expected automatically dispatched '+phase+': '+JSON.stringify(result.body));const threadId=uid();assert.equal((await poll(n,[{id:uid(),type:'started',taskId:task.id,attemptId:task.attempt,threadId}])).status,200);task=(await req('/v1/tasks/'+task.id)).body;return {n,task,threadId};}
 async function finish({n,task,threadId},status='submitted'){const r=await poll(n,[{id:uid(),type:'finished',taskId:task.id,attemptId:task.attempt,threadId,status,result:{summary:'Real fixture evidence uploaded'}}]);assert.equal(r.status,200,JSON.stringify(r.body));}
 function contract(){const r=db.db.prepare('SELECT r.*,v.id AS vid FROM case_revisions r JOIN case_versions v ON v.case_id=r.case_id AND v.revision_number=r.number WHERE r.case_id=? ORDER BY r.number DESC LIMIT 1').get(specification.id);return {schema:1,caseId:specification.id,versionId:r.vid,revision:r.number,requestHash:r.request_hash};}
 async function produced(current){const c=current||await claim('produce'),artifact=await output(c.n,c.task,c.task.spec.outputs.find(x=>!x.endsWith('/receipt.json')),'编号 A-123 是提供的参考编号。');await output(c.n,c.task,c.task.spec.outputs.find(x=>x.endsWith('/receipt.json')),{...contract(),status:'produced',inputShas:c.task.spec.inputs.map(x=>x.sha),artifacts:[artifact],summary:'Read actual fixture input'});await finish(c);return {current:c,artifact};}
 async function reviewed(p,{alter=false,self=false,reject=false}={}){const c=await claim('review');const findings={...contract(),decision:reject?'fail':'pass',producerTaskId:p.current.task.id,producerThreadId:p.current.threadId,reviewerThreadId:self?p.current.threadId:c.threadId,reviewedArtifacts:[alter?{...p.artifact,sha:'0'.repeat(64)}:p.artifact],findings:reject?'解释内容不符合需求，请实际修正后重新制作。':'逐项对比输入参考编号及解释内容，二者一致。'};const artifact=await output(c.n,c.task,c.task.spec.outputs[0],findings);await finish(c);return {current:c,artifact};}
 async function collected(p,r,{alter=false,savedDirectory}={}){const c=await claim('collect');const producedFiles=db.db.prepare("SELECT a.name,a.sha,f.size FROM artifact_refs a JOIN files f ON f.project='workspace' AND f.sha=a.sha WHERE a.task=? AND a.direction='output' ORDER BY a.name").all(p.current.task.id),reviewFiles=db.db.prepare("SELECT a.name,a.sha,f.size FROM artifact_refs a JOIN files f ON f.project='workspace' AND f.sha=a.sha WHERE a.task=? AND a.direction='output' ORDER BY a.name").all(r.current.task.id);await output(c.n,c.task,c.task.spec.outputs[0],{...contract(),status:'collected',nodeId:master.id,relativeDirectory:`cases/${specification.id}/revision-${contract().revision}`,savedDirectory:savedDirectory||`${c.task.spec.collectionRoot||'E:/legacy'}/case-${specification.id}/revision-${contract().revision}`,files:alter?[]:[...producedFiles,...reviewFiles],reviewSha:r.artifact.sha});await finish(c);return c;}
 return {db,env,token,req,post,poll,flow,input,specification,create,get,master,worker,upload,output,claim,finish,contract,produced,reviewed,collected};
}

test('draft resumes once; ordinary node sync completes production, independent review and exact controller collection',async t=>{
 const f=await fixture(t);assert.equal((await f.create({nodeIds:[]})).body.status,'draft');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 const resume={id:uid(),expectedRevision:1,nodeIds:[f.worker.id]};assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',resume)).status,200);assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',resume)).status,200);
 const p=await f.produced(),r=await f.reviewed(p);await f.collected(p,r);
 const final=(await f.get()).body;assert.equal(final.status,'completed',JSON.stringify(final));assert.equal(final.versions[0].verification,'verified');assert.equal(final.files.length,1);assert.equal(final.revisions[0].status,'fulfilled');assert.equal(f.db.db.prepare("SELECT count(*) n FROM tasks WHERE status='accepted'").get().n,3);
 for(let i=0;i<3;i++)await f.poll(f.worker);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,3);
});
test('in-flight additions are immutable, acknowledged, serialized and run only after original version collection',async t=>{
 const f=await fixture(t);await f.create();const original=await f.claim('produce'),before=f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id);
 const request={id:uid(),expectedRevision:1,text:'补充说明编号用途。',attachments:[]},url='/v1/cases/'+f.specification.id+'/requirements';
 const accepted=await f.post(url,request);assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.revisions[1].status,'pending_boundary');assert.ok(accepted.body.revisions[1].acknowledgement.acceptedAt);
 assert.equal((await f.post(url,request)).status,200);assert.equal((await f.post(url,{...request,text:'conflict'})).status,409);assert.equal((await f.post(url,{...request,id:uid()})).status,409);
 assert.deepEqual(f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id),before);assert.equal((await f.get()).body.versions.length,1);
 const p=await f.produced(original),r=await f.reviewed(p);await f.collected(p,r);assert.equal((await f.get()).body.status,'pending_requirements');
 await f.poll(f.worker);const updated=(await f.get()).body;assert.equal(updated.versions.length,2);assert.equal(updated.versions[1].sourceVersionId,updated.versions[0].id);assert.equal(updated.versions[0].verification,'verified');
 const next=await f.claim('produce');assert.ok(next.task.spec.inputs.some(x=>x.sha===p.artifact.sha));assert.equal(next.task.spec.workspaceId,original.task.spec.workspaceId);assert.match(next.task.spec.prompt,/补充说明编号用途/);assert.notEqual(next.task.spec.prompt,original.task.spec.prompt);
 const p2=await f.produced(next),r2=await f.reviewed(p2);await f.collected(p2,r2);assert.equal((await f.get()).body.status,'completed');assert.equal((await f.get()).body.versions.filter(v=>v.verification==='verified').length,2);
});
test('historical artifacts remain unverified while new work can be independently delivered',async t=>{
 const f=await fixture(t),old=await f.upload('old.txt','历史解释，不代表平台已审核。');
 assert.equal((await f.create({mode:'import',nodeIds:[],history:{description:'人工导入的历史目录',sourceLocation:'E:/historical',files:[old]}})).status,200);
 assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);let state=(await f.get()).body;assert.equal(state.status,'imported');assert.equal(state.files[0].verification,'unverified');
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:uid(),expectedRevision:1,text:'补充解释'})).status,400);
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:uid(),expectedRevision:1,text:'补充解释',nodeIds:[f.worker.id]})).status,200);
 const p=await f.produced();assert.ok(p.current.task.spec.inputs.some(x=>x.sha===old.sha));const r=await f.reviewed(p);await f.collected(p,r);state=(await f.get()).body;
 assert.equal(state.status,'completed');assert.equal(state.versions[0].verification,'unverified');assert.equal(state.versions[1].verification,'verified');assert.equal(state.source.verification,'unverified');
});
test('wrong reviewer identity or reviewed hashes never certify a case',async t=>{
 for(const fault of ['self','alter']){const f=await fixture(t);await f.create();const p=await f.produced();await f.reviewed(p,{self:fault==='self',alter:fault==='alter'});const state=(await f.get()).body;assert.equal(state.status,'needs_attention');assert.notEqual(state.versions[0].verification,'verified');assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='collect'").get().n,0);}
});
test('collection needs exact reviewed files; claimed local save cannot omit an artifact',async t=>{
 const f=await fixture(t);await f.create();const p=await f.produced(),r=await f.reviewed(p);await f.collected(p,r,{alter:true});assert.equal((await f.get()).body.status,'needs_attention');assert.equal(f.db.db.prepare("SELECT count(*) n FROM tasks WHERE status='accepted'").get().n,0);
});
test('terminal failure resumes original workspace/context once, while uncertain original work cannot restart',async t=>{
 const f=await fixture(t);await f.create();const c=await f.claim('produce');await f.finish(c,'failed');let state=(await f.get()).body;assert.equal(state.status,'needs_attention');
 const request={id:uid(),expectedRevision:1,note:'已核实原任务停止，依赖路径恢复后接续原任务。'};
 f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(c.task.id);assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',request)).status,409);
 f.db.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(c.task.id);const result=await f.post('/v1/cases/'+f.specification.id+'/resume',request);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',request)).status,200);
 const retry=f.db.db.prepare('SELECT * FROM case_jobs WHERE attempt=1').get();assert.ok(retry);const spec=JSON.parse(retry.spec);assert.equal(spec.resumeTaskId,c.task.id);assert.equal(spec.workspaceId,c.task.spec.workspaceId);assert.ok(spec.outputs.every(x=>x.includes('/attempt-1/')));assert.equal(f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(c.task.id).spec,JSON.stringify(c.task.spec));
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',{...request,note:'Different concrete resolution must not reuse the same identifier'})).status,409);
 const p=await f.produced(),r=await f.reviewed(p);await f.collected(p,r);assert.equal((await f.get()).body.status,'completed');assert.equal(f.db.db.prepare('SELECT count(*) n FROM case_jobs').get().n,4);
});
test('registry versions are immutable, disabled flows cannot create, and case snapshots survive registry updates',async t=>{
 const f=await fixture(t);await f.create({nodeIds:[]});assert.equal((await f.post('/v1/case-flows',{...f.flow,taskPrompt:'Different frozen automation contract'})).status,409);assert.equal((await f.post('/v1/case-flows',{...f.flow,version:2,taskPrompt:'New second version automation'})).status,200);
 assert.equal((await f.get()).body.flow.version,1);assert.equal((await f.req('/v1/case-flows/'+f.flow.id,{method:'PATCH',data:{enabled:false}})).status,200);assert.equal((await f.req('/v1/case-flows')).body.flows.some(x=>x.id===f.flow.id),false);
 assert.equal((await f.create({id:uid()})).status,409);assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',{id:uid(),expectedRevision:1,nodeIds:[f.worker.id]})).status,200);
 assert.equal((await f.post('/v1/case-flows',{...f.flow,id:'bad',outputs:['RECEIPT.JSON']})).status,400);
});
test('a proven pre-execution review TLS failure retries only review without a nonexistent resume conversation',async t=>{
 const f=await fixture(t);await f.create();const p=await f.produced();
 const pending=await f.poll(f.worker),review=pending.body.tasks.find(x=>x.spec.role==='case-review');assert.ok(review);
 const failure={status:'failed',summary:'',error:'Proxy TLS timeout',artifacts:[],cwd:null};
 await f.poll(f.worker,[{id:uid(),type:'started',taskId:review.id,attemptId:review.attempt}]);
 await f.poll(f.worker,[{id:uid(),type:'finished',taskId:review.id,attemptId:review.attempt,status:'failed',result:failure}]);
 assert.equal((await f.get()).body.status,'needs_attention');
 const original=f.db.db.prepare('SELECT spec,result,thread_id FROM tasks WHERE id=?').get(review.id);assert.equal(original.thread_id,null);
 const request={id:uid(),expectedRevision:1,note:'已核实TLS准备失败且没有创建会话或执行轮，网络恢复后仅接续审核。'};
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',request)).status,200);
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',request)).status,200);
 const retry=f.db.db.prepare("SELECT * FROM case_jobs WHERE phase='review' AND attempt=1").get(),spec=JSON.parse(retry.spec);
 assert.equal(Object.hasOwn(spec,'resumeTaskId'),false);assert.equal(spec.workspaceId,review.spec.workspaceId);assert.match(spec.prompt,new RegExp(review.id));assert.match(spec.prompt,/创建Codex会话前/);
 assert.ok(spec.outputs.every(x=>x.includes('/attempt-1/')));
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='produce'").get().n,1);
 assert.deepEqual(f.db.db.prepare('SELECT spec,result,thread_id FROM tasks WHERE id=?').get(review.id),original);
 const r=await f.reviewed(p);await f.collected(p,r);assert.equal((await f.get()).body.status,'completed');
 assert.equal(f.db.db.prepare("SELECT status FROM tasks WHERE id=?").get(review.id).status,'failed');
});
test('a missing conversation without exact pre-execution evidence cannot create a retry',async t=>{
 const f=await fixture(t);await f.create();await f.produced();
 const pending=await f.poll(f.worker),review=pending.body.tasks.find(x=>x.spec.role==='case-review');assert.ok(review);
 const proof={status:'failed',summary:'',error:'Proxy TLS timeout',artifacts:[],cwd:null};
 await f.poll(f.worker,[{id:uid(),type:'finished',taskId:review.id,attemptId:review.attempt,status:'failed',result:proof}]);
 const variants=[{}, {...proof,error:'Unknown execution error'}, {...proof,cwd:'E:/existing'}, {...proof,cwd:undefined}, {...proof,threadId:uid()}, {...proof,turnId:uid()}, {...proof,desktop:{threadId:uid()}}, {...proof,artifacts:[{name:'output.txt'}]}];
 for(const result of variants){
  f.db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(result),review.id);
  const response=await f.post('/v1/cases/'+f.specification.id+'/resume',{id:uid(),expectedRevision:1,note:'只核验恢复条件，不允许未知原执行被重复派发。'});
  assert.equal(response.status,409,JSON.stringify({result,response}));
 }
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='review'").get().n,1);
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='produce'").get().n,1);
});
test('revoked group scope prevents dossier metadata and queued task claims after an added device',async t=>{
 const f=await fixture(t),groupA=uid(),groupB=uid(),memberId=uid(),userId=uid(),email='scope@example.test';
 for(const [id,name,node]of [[groupA,'A',f.master],[groupB,'B',f.worker]]){f.db.db.prepare('INSERT INTO device_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,name,now(),now());f.db.db.prepare('UPDATE nodes SET display_group_id=? WHERE id=?').run(id,node.id);}
 f.db.db.prepare("INSERT INTO members(id,user_id,email,role,group_access,created) VALUES(?,?,?,'operator',?,?)").run(memberId,userId,email,JSON.stringify({mode:'all',groupIds:[]}),now());
 const headers={'oai-authenticated-user-id':userId,'oai-authenticated-user-email':email,origin:'https://fleet.test'};
 const create=await f.req('/v1/cases',{method:'POST',data:f.specification,auth:null,headers});assert.equal(create.status,200,JSON.stringify(create.body));
 f.db.db.prepare('UPDATE members SET group_access=? WHERE id=?').run(JSON.stringify({mode:'groups',groupIds:[groupA]}),memberId);
 assert.equal((await f.req('/v1/cases/'+f.specification.id,{auth:null,headers:{...headers}})).status,403);assert.equal((await f.req('/v1/cases',{auth:null,headers:{...headers}})).body.cases.length,0);assert.equal((await f.poll(f.worker)).body.tasks.length,0);
});

test('content rejection cannot pass by replaying the same reviewer; explicit correction creates a new reviewed version',async t=>{
 const f=await fixture(t);await f.create();const p=await f.produced();await f.reviewed(p,{reject:true});let state=(await f.get()).body;assert.equal(state.status,'needs_attention');assert.equal(state.resume.allowed,false);
 assert.equal((await f.post('/v1/cases/'+f.specification.id+'/resume',{id:uid(),expectedRevision:1,note:'不能只重新审核原内容，这份说明必须实际修正。'})).status,409);
 const correction=await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:uid(),expectedRevision:1,text:'按审核意见修正解释内容并重新独立核对。'});assert.equal(correction.status,200,JSON.stringify(correction.body));state=correction.body;assert.equal(state.versions[0].status,'rejected');assert.equal(state.versions[0].verification,'unverified');assert.equal(state.versions.length,2);
 const p2=await f.produced(),r2=await f.reviewed(p2);await f.collected(p2,r2);assert.equal((await f.get()).body.status,'completed');assert.equal((await f.get()).body.versions[0].verification,'unverified');
});
test('completed links retain only original requirements, cannot duplicate ownership, and remain readable when a node is retired',async t=>{
 const f=await fixture(t),batchId=uid(),declaration={id:batchId,name:'已完成原批次',profile:'software',project:'workspace',mode:'production',nodes:[f.worker.id],inputs:[f.input],notes:'原需求',requirements:[],maxRepairs:2};
 f.db.db.prepare("INSERT INTO delivery_batches(id,creator,creator_kind,controller,project,declaration,declaration_hash,status,created_at,updated_at) VALUES(?,'admin','service',?,'workspace',?,?,'completed',?,?)").run(batchId,f.master.id,JSON.stringify(declaration),hash(JSON.stringify(declaration)),now(),now());const before=f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batchId);
 const link={flowId:'software',mode:'link',batchId,nodeIds:[],inputs:[],notes:''};assert.equal((await f.create({...link,notes:'此新需求没有执行，不可认作已完成'})).status,400);
 const created=await f.create(link);assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.revisions[0].text,'原需求');assert.equal(created.body.revisions[0].status,'fulfilled');assert.equal((await f.create({...link,id:uid()})).status,409);
 assert.deepEqual(f.db.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batchId),before);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 f.db.db.prepare("UPDATE nodes SET revoked=1,projects='[]' WHERE id=?").run(f.worker.id);assert.equal((await f.get()).status,200);assert.equal((await f.req('/v1/cases')).body.cases.length,1);
});

test('a requirement accepted during the prior import summary cannot be overwritten by a stale imported status',async t=>{
 const f=await fixture(t),old=await f.upload('historical.txt','历史原件');let injected=false;
 const originalBatch=f.db.batch.bind(f.db);f.db.batch=async items=>{
  if(!injected&&items.some(s=>s.sql.startsWith('UPDATE case_dossiers SET status=')&&s.sql.includes('updated_at='))){
   injected=true;
   const added=await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:'concurrent-history-addition',expectedRevision:1,text:'历史导入完成汇总时接收的真实补充要求。',nodeIds:[f.worker.id]});
   assert.equal(added.status,200,JSON.stringify(added.body));
  }
  return originalBatch(items);
 };
 const imported=await f.create({mode:'import',nodeIds:[],history:{description:'导入原件',files:[old]}});assert.equal(imported.status,200);assert.equal(injected,true);
 assert.equal(f.db.db.prepare('SELECT status FROM case_dossiers WHERE id=?').get(f.specification.id).status,'pending_requirements');
 await f.poll(f.worker);const state=(await f.get()).body;assert.equal(state.versions.length,2);assert.equal(state.error,null,JSON.stringify(state));
 const prepared=f.db.db.prepare("SELECT j.task_id,t.spec FROM case_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.phase='produce'").get();assert.ok(prepared?.spec,'The new producer must be submitted automatically');
 assert.equal(state.versions[0].verification,'unverified');
});

test('independent review checks uploaded work before collection, preserves explicit production evidence, and retains its real rejection reason',async t=>{
 const f=await fixture(t);await f.create();const original=await f.claim('produce');
 await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:'pending-later-work',expectedRevision:1,text:'待原版本完成后再补充另一个说明。'});
 const p=await f.produced(original),review=await f.reviewed(p,{reject:true});
 assert.match(review.current.task.spec.prompt,/主控本地保存、归集目录及保存后的逐文件哈希由后续collect步骤实际执行并验证/);
 assert.match(review.current.task.spec.prompt,/若需求明确要求生产阶段另有本地副本或其他先行证据，仍须核验该项/);
 let state=(await f.get()).body;assert.match(state.error,/解释内容不符合需求/);const finding=state.error,oldPrompt=f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(review.current.task.id).spec;
 for(let i=0;i<3;i++)await f.poll(f.worker);state=(await f.get()).body;assert.equal(state.error,finding);assert.equal(state.versions[0].error,finding);assert.equal(state.revisions[1].status,'pending_boundary');
 assert.equal(f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(review.current.task.id).spec,oldPrompt);
});

test('a successor dispatch error never revives rejected history, and an accepted correction repairs an old revived status using the same successor job',async t=>{
 const f=await fixture(t);await f.create();const first=await f.claim('produce');
 await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:'queued-r2',expectedRevision:1,text:'新增的第二版本说明。'});
 const p=await f.produced(first);await f.reviewed(p,{reject:true});const oldVersion=f.db.db.prepare('SELECT * FROM case_versions WHERE case_id=? AND number=1').get(f.specification.id),oldEvidence=oldVersion.evidence;
 let injected=false;const originalBatch=f.db.batch.bind(f.db);f.db.batch=async items=>{
  if(!injected&&items.some(s=>s.sql.startsWith('INSERT OR IGNORE INTO tasks'))){injected=true;throw Object.assign(new Error('Temporary successor submission refusal'),{status:409});}
  return originalBatch(items);
 };
 const corrected=await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:'corrective-r3',expectedRevision:2,text:'澄清后置归集不是生产前提，实际改正说明并独立审核。'});assert.equal(corrected.status,200);assert.equal(injected,true);
 let historical=f.db.db.prepare('SELECT * FROM case_versions WHERE id=?').get(oldVersion.id);assert.equal(historical.status,'rejected');assert.equal(historical.evidence,oldEvidence);assert.equal(historical.error,oldVersion.error);
 const successor=f.db.db.prepare("SELECT j.* FROM case_jobs j JOIN case_versions v ON v.id=j.version_id WHERE v.case_id=? AND v.number=2 AND j.phase='produce'").get(f.specification.id);assert.ok(successor);assert.equal(f.db.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(successor.task_id),undefined);
 // Recover the exact persisted state left by the old catch implementation.
 f.db.db.prepare("UPDATE case_versions SET status='needs_attention',error='Original version needs evidence resolution before continuing' WHERE id=?").run(oldVersion.id);
 await f.poll(f.worker);historical=f.db.db.prepare('SELECT * FROM case_versions WHERE id=?').get(oldVersion.id);assert.equal(historical.status,'rejected');assert.equal(historical.evidence,oldEvidence);assert.equal(historical.error,oldVersion.error);
 assert.equal(f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(successor.task_id)?.spec,successor.spec);assert.equal(f.db.db.prepare('SELECT count(*) n FROM case_jobs WHERE version_id=?').get(oldVersion.id).n,2,'The original producer/reviewer are never dispatched again');
 const p2=await f.produced(),r2=await f.reviewed(p2);await f.collected(p2,r2);await f.poll(f.worker);const state=(await f.get()).body;assert.equal(state.versions[1].status,'completed');assert.equal(state.versions[2].revisionNumber,3);assert.equal(state.versions[0].status,'rejected');
});

test('an imported dossier with an already prepared successor recovers the same immutable task after the status race',async t=>{
 const f=await fixture(t),old=await f.upload('historical.txt','历史文件');
 await f.create({mode:'import',nodeIds:[],history:{description:'外部导入，仍未核验',files:[old]}});
 await f.post('/v1/cases/'+f.specification.id+'/requirements',{id:'history-followup',expectedRevision:1,text:'在历史材料基础上新增实际说明。',nodeIds:[f.worker.id]});
 const prepared=f.db.db.prepare("SELECT * FROM case_jobs WHERE phase='produce'").get(),originalSpec=prepared.spec;
 f.db.db.prepare('DELETE FROM tasks WHERE id=?').run(prepared.task_id);
 f.db.db.prepare("UPDATE case_dossiers SET status='imported',error='Case dispatch is no longer active' WHERE id=?").run(f.specification.id);
 const frozenHistory=f.db.db.prepare('SELECT * FROM case_versions WHERE case_id=? AND number=1').get(f.specification.id),frozenRevision=f.db.db.prepare('SELECT request,request_hash FROM case_revisions WHERE case_id=? AND number=2').get(f.specification.id);
 await f.poll(f.worker);assert.equal(f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(prepared.task_id)?.spec,originalSpec);
 await f.poll(f.worker);assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='produce'").get().n,1);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks WHERE id=?').get(prepared.task_id).n,1);
 assert.deepEqual(f.db.db.prepare('SELECT * FROM case_versions WHERE case_id=? AND number=1').get(f.specification.id),frozenHistory);assert.deepEqual(f.db.db.prepare('SELECT request,request_hash FROM case_revisions WHERE case_id=? AND number=2').get(f.specification.id),frozenRevision);
 assert.equal((await f.get()).body.error,null);
});

test('new collection freezes the E drive destination and rejects a silent fallback to D',async t=>{
 const f=await fixture(t);await f.create();const p=await f.produced(),r=await f.reviewed(p),c=await f.collected(p,r,{savedDirectory:'D:/研发图表/old-case'});
 assert.equal(c.task.spec.collectionRoot,'E:/研发自动化/交付成果');assert.match(c.task.spec.prompt,/没有E盘、配置不同或写入失败时报告具体阻碍/);assert.match(c.task.spec.prompt,/不静默退回D盘/);
 const state=(await f.get()).body;assert.equal(state.status,'needs_attention');assert.match(state.error,/frozen collection root/);assert.notEqual(state.versions[0].verification,'verified');
});

test('collectionRoot is an immutable optional creation setting without a schema change',async t=>{
 const f=await fixture(t),root='E:/configured-project-deliveries';assert.equal((await f.create({collectionRoot:root})).status,200);const p=await f.produced(),r=await f.reviewed(p),c=await f.collected(p,r);assert.equal(c.task.spec.collectionRoot,root);assert.equal((await f.get()).body.status,'completed');
 assert.equal((await f.create({collectionRoot:root})).status,200);assert.equal((await f.create({collectionRoot:'D:/different'})).status,409);
 assert.equal((await f.create({id:uid(),collectionRoot:'../invalid'})).status,400);
});

test('workspace readiness loss between production and review automatically resumes the same version without replaying production',async t=>{
 const f=await fixture(t);await f.create();const original=await f.claim('produce');
 const before=f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id);
 f.db.db.prepare("UPDATE case_versions SET source_snapshot=json_set(source_snapshot,'$.workspaces',json(?)) WHERE case_id=?").run(JSON.stringify({[f.worker.id]:f.worker.workspace}),f.specification.id);
 f.db.db.prepare("UPDATE project_workspaces SET status='error' WHERE id=?").run(f.worker.workspace);
 const p=await f.produced(original);let state=(await f.get()).body;assert.notEqual(state.status,'needs_attention');assert.match(state.error,/Original case workspace is no longer ready/);
 for(let i=0;i<2;i++)await f.poll(f.master);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 f.db.db.prepare("UPDATE project_workspaces SET status='ready' WHERE id=?").run(f.worker.workspace);
 await f.poll(f.master);const r=await f.reviewed(p);await f.collected(p,r);state=(await f.get()).body;assert.equal(state.status,'completed');
 assert.deepEqual(f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id),before);
 assert.equal(f.db.db.prepare("SELECT count(*) n FROM case_jobs WHERE phase='produce'").get().n,1);
});

test('legacy readiness-only needs_attention recovers on ordinary sync using original producer and request',async t=>{
 const f=await fixture(t);await f.create();const original=await f.claim('produce');
 f.db.db.prepare("UPDATE project_workspaces SET status='error' WHERE id=?").run(f.worker.workspace);const p=await f.produced(original);
 const version=f.db.db.prepare('SELECT * FROM case_versions WHERE case_id=?').get(f.specification.id),before=f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id);
 f.db.db.prepare("UPDATE case_versions SET status='needs_attention',error='No existing ready workspace for this case device' WHERE id=?").run(version.id);
 f.db.db.prepare("UPDATE case_dossiers SET status='needs_attention',error='No existing ready workspace for this case device' WHERE id=?").run(f.specification.id);
 await f.poll(f.master);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 f.db.db.prepare("UPDATE project_workspaces SET status='ready' WHERE id=?").run(f.worker.workspace);
 await f.poll(f.master);const r=await f.reviewed(p);await f.collected(p,r);const final=(await f.get()).body;assert.equal(final.status,'completed');assert.equal(final.versions[0].id,version.id);assert.equal(final.versions[0].requestHash,version.request_hash);
 assert.deepEqual(f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(original.task.id),before);
});

test('readiness recovery never restarts terminal or uncertain work and rechecks permissions and controller ownership',async t=>{
 for(const status of ['failed','blocked','cancelled','uncertain','cancel_requested']){
  const f=await fixture(t);await f.create();const c=await f.claim('produce');
  f.db.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,c.task.id);
  f.db.db.prepare("UPDATE case_versions SET status='needs_attention',error='Original case workspace is no longer ready' WHERE case_id=?").run(f.specification.id);
  f.db.db.prepare("UPDATE case_dossiers SET status='needs_attention' WHERE id=?").run(f.specification.id);
  await f.poll(f.master);assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(c.task.id).status,status);assert.equal(f.db.db.prepare('SELECT count(*) n FROM case_jobs').get().n,1);assert.equal((await f.get()).body.versions[0].status,'needs_attention');
 }
 for(const reason of ['controller','project']){
  const f=await fixture(t);await f.create();const c=await f.claim('produce');f.db.db.prepare("UPDATE project_workspaces SET status='error' WHERE id=?").run(f.worker.workspace);await f.produced(c);
  f.db.db.prepare("UPDATE case_versions SET status='needs_attention',error='No existing ready workspace for this case device' WHERE case_id=?").run(f.specification.id);f.db.db.prepare("UPDATE case_dossiers SET status='needs_attention' WHERE id=?").run(f.specification.id);
  f.db.db.prepare("UPDATE project_workspaces SET status='ready' WHERE id=?").run(f.worker.workspace);
  if(reason==='controller')f.db.db.prepare("UPDATE settings SET value=json_set(value,'$.controller',?) WHERE key='delivery_controller'").run(f.worker.id);
  else f.db.db.prepare("UPDATE nodes SET projects='[]' WHERE id=?").run(f.worker.id);
  await f.poll(f.master);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(f.db.db.prepare('SELECT status FROM case_versions WHERE case_id=?').get(f.specification.id).status,'needs_attention');
 }
});
