import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';

class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
  async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const results=items.map(i=>{const r=this.db.prepare(i.sql).run(...i.args);return {results:[],meta:{changes:Number(r.changes)}};});this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const adminToken=secret(),env={DB:db,FLEET_ADMIN_TOKEN:adminToken};
  function node(name,projects=['workspace']){const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen) VALUES(?,?,?,?,?,?)').run(id,name,hash(token),JSON.stringify(projects),name,now());return {id,token};}
  function member(role='operator'){const id=uid(),user='user-'+id,email=id+'@example.test';db.db.prepare('INSERT INTO members(id,user_id,email,role,created) VALUES(?,?,?,?,?)').run(id,user,email,role,now());db.db.prepare('UPDATE members SET group_access=? WHERE id=?').run(JSON.stringify({mode:'all',groupIds:[]}),id);return {'oai-authenticated-user-id':user,'oai-authenticated-user-email':email};}
  async function req(route,{method='GET',data,token=adminToken,identity,origin}={}) {
    const headers={...identity};if(token)headers.authorization='Bearer '+token;if(identity&&method!=='GET')headers.origin='https://fleet.example.test';if(origin)headers.origin=origin;
    if(data!==undefined)headers['content-type']='application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);return {status:r.status,body:await r.json()};
  }
  async function task(n,{mode='execute',project='workspace'}={}){const spec={id:uid(),project,targetNode:n.id,prompt:'Interactive operation',mode,outputs:[],worktree:false};assert.equal((await req('/v1/tasks',{method:'POST',data:spec})).status,200);const r=await poll(n);assert.equal(r.status,200);return r.body.tasks.find(x=>x.id===spec.id);}
  const poll=(n,events=[],ready=true)=>req('/v1/sync',{method:'POST',token:n.token,data:{events,capabilities:{ready,projects:['workspace']}}});
  const make=(task,overrides={})=>({id:uid(),attemptId:task.attempt,kind:'elicitation',method:'mcpServer/elicitation/request',request:{message:'Create a task on this computer?',mode:'form',requestedSchema:{type:'object',properties:{confirmed:{type:'boolean'},name:{type:'string',maxLength:60}},required:['confirmed'],additionalProperties:false}},expiresAt:new Date(Date.now()+600000).toISOString(),...overrides});
  const create=(n,task,b)=>req('/v1/tasks/'+task.id+'/interactions',{method:'POST',token:n.token,data:b});
  const answer=(task,b,response,identity)=>req('/v1/tasks/'+task.id+'/interactions/'+b.id+'/respond',{method:'POST',token:null,identity,data:{response}});
  const resolve=(n,task,b)=>req('/v1/tasks/'+task.id+'/interactions/'+b.id+'/resolve',{method:'POST',token:n.token,data:{attemptId:task.attempt}});
  return {db,env,adminToken,node,member,req,task,poll,make,create,answer,resolve};
}

test('execution owner creates one pending interaction and browser answer resolves without changing sandbox or task state',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n,{mode:'question'}),operator=f.member(),b=f.make(task);
  const r=await f.create(n,task,b);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'pending');assert.equal((await f.create(n,task,b)).status,200);
  assert.equal((await f.create(n,task,{...b,request:{...b.request,message:'changed'}})).status,409);
  const answer={action:'accept',content:{confirmed:true,name:'阅读主要任务'}};assert.equal((await f.answer(task,b,answer,operator)).body.status,'answered');
  const listed=await f.req('/v1/tasks/'+task.id+'/interactions',{token:n.token});assert.deepEqual(listed.body.interactions[0].response,answer);
  assert.equal((await f.resolve(n,task,b)).body.status,'resolved');assert.equal((await f.resolve(n,task,b)).body.status,'resolved');
  const row=f.db.db.prepare('SELECT status,spec FROM tasks WHERE id=?').get(task.id);assert.equal(row.status,'claimed');assert.equal(JSON.parse(row.spec).mode,'question');
  const counts=f.db.db.prepare("SELECT type,count(*) AS n FROM events WHERE type LIKE 'interaction_%' GROUP BY type").all();assert.ok(counts.every(x=>x.n===1));
});

test('node credentials and maintenance credentials cannot act as a human; viewers and cross-origin browsers cannot answer',async t=>{
  const f=fixture(t),n=f.node('PC-01'),other=f.node('PC-02'),task=await f.task(n),b=f.make(task),url='/v1/tasks/'+task.id+'/interactions/'+b.id+'/respond';await f.create(n,task,b);
  for(const token of [n.token,other.token,f.adminToken])assert.equal((await f.req(url,{method:'POST',token,data:{response:{action:'decline'}}})).status,403);
  assert.equal((await f.answer(task,b,{action:'decline'},f.member('viewer'))).status,403);
  assert.equal((await f.req(url,{method:'POST',token:null,identity:f.member(),origin:'https://evil.example',data:{response:{action:'decline'}}})).status,403);
  assert.equal((await f.create(other,task,f.make(task))).status,403);
  assert.equal((await f.create(n,task,f.make(task,{attemptId:uid()}))).status,409);
  assert.equal((await f.resolve(other,task,b)).status,403);
});

