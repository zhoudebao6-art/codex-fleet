import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';
import {advanceAutomations,automationTaskId} from '../orchestration.mjs';

class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
  async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const results=items.map(i=>{const r=this.db.prepare(i.sql).run(...i.args);return {results:[],meta:{changes:Number(r.changes)}};});this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class MemoryR2 {constructor(){this.objects=new Map();}async put(key,data){this.objects.set(key,Buffer.from(data));return {key};}async get(key,options){let b=this.objects.get(key);if(!b)return null;if(options?.range)b=b.subarray(options.range.offset,options.range.offset+options.range.length);return {body:new Response(b).body,size:b.length};}}
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const adminToken=secret(),env={DB:db,BUCKET:new MemoryR2(),FLEET_ADMIN_TOKEN:adminToken};
  function node(name,projects=['workspace'],capabilities={localExecutionPolicy:true,workspaceExecution:true}){const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities) VALUES(?,?,?,?,?,?,?)').run(id,name,hash(token),JSON.stringify(projects),name,now(),JSON.stringify(capabilities));return {id,token,projects,capabilities};}
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
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('parallel collaboration starts separate work in the same project and respects a changed device limit',async t=>{
  const f=fixture(t),n=f.node('parallel-PC',undefined,{parallelExecution:true,maxRunning:8});
  const tasks=[0,1,2,3,4].map(i=>({id:uid(),targetNode:n.id,project:'workspace',prompt:'Independent output '+i,worktree:false,outputs:['output-'+i+'.txt']}));
  for(const data of tasks)assert.equal((await f.req('/v1/tasks',{method:'POST',data})).status,200);
  for(let i=0;i<5;i++)await f.poll(n);
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='claimed'").get().n,4);
  const edit=await f.req('/v1/nodes/'+n.id,{method:'PATCH',data:{parallelLimit:6}});assert.equal(edit.status,200);assert.equal(edit.body.parallelLimit,6);
  await f.poll(n);assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='claimed'").get().n,5);
});
test('a known conflicting output waits while independent files start concurrently',async t=>{
  const f=fixture(t),n=f.node('output-PC',undefined,{parallelExecution:true,maxRunning:4});
  for(const file of ['result.txt','RESULT.TXT','other.txt'])await f.req('/v1/tasks',{method:'POST',data:{id:uid(),targetNode:n.id,project:'workspace',prompt:'produce '+file,worktree:false,outputs:[file]}});
  await f.poll(n);await f.poll(n);await f.poll(n);
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='claimed'").get().n,2);
});

test('new desktop conversations respect shared execution capacity and stay out of collaboration history',async t=>{
  const f=fixture(t),n=f.node('PC-01',undefined,{desktopSessionBridge:true,conversationDispatch:true,conversationReady:true,conversationSlots:2,localExecutionPolicy:true});
  const work={id:uid(),targetNode:n.id,project:'workspace',prompt:'Long work order',worktree:false};
  await f.req('/v1/tasks',{method:'POST',data:work});const original=(await f.poll(n)).body.tasks[0];assert.equal(original.id,work.id);
  const conversations=[0,1,2].map(i=>({id:uid(),targetNode:n.id,project:'workspace',prompt:'你好'+i,intent:'conversation',requireDesktop:true,worktree:false}));
  for(const data of conversations)assert.equal((await f.req('/v1/tasks',{method:'POST',data})).status,200);
  await f.poll(n,[],false);await f.poll(n,[],false);const result=await f.poll(n,[],false);
  assert.equal(result.body.tasks.length,1);assert.equal(result.body.tasks[0].attempt,original.attempt);
  f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(work.id);
  const resumed=await f.poll(n,[],false);assert.equal(resumed.body.tasks.length,1);assert.equal(resumed.body.tasks[0].spec.intent,'conversation');
  assert.equal((await f.req('/v1/tasks/'+conversations[2].id)).body.status,'queued');
  const list=await f.req('/v1/tasks/page?source=collaboration');assert.deepEqual(list.body.tasks.map(t=>t.id),[work.id]);
  const old=f.node('legacy');assert.equal((await f.req('/v1/tasks',{method:'POST',data:{...conversations[0],id:uid(),targetNode:old.id}})).body.code,'NODE_UPGRADE_REQUIRED');
});

