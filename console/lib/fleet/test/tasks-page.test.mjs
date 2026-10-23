import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';
import {taskStats,attentionStats,tasksPage,changeTask,taskDetail} from '../tasks.mjs';

class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
  async batch(items){this.db.exec("BEGIN");try{const results=[];for(const item of items)results.push(await item.run());this.db.exec("COMMIT");return results;}catch(e){this.db.exec("ROLLBACK");throw e;}}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
}
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const token=secret(),env={DB:db,FLEET_ADMIN_TOKEN:token};
  const node=(projects=['workspace'])=>{const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group) VALUES(?,?,?,?,?)').run(id,id,hash(token),JSON.stringify(projects),id);return {id,token};};
  const add=(target,i,extra={})=>{const row={id:'task-'+String(i).padStart(5,'0'),project:'workspace',status:'submitted',created:new Date(Date.UTC(2026,9,19,0,0,Math.floor(i/5))).toISOString(),prompt:'Task '+i,...extra},spec={id:row.id,project:row.project,targetNode:target.id,prompt:row.prompt};db.db.prepare('INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,'admin',target.id,row.project,row.status,JSON.stringify(spec),hash(JSON.stringify(spec)),row.created,row.created);return row;};
  const req=async(route,auth=token)=>{const r=await handle(new Request('https://fleet.example.test'+route,{headers:auth?{authorization:'Bearer '+auth}:{}}),env);return {status:r.status,body:await r.json()};};
  return {db,node,add,req};
}

test('task directory covers more than 500 records with deterministic tie pagination and preserves the legacy array',async t=>{
  const f=fixture(t),n=f.node();for(let i=0;i<611;i++)f.add(n,i);
  const legacy=await f.req('/v1/tasks');assert.equal(legacy.body.length,500);assert.ok(Array.isArray(legacy.body));
  const ids=[];let cursor=null,pages=0;do {const r=await f.req('/v1/tasks/page?limit=73'+(cursor?'&cursor='+cursor:''));assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,611);assert.ok(r.body.serverTime);ids.push(...r.body.tasks.map(x=>x.id));cursor=r.body.nextCursor;assert.ok(++pages<20);}while(cursor);
  assert.equal(ids.length,611);assert.equal(new Set(ids).size,611);assert.deepEqual(ids,[...ids].sort().reverse());
});

test('cursor binding prevents cross-scope and changed-filter reuse while fresh insertions do not duplicate old pages',async t=>{
  const f=fixture(t),a=f.node(),b=f.node(['private']);for(let i=0;i<9;i++)f.add(a,i);f.add(b,10,{project:'private'});
  const first=(await f.req('/v1/tasks/page?limit=3',a.token)).body;assert.equal(first.total,9);assert.equal((await f.req('/v1/tasks/page?limit=3&cursor='+first.nextCursor,b.token)).status,400);
  assert.equal((await f.req('/v1/tasks/page?limit=3&status=submitted&cursor='+first.nextCursor,a.token)).status,400);
  f.add(a,12,{created:now()});const next=(await f.req('/v1/tasks/page?limit=3&cursor='+first.nextCursor,a.token)).body;
  assert.ok(next.tasks.every(x=>!first.tasks.some(y=>x.id===y.id)));assert.ok(!next.tasks.some(x=>x.id==='task-00012'));assert.equal(next.total,10);
  assert.equal((await f.req('/v1/tasks/page',null)).status,401);
});

test('task search treats SQL wildcards literally and combines target and status filters',async t=>{
  const f=fixture(t),a=f.node(),b=f.node();f.add(a,0,{prompt:'100% done_under',status:'running'});f.add(a,1,{prompt:'100 percent done-under'});f.add(b,2,{prompt:'100% done_under',status:'running'});
  const r=await f.req('/v1/tasks/page?target='+a.id+'&status=running&q='+encodeURIComponent('% done_'));assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,1);assert.equal(r.body.tasks[0].id,'task-00000');
  for(const suffix of ['limit=101','limit=NaN','limit=1.5','status=active','target=bad!','cursor=not-json','q='+encodeURIComponent('x'.repeat(301))])assert.equal((await f.req('/v1/tasks/page?'+suffix)).status,400,suffix);
});

test('overview counts include old active and submitted tasks outside the latest slice, with project-scoped node totals',async t=>{
  const f=fixture(t),a=f.node(),b=f.node(['private']);for(let i=0;i<612;i++)f.add(a,i,{status:i<4?'running':i<8?'claimed':i<12?'submitted':'accepted'});f.add(b,700,{project:'private',status:'running'});
  const r=await f.req('/api/console/overview?limit=100');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.tasks.length,100);assert.equal(r.body.tasks.filter(x=>['running','claimed'].includes(x.status)).length,1);
  assert.equal(r.body.taskStats.total,613);assert.equal(r.body.taskStats.byStatus.running,5);assert.equal(r.body.taskStats.byStatus.claimed,4);assert.equal(r.body.taskStats.byStatus.submitted,4);
  assert.deepEqual(r.body.taskStats.byNode.find(x=>x.nodeId===a.id),{nodeId:a.id,total:612,byStatus:{accepted:600,claimed:4,running:4,submitted:4}});
  const scoped=await taskStats(f.db,{id:a.id,admin:false,browser:false,projects:JSON.stringify(['workspace'])});assert.equal(scoped.total,612);assert.equal(scoped.byStatus.running,4);assert.equal(scoped.byNode.length,1);assert.equal(scoped.byNode[0].nodeId,a.id);
});