test('racing human answers are immutable and exact retries do not create duplicate answer events',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),b=f.make(task),operator=f.member();await f.create(n,task,b);
  const answers=await Promise.all([f.answer(task,b,{action:'decline'},operator),f.answer(task,b,{action:'accept',content:{confirmed:true}},operator)]);assert.deepEqual(answers.map(x=>x.status).sort(),[200,409]);
  const saved=(await f.req('/v1/tasks/'+task.id+'/interactions')).body.interactions[0];assert.equal((await f.answer(task,b,saved.response,operator)).status,200);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE type='interaction_answered'").get().n,1);
});

test('expired, terminal and replaced attempts hide unapplied responses and reject further answers or resolution',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),operator=f.member(),b=f.make(task);await f.create(n,task,b);await f.answer(task,b,{action:'decline'},operator);
  f.db.db.prepare("UPDATE task_interactions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.id);
  let item=(await f.req('/v1/tasks/'+task.id+'/interactions',{token:n.token})).body.interactions[0];assert.equal(item.status,'expired');assert.equal(item.response,null);assert.equal((await f.answer(task,b,{action:'decline'},operator)).status,409);assert.equal((await f.resolve(n,task,b)).status,409);
  const newer=f.make(task);await f.create(n,task,newer);await f.answer(task,newer,{action:'decline'},operator);f.db.db.prepare('UPDATE tasks SET attempt=? WHERE id=?').run(uid(),task.id);
  assert.equal((await f.answer(task,newer,{action:'decline'},operator)).status,409);item=(await f.req('/v1/tasks/'+task.id+'/interactions')).body.interactions.find(x=>x.id===newer.id);assert.equal(item.status,'expired');assert.equal(item.response,null);
  f.db.db.prepare("UPDATE tasks SET status='submitted',attempt=? WHERE id=?").run(task.attempt,task.id);
  assert.equal((await f.create(n,task,f.make(task))).status,409);
});

test('schemas enforce required fields and unknown constraints cannot silently broaden an accepted action',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),operator=f.member(),b=f.make(task);await f.create(n,task,b);
  assert.equal((await f.answer(task,b,{action:'accept',content:{}},operator)).status,400);
  assert.equal((await f.answer(task,b,{action:'accept',content:{confirmed:'yes'}},operator)).status,400);
  assert.equal((await f.answer(task,b,{action:'accept',content:{confirmed:true,extraPermissions:true}},operator)).status,400);
  const unsupported=f.make(task,{request:{message:'Unsupported form',requestedSchema:{type:'object',properties:{text:{type:'string',pattern:'^[A-Z]+$'}}}}});await f.create(n,task,unsupported);
  assert.equal((await f.answer(task,unsupported,{action:'accept',content:{text:'abc'}},operator)).status,409);
  assert.equal((await f.answer(task,unsupported,{action:'cancel'},operator)).status,200);
  const extra=f.make(task,{request:{message:'Safe form',token:'do-not-store',rawArgs:{secret:'do-not-store'},requestedSchema:{type:'object',properties:{okay:{type:'boolean'}}}}});await f.create(n,task,extra);
  assert.ok(!JSON.stringify((await f.req('/v1/tasks/'+task.id+'/interactions')).body).includes('do-not-store'));
});

test('delivery acknowledgement can arrive after a turn completes without allowing a new answer or a different attempt',async t=>{
  const f=fixture(t),n=f.node('PC-01'),other=f.node('PC-02'),task=await f.task(n),operator=f.member(),b=f.make(task),unanswered=f.make(task);
  await f.create(n,task,b);await f.create(n,task,unanswered);await f.answer(task,b,{action:'decline'},operator);
  f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
  assert.equal((await f.answer(task,b,{action:'decline'},operator)).status,409);assert.equal((await f.resolve(n,task,unanswered)).status,409);assert.equal((await f.resolve(other,task,b)).status,403);
  assert.equal((await f.resolve(n,task,b)).body.status,'resolved');assert.equal((await f.resolve(n,task,b)).body.status,'resolved');
  assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'submitted');
  f.db.db.prepare('UPDATE tasks SET attempt=? WHERE id=?').run(uid(),task.id);assert.equal((await f.resolve(n,task,b)).status,409);
});

test('nullable question options remain a free-text question and do not change the response schema',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),operator=f.member(),b=f.make(task,{kind:'questions',method:'item/tool/requestUserInput',request:{questions:[{id:'notes',question:'Describe the result',options:null}]}});
  const created=await f.create(n,task,b);assert.equal(created.status,200);assert.equal(created.body.request.questions[0].options,undefined);
  assert.equal((await f.answer(task,b,{answers:{notes:{answers:['The requested output is ready']}}},operator)).status,200);
});