test('managed parallel production persists all branches and collects verified outputs after the controller disconnects',async t=>{
  const f=fixture(t),nodes=[0,1,2].map(i=>f.node('P'+i,undefined,{localExecutionPolicy:true,desktopSessionBridge:true,parallelExecution:true,conversationDispatch:true,ready:true})),spec=f.spec([...nodes,nodes[0]]);
  spec.executionMode='parallel';
  spec.steps.forEach((s,i)=>{s.dependsOn=i===3?spec.steps.slice(0,3).map(x=>x.key):[];s.outputs=['result.txt'];});
  const created=await f.create(spec);assert.equal(created.status,200,JSON.stringify(created.body));
  assert.deepEqual(created.body.steps.map(s=>s.status),['queued','queued','queued','planned']);
  const runs=await Promise.all(nodes.map(async n=>(await f.poll(n)).body.tasks[0]));
  for(let i=0;i<3;i++){await f.output(nodes[i],runs[i],'result.txt','output-'+i);assert.equal((await f.finish(nodes[i],runs[i])).status,200);}
  await Promise.all(Array.from({length:5},()=>advanceAutomations(f.db,{flowId:spec.id})));
  const collect=(await f.poll(nodes[0])).body.tasks[0];
  assert.equal(collect.id,automationTaskId(spec.id,3));
  assert.deepEqual(collect.spec.inputs.map(f=>f.name),['step-0/result.txt','step-1/result.txt','step-2/result.txt']);
  assert.equal(collect.spec.requireDesktop,true);
  assert.equal((await f.finish(nodes[0],collect)).status,409,'missing collection output must not complete a flow');
  await f.output(nodes[0],collect,'result.txt','verified collection');await f.finish(nodes[0],collect);
  const done=(await f.get(spec.id)).body;assert.equal(done.status,'completed');assert.equal(done.result.artifacts.length,1);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,4);
});
test('parallel flow fails before creating any task until every desktop executor is compatible and ready',async t=>{
  const f=fixture(t),node=f.node('P'),spec=f.spec([node,node]);spec.executionMode='parallel';
  spec.steps[0].dependsOn=[];spec.steps[1].dependsOn=['step-0'];spec.steps[1].outputs=['final.txt'];
  let result=await f.create(spec);assert.equal(result.status,409);assert.equal(result.body.code,'AUTOMATION_TARGET_NOT_READY');
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM automation_flows').get().n,0);
  Object.assign(node.capabilities,{parallelExecution:true,desktopSessionBridge:true,conversationDispatch:false,ready:true});
  await f.poll(node);result=await f.create(spec);assert.match(result.body.error,/消息组件未激活/);
  node.capabilities.conversationDispatch=true;await f.poll(node);
  assert.equal((await f.create(spec)).status,200);assert.equal((await f.poll(node)).body.tasks.length,1);
  // A lost creation response must be recoverable even after a later disconnect.
  f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run('2000-01-01',node.id);
  assert.equal((await f.create(spec)).status,200);
  const duplicate={...spec,id:uid()};assert.equal((await f.create(duplicate)).status,409);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM automation_flows').get().n,1);
  const invalid={...spec,id:uid(),steps:spec.steps.map(s=>({...s,dependsOn:[]}))};
  assert.equal((await f.create(invalid)).status,400);
});
test('controller acceptance cannot hide unfinished child work',async t=>{
  const f=fixture(t),n=f.node('P'),parent={id:uid(),targetNode:n.id,project:'workspace',prompt:'controller'};
  assert.equal((await f.req('/v1/tasks',{method:'POST',data:parent})).status,200);
  f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(parent.id);
  assert.equal((await f.req('/v1/tasks',{method:'POST',data:{...parent,id:uid(),prompt:'child',parentId:parent.id}})).status,200);
  const accepted=await f.req('/v1/tasks/'+parent.id+'/accept',{method:'POST',data:{note:'all done'}});
  assert.equal(accepted.status,409);assert.match(accepted.body.error,/未完成/);
});