test('action inbox excludes history, restricts device ownership and preserves human group ACL',async t=>{
 const f=fixture(t),a=f.node(),b=f.node();
 for(const [i,status] of ['blocked','uncertain','submitted','accepted','failed','running','cancelled'].entries()){f.add(a,i,{status});f.add(b,20+i,{status});}
 const actor={id:'device:'+a.id,nodeId:a.id,kind:'device',browser:true,admin:false,role:'operator',projects:'["workspace"]',access:{mode:'all',groupIds:[]}};
 const page=category=>tasksPage(f.db,actor,new URL('https://fleet.test/v1/tasks/page?attention='+category));
 assert.deepEqual((await page('action')).tasks.map(x=>x.status).sort(),['blocked','uncertain']);
 assert.ok((await page('action')).tasks.every(x=>x.target===a.id));
 assert.equal((await page('confirm')).total,0);
 f.db.db.prepare("UPDATE tasks SET creator=? WHERE status='submitted'").run(actor.id);
 assert.equal((await page('confirm')).total,1);
 assert.deepEqual(await attentionStats(f.db,actor),{action:2,confirm:1,total:3,nodeId:a.id,byNode:[{nodeId:a.id,action:2,confirm:1,total:3}]});
 assert.equal((await tasksPage(f.db,{...actor,role:'viewer'},new URL('https://fleet.test/v1/tasks/page?attention=action'))).total,0);
 const human={id:'member:tester',browser:true,role:'operator',admin:false,access:{mode:'all',groupIds:[]}};
 assert.equal((await attentionStats(f.db,human)).total,0);
 const admin={id:'admin',admin:true,role:'admin'};
 assert.equal((await attentionStats(f.db,admin)).total,6);
 assert.equal((await tasksPage(f.db,{...human,admin:true,role:'admin'},new URL('https://fleet.test/v1/tasks/page?attention=action&target='+a.id))).total,2);
 const denied={...human,access:{mode:'groups',groupIds:[]}};
 assert.equal((await attentionStats(f.db,denied)).total,0);
});

test('blocked cancellation is durable and repeatable; running or uncertain execution waits for the worker',async t=>{
 const f=fixture(t),a=f.node(),b=f.node(),admin={id:'admin',admin:true,role:'admin'};
 const blocked=f.add(a,0,{status:'blocked'}),running=f.add(a,1,{status:'running'}),uncertain=f.add(a,2,{status:'uncertain'});
 f.db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify({summary:'Preserve evidence'}),blocked.id);
 const stranger={id:b.id,admin:false,browser:false,role:'node',projects:'["workspace"]'};
 await assert.rejects(changeTask(f.db,stranger,blocked.id,'cancel',{}),/Cannot cancel/);
 assert.equal((await changeTask(f.db,admin,blocked.id,'cancel',{})).status,'cancelled');
 assert.equal((await changeTask(f.db,admin,blocked.id,'cancel',{})).status,'cancelled');
 assert.equal((await taskDetail(f.db,admin,blocked.id)).result.summary,'Preserve evidence');
 for(const row of [running,uncertain])assert.equal((await changeTask(f.db,admin,row.id,'cancel',{})).status,'cancel_requested');
 assert.equal((await attentionStats(f.db,admin)).total,0);
});

test('only current unanswered approvals are actionable and pagination cannot cross attention categories',async t=>{
 const f=fixture(t),a=f.node();for(let i=0;i<4;i++)f.add(a,i,{status:'blocked'});
 const actor={id:'admin',admin:true,role:'admin',browser:true};
 const first=await tasksPage(f.db,actor,new URL('https://fleet.test/v1/tasks/page?attention=action&limit=2'));
 assert.equal(first.total,4);assert.ok(first.nextCursor);
 await assert.rejects(tasksPage(f.db,actor,new URL('https://fleet.test/v1/tasks/page?attention=confirm&limit=2&cursor='+first.nextCursor)),/Invalid task cursor/);
 const row=f.add(a,10,{status:'running'}),attempt='attempt-current';f.db.db.prepare('UPDATE tasks SET attempt=? WHERE id=?').run(attempt,row.id);
 const insert=(id,at,status,expires)=>f.db.db.prepare("INSERT INTO task_interactions(id,task,node,attempt,kind,method,request,request_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,row.id,a.id,at,'approval','item/commandExecution/requestApproval','{}',id,status,expires,now());
 insert('expired',attempt,'pending','2020-01-01T00:00:00Z');insert('old','old-attempt','pending','2099-01-01T00:00:00Z');insert('answered',attempt,'answered','2099-01-01T00:00:00Z');
 assert.equal((await attentionStats(f.db,actor)).action,4);
 insert('current',attempt,'pending','2099-01-01T00:00:00Z');assert.equal((await attentionStats(f.db,actor)).action,5);
});