test('URL elicitation accepts only HTTPS URLs without embedded credentials and needs an explicit human response',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),operator=f.member();
  for(const url of ['http://example.test','https://user:password@example.test'])assert.equal((await f.create(n,task,f.make(task,{request:{mode:'url',url,message:'Complete browser authorization'}}))).status,400);
  const b=f.make(task,{request:{mode:'url',url:'https://example.test/authorize',message:'Complete browser authorization'}});assert.equal((await f.create(n,task,b)).body.status,'pending');
  assert.equal((await f.answer(task,b,{action:'accept'},operator)).status,200);
});

test('question answers are scoped to the displayed question IDs and plain single-turn approvals do not expand permissions',async t=>{
  const f=fixture(t),n=f.node('PC-01'),task=await f.task(n),operator=f.member(),b=f.make(task,{kind:'questions',method:'item/tool/requestUserInput',request:{questions:[{id:'choice',question:'Choose one',options:[{label:'A',description:'A'}],isOther:true}]}});await f.create(n,task,b);
  assert.equal((await f.answer(task,b,{answers:{other:{answers:['A']}}},operator)).status,400);
  assert.equal((await f.answer(task,b,{answers:{choice:{answers:['A','B']}}},operator)).status,400);
  assert.equal((await f.answer(task,b,{answers:{choice:{answers:['custom text']}}},operator)).status,200);
  const approval=f.make(task,{kind:'approval',method:'item/commandExecution/requestApproval',request:{command:'Get-ChildItem',reason:'Read files',cwd:'D:\\project',availableDecisions:['accept','decline','cancel']}});assert.equal((await f.create(n,task,approval)).status,200);
  assert.equal((await f.answer(task,approval,{decision:'acceptForSession'},operator)).status,400);assert.equal((await f.answer(task,approval,{decision:'accept'},operator)).status,200);
  assert.equal((await f.create(n,task,f.make(task,{kind:'approval',method:'item/permissions/requestApproval',request:{reason:'new network permission'}}))).status,409);
  assert.equal((await f.create(n,task,f.make(task,{kind:'approval',method:'item/commandExecution/requestApproval',request:{additionalPermissions:{network:true}}}))).status,409);
});

test('another project cannot read interaction data or answer it through a device browser session',async t=>{
  const f=fixture(t),n=f.node('PC-01'),other=f.node('PC-02',['private']),task=await f.task(n),b=f.make(task);await f.create(n,task,b);
  assert.equal((await f.req('/v1/tasks/'+task.id+'/interactions',{token:other.token})).status,403);
  assert.equal((await f.req('/v1/tasks/'+uid()+'/interactions',{token:n.token})).status,404);
});

test('server-side maintenance blocks legacy-node claims atomically and resumes after release or expiry',async t=>{
  const f=fixture(t),n=f.node('PC-01'),spec={id:uid(),targetNode:n.id,project:'workspace',prompt:'Queued task'};
  await f.req('/v1/tasks',{method:'POST',data:spec});
  assert.equal((await f.req('/v1/node/maintenance',{method:'POST',token:n.token,data:{enabled:true,reason:'Upgrade'}})).body.enabled,true);
  assert.equal((await f.poll(n)).body.tasks.length,0);assert.equal((await f.req('/v1/nodes')).body.find(x=>x.id===n.id).maintenance.enabled,true);
  assert.equal((await f.req('/v1/node/maintenance',{method:'POST',token:n.token,data:{enabled:false}})).status,200);const active=(await f.poll(n)).body.tasks[0];assert.equal(active.id,spec.id);
  await f.req('/v1/node/maintenance',{method:'POST',token:n.token,data:{enabled:true}});const r=await f.poll(n,[{id:uid(),type:'finished',taskId:active.id,attemptId:active.attempt,status:'submitted',result:{summary:'Current turn drained'}}]);assert.equal(r.status,200);assert.equal(r.body.tasks.length,0);
  const second={...spec,id:uid()};await f.req('/v1/tasks',{method:'POST',data:second});assert.equal((await f.poll(n)).body.tasks.length,0);
  f.db.db.prepare("UPDATE node_maintenance SET expires_at='2000-01-01T00:00:00.000Z' WHERE node=?").run(n.id);assert.equal((await f.req('/v1/nodes')).body.find(x=>x.id===n.id).maintenance.enabled,false);assert.equal((await f.poll(n)).body.tasks[0].id,second.id);
});

test('maintenance is credential-bound, bounded to one hour and cannot freeze a different node',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02');
  assert.equal((await f.req('/v1/node/maintenance',{method:'POST',data:{enabled:true}})).status,403);
  assert.equal((await f.req('/v1/node/maintenance',{method:'POST',token:a.token,data:{enabled:true,expiresAt:new Date(Date.now()+7200000).toISOString()}})).status,400);
  assert.equal((await f.req('/v1/node/maintenance',{method:'POST',token:a.token,data:{enabled:true,nodeId:b.id}})).status,200);
  assert.equal(f.db.db.prepare('SELECT node FROM node_maintenance').get().node,a.id);
});