test('three simulated node identities execute sequentially and hand over checked file bytes plus summaries without implicit acceptance',async t=>{
  const f=fixture(t),nodes=[f.node('PC-01'),f.node('PC-02'),f.node('PC-03')],spec=f.spec(nodes);spec.steps[0].outputs=['build/code.txt'];spec.steps[1].outputs=['reviews/review.txt'];
  const created=await f.create(spec);assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.steps[0].status,'queued');assert.equal(created.body.steps[1].status,'planned');
  const first=(await f.poll(nodes[0])).body.tasks[0];assert.equal(first.spec.executionPolicy,'local');const build=await f.output(nodes[0],first,'build/code.txt','real source artifact');
  assert.equal((await f.finish(nodes[0],first,'submitted','Build result with concrete evidence')).status,200);assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(first.id).status,'submitted');
  const second=(await f.poll(nodes[1])).body.tasks[0];assert.deepEqual(second.spec.inputs,[build]);assert.match(second.spec.prompt,/Build result with concrete evidence/);assert.deepEqual(second.spec.dependencies,[]);
  const downloaded=await f.req('/v1/artifacts/'+build.sha+'?task='+second.id,{token:nodes[1].token});assert.equal(downloaded.body.toString(),'real source artifact');
  const review=await f.output(nodes[1],second,'reviews/review.txt','checked source and noted review');await f.finish(nodes[1],second,'submitted','Review complete');
  const third=(await f.poll(nodes[2])).body.tasks[0];assert.deepEqual(third.spec.inputs,[review]);await f.finish(nodes[2],third,'submitted','Final integrated summary');
  const done=(await f.get(spec.id)).body;assert.equal(done.status,'completed');assert.equal(done.result.summary,'Final integrated summary');assert.ok(done.steps.every(s=>s.status==='submitted'));assert.equal(f.db.db.prepare("SELECT count(*) n FROM tasks WHERE status='accepted'").get().n,0);
});

test('concurrent scheduler ticks dispatch a single stable next task and preserve the exact prepared spec',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);await f.create(spec);const active=(await f.poll(a)).body.tasks[0];
  f.db.db.prepare("UPDATE tasks SET status='submitted',result=? WHERE id=?").run(JSON.stringify({summary:'Stable prior summary'}),active.id);
  await Promise.all(Array.from({length:12},()=>advanceAutomations(f.db,{flowId:spec.id})));
  const row=f.db.db.prepare('SELECT prepared_spec,prepared_hash,task_id FROM automation_steps WHERE flow=? AND step_index=1').get(spec.id),task=f.db.db.prepare('SELECT spec,spec_hash FROM tasks WHERE id=?').get(row.task_id);
  assert.equal(row.prepared_spec,task.spec);assert.equal(row.prepared_hash,task.spec_hash);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE type='submitted'").get().n,2);
});

test('crash between preparation and submission reuses frozen handoff bytes, and lost submission acknowledgement cannot duplicate execution',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);await f.create(spec);const active=(await f.poll(a)).body.tasks[0],original=f.db.batch.bind(f.db);let fail=true;
  f.db.batch=async statements=>{if(fail&&statements.some(s=>s.sql.startsWith('INSERT OR IGNORE INTO tasks'))){fail=false;throw new Error('simulated storage response loss before insert');}return original(statements);};
  await f.finish(a,active,'submitted','frozen summary v1');const prepared=f.db.db.prepare('SELECT prepared_spec FROM automation_steps WHERE flow=? AND step_index=1').get(spec.id).prepared_spec;assert.match(prepared,/frozen summary v1/);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  f.db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify({summary:'later changed summary v2'}),active.id);let lostAck=true;
  f.db.batch=async statements=>{const result=await original(statements);if(lostAck&&statements.some(s=>s.sql.startsWith('INSERT OR IGNORE INTO tasks'))){lostAck=false;throw new Error('simulated acknowledgement loss after commit');}return result;};
  await advanceAutomations(f.db,{flowId:spec.id});await advanceAutomations(f.db,{flowId:spec.id});
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);const task=f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(automationTaskId(spec.id,1));assert.equal(task.spec,prepared);assert.doesNotMatch(task.spec,/summary v2/);assert.equal((await f.get(spec.id)).body.status,'running');
});

test('pause stops queued claims, lets the current attempt finish, and resumes with exactly one next task',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);await f.create(spec);await f.action(spec.id,'pause');assert.equal((await f.poll(a)).body.tasks.length,0);
  await f.action(spec.id,'resume');const first=(await f.poll(a)).body.tasks[0];await f.action(spec.id,'pause');await f.finish(a,first);assert.equal((await f.get(spec.id)).body.status,'paused');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  await f.action(spec.id,'resume');assert.equal((await f.poll(b)).body.tasks.length,1);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});

test('pause or cancellation racing the dispatch write cannot create an executable orphan task',async t=>{
  for(const action of ['pause','cancel']) {
    const f=fixture(t),a=f.node('PC-'+action+'-01'),b=f.node('PC-'+action+'-02'),spec=f.spec([a,b]),reached=gate(),release=gate(),original=f.db.batch.bind(f.db);let held=false;
    f.db.batch=async statements=>{if(!held&&statements.some(s=>s.sql.startsWith('INSERT OR IGNORE INTO tasks'))){held=true;reached.resolve();await release.promise;}return original(statements);};
    const creation=f.create(spec);await reached.promise;assert.equal((await f.action(spec.id,action)).status,200);release.resolve();assert.equal((await creation).status,200);
    assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,0);assert.equal((await f.poll(a)).body.tasks.length,0);assert.equal((await f.get(spec.id)).body.status,action==='pause'?'paused':'cancelled');
  }
});

test('cancellation requests the active attempt to stop and never dispatches the next step',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);await f.create(spec);const active=(await f.poll(a)).body.tasks[0];
  assert.equal((await f.action(spec.id,'cancel')).body.status,'cancelling');assert.equal((await f.poll(a)).body.tasks[0].status,'cancel_requested');await f.action(spec.id,'cancel');
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE id LIKE 'automation-cancel:%'").get().n,1);
  await f.finish(a,active,'submitted','Late result after cancellation');assert.equal((await f.get(spec.id)).body.status,'cancelled');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal((await f.action(spec.id,'resume')).status,409);
});

test('failed, blocked and uncertain attempts require attention and cannot be blindly repeated by resume',async t=>{
  for(const status of ['failed','blocked','uncertain']) {
    const f=fixture(t),a=f.node('PC-'+status+'-01'),b=f.node('PC-'+status+'-02'),spec=f.spec([a,b]);await f.create(spec);const active=(await f.poll(a)).body.tasks[0];
    if(status==='uncertain')await f.poll(a,[{id:uid(),type:'uncertain',taskId:active.id,attemptId:active.attempt}],false);else await f.finish(a,active,status,'Needs inspection');
    assert.equal((await f.get(spec.id)).body.status,'needs_attention');assert.equal((await f.action(spec.id,'resume')).status,409);await f.poll(b);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  }
});

test('missing or ambiguous declared outputs stop the handoff even if a task record says submitted',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);spec.steps[0].outputs=['report.txt'];await f.create(spec);const active=(await f.poll(a)).body.tasks[0];
  assert.equal((await f.finish(a,active)).status,409);f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(active.id);await advanceAutomations(f.db,{flowId:spec.id});assert.equal((await f.get(spec.id)).body.status,'needs_attention');assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  f.db.db.prepare("UPDATE tasks SET status='claimed' WHERE id=?").run(active.id);await f.output(a,active,'report.txt','version A');await f.output(a,active,'report.txt','version B');f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(active.id);
  await f.action(spec.id,'resume');assert.equal((await f.get(spec.id)).body.status,'needs_attention');assert.match((await f.get(spec.id)).body.error,/ambiguous/);assert.equal(f.db.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
});

test('all declarations are validated before creation and stable IDs cannot change their requests or reserve an existing task',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);assert.equal((await f.create({...spec,steps:[spec.steps[0]]})).status,400);
  const duplicate={...spec,steps:[{...spec.steps[0],outputs:['Report.txt','report.TXT']},spec.steps[1]]};assert.equal((await f.create(duplicate)).status,400);
  assert.equal((await f.create({...spec,steps:[{...spec.steps[0],workspaceId:'missing'},spec.steps[1]]})).status,404);assert.equal(f.db.db.prepare('SELECT count(*) n FROM automation_flows').get().n,0);
  assert.equal((await f.create(spec)).status,200);assert.equal((await f.create(spec)).status,200);assert.equal((await f.create({...spec,name:'Changed declaration'})).status,409);
  const colliding=f.spec([a,b]);await f.req('/v1/tasks',{method:'POST',data:{id:automationTaskId(colliding.id,0),targetNode:a.id,project:'workspace',prompt:'existing manual task'}});assert.equal((await f.create(colliding)).status,409);
  assert.equal((await f.req('/v1/tasks',{method:'POST',data:{id:automationTaskId(spec.id,1),targetNode:b.id,project:'workspace',prompt:'hijack reserved future task'}})).status,409);
});

test('node controllers retain project scope, viewers cannot dispatch, and only creator or admin can control a flow',async t=>{
  const f=fixture(t),owner=f.node('controller'),a=f.node('PC-01'),other=f.node('other'),privateNode=f.node('private',['private']),spec=f.spec([a,a]);
  assert.equal((await f.create({...spec,steps:[spec.steps[0],{...spec.steps[1],targetNode:privateNode.id}]},{token:owner.token})).status,403);
  assert.equal((await f.create(spec,{token:null,identity:f.member('viewer')})).status,403);
  assert.equal((await f.create(spec,{token:owner.token})).status,200);assert.equal(f.db.db.prepare('SELECT creator FROM tasks').get().creator,owner.id);
  assert.equal((await f.req('/v1/automations/'+spec.id,{token:owner.token})).body.canManage,true);assert.equal((await f.req('/v1/automations/'+spec.id,{token:other.token})).body.canManage,false);
  assert.equal((await f.req('/v1/automations/'+spec.id,{token:null,identity:f.member('viewer')})).body.canManage,false);assert.equal((await f.get(spec.id)).body.canManage,true);
  assert.equal((await f.req('/v1/automations',{token:other.token})).body.automations[0].canManage,false);
  assert.equal((await f.req('/v1/automations/'+spec.id,{token:privateNode.token})).status,403);assert.equal((await f.action(spec.id,'pause',{token:other.token})).status,403);assert.equal((await f.action(spec.id,'pause',{token:owner.token})).status,200);
});

test('owner revocation racing claim is checked in the same SQL write rather than a stale scheduler read',async t=>{
  const f=fixture(t),owner=f.node('controller'),a=f.node('PC-01'),b=f.node('PC-02'),spec=f.spec([a,b]);await f.create(spec,{token:owner.token});const original=f.db.batch.bind(f.db);let revoked=false;
  f.db.batch=async statements=>{if(!revoked&&statements.some(s=>s.sql.includes("UPDATE tasks SET status='claimed'"))){revoked=true;f.db.db.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(owner.id);}return original(statements);};
  assert.equal((await f.poll(a)).body.tasks.length,0);assert.equal(revoked,true);await advanceAutomations(f.db,{flowId:spec.id});assert.equal((await f.get(spec.id)).body.status,'needs_attention');
});

test('bounded heartbeat scheduler rotates across more than ten waiting flows fairly',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),ids=[];for(let i=0;i<12;i++){const spec=f.spec([a,b]);ids.push(spec.id);assert.equal((await f.create(spec)).status,200);f.db.db.prepare('UPDATE automation_flows SET last_checked_at=? WHERE id=?').run(new Date(1000+i).toISOString(),spec.id);}
  const first=await advanceAutomations(f.db,{limit:10}),second=await advanceAutomations(f.db,{limit:10});assert.equal(first.length,10);assert.equal(second.length,10);assert.equal(new Set([...first,...second].map(x=>x.id)).size,12);
});

test('local execution policy is explicit, execute-only, and cannot be ignored by a legacy node',async t=>{
  const f=fixture(t),old=f.node('old',['workspace'],{}),fresh=f.node('new'),spec=f.spec([old,fresh]);assert.equal((await f.create(spec)).status,409);
  assert.equal((await f.req('/v1/tasks',{method:'POST',data:{id:uid(),targetNode:old.id,project:'workspace',mode:'execute',executionPolicy:'local',prompt:'Use local policy'}})).status,409);
  assert.equal((await f.req('/v1/tasks',{method:'POST',data:{id:uid(),targetNode:fresh.id,project:'workspace',mode:'question',executionPolicy:'local',prompt:'Read only'}})).status,400);
  spec.steps=spec.steps.map(s=>({...s,mode:'question',executionPolicy:'project'}));assert.equal((await f.create(spec)).status,200);assert.equal((await f.poll(old)).body.tasks.length,1);
  const localTask={id:uid(),targetNode:fresh.id,project:'workspace',mode:'execute',executionPolicy:'local',prompt:'Use configured policy'};assert.equal((await f.req('/v1/tasks',{method:'POST',data:localTask})).status,200);fresh.capabilities={};assert.equal((await f.poll(fresh)).body.tasks.length,0);
});
