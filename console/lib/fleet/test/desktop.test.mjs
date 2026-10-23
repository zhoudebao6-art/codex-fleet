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
  function node(name,projects=['workspace']){const id=uid(),token=secret();db.db.prepare("INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen) VALUES(?,?,?,?,?,?)").run(id,name,hash(token),JSON.stringify(projects),'same-login',now());return {id,token,projects};}
  async function req(route,{method='GET',data,token=adminToken,identity,origin}={}) {
    const headers={...identity};if(token)headers.authorization='Bearer '+token;if(origin)headers.origin=origin;
    if(data!==undefined)headers['content-type']='application/json';
    const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
    return {status:r.status,body:await r.json()};
  }
  const sync=(node,threads,extra={})=>req('/v1/desktop/sync',{method:'POST',token:node.token,data:{threads,inventory:{scannedAt:now(),complete:true,count:threads.length},...extra}});
  return {db,env,adminToken,node,req,sync};
}
const date=(ms=0)=>new Date(Date.now()+ms).toISOString();
function thread(extra={}) {return {threadId:uid(),title:'真实电脑任务',preview:'准备数据并检查结果',project:'workspace',cwd:'D:\\工作\\项目',updatedAt:date(-2000),observedAt:date(-1000),status:'running',statusSource:'app_server_runtime',source:'cli',archived:false,...extra};}
const detailRoute=(node,item)=>'/v1/desktop/threads/'+node.id+'/'+item.threadId;

test('shared-desktop message targets the running original thread and is not a collaboration work order',async t=>{
  const f=fixture(t),n=f.node('PC-01'),item=thread(),caps={desktopContinuation:true,desktopSessionBridge:true,conversationDispatch:true,conversationReady:true,conversationSlots:4,projects:['workspace']};
  await f.sync(n,[item]);f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(caps),n.id);
  const original=uid();f.db.db.prepare("INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,thread_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)").run(original,'admin',n.id,'workspace','running',JSON.stringify({prompt:'original'}),'hash',item.threadId,now(),now());
  const message={id:uid(),prompt:'请继续原来的内容'},response=await f.req(detailRoute(n,item)+'/message',{method:'POST',data:message});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.spec.desktopThreadId,item.threadId);
  assert.deepEqual(Object.keys(response.body.spec).sort(),['id','targetNode','project','prompt','mode','worktree','desktopThreadId','desktopCwd'].sort(),'Native messages must match the node strict continuation contract');
  assert.equal((await f.req(detailRoute(n,item)+'/message',{method:'POST',data:message})).body.id,message.id);
  const list=await f.req('/v1/tasks/page?source=collaboration');assert.deepEqual(list.body.tasks.map(t=>t.id),[original]);
  const local=await f.req('/v1/desktop/threads?source=conversations');assert.equal(local.body.threads.length,0);
  const all=await f.req('/v1/desktop/threads');assert.equal(all.body.threads.length,1,'Collaboration desktop history remains accessible through all-source reads');
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify({...caps,parallelExecution:true,conversationDispatch:false}),n.id);
  const blocked=await f.req(detailRoute(n,item)+'/message',{method:'POST',data:{id:uid(),prompt:'Do not send until the new desktop bridge is active'}});
  assert.equal(blocked.status,409);assert.equal(blocked.body.code,'DESKTOP_CONNECTION_ACTIVATION_REQUIRED');
});

test('desktop sync requires a node identity and rejects an entire invalid batch before writing',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),good=thread();
  assert.equal((await f.req('/v1/desktop/threads',{token:null})).status,401);
  assert.equal((await f.req('/v1/desktop/sync',{method:'POST',data:{threads:[good]}})).status,403);
  assert.equal((await f.sync(a,[good],{nodeId:b.id})).status,403);
  assert.equal((await f.sync(a,[good,thread({project:'unauthorized'})])).status,403);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM desktop_threads').get().n,0);
  assert.equal((await f.sync(a,[good,good])).status,400);
  assert.equal((await f.sync(a,Array.from({length:21},()=>thread()))).status,400);
  assert.equal((await f.sync(a,[thread({observedAt:date(3600000)})])).status,400);
  assert.equal((await f.sync(a,[good])).status,200);
});

test('identical thread IDs on same-account computers remain separate; retry is idempotent and omitted rows remain',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),item=thread(),older=thread({archived:true});
  assert.equal((await f.sync(a,[item,older])).status,200);assert.equal((await f.sync(a,[item])).status,200);
  assert.equal((await f.sync(b,[{...item,title:'另一台电脑的同ID任务'}])).status,200);
  const list=await f.req('/v1/desktop/threads');assert.equal(list.status,200);assert.equal(list.body.total,3);
  assert.equal(list.body.threads.filter(x=>x.threadId===item.threadId).length,2);
  assert.equal((await f.req('/v1/desktop/threads?archived=true')).body.total,1);
  assert.equal((await f.req('/v1/desktop/threads?archived=false')).body.total,2);
});

test('older observations cannot overwrite newer content and metadata updates preserve details and pins',async t=>{
  const f=fixture(t),a=f.node('PC-01'),item=thread({detailUpdatedAt:date(-1500),latestUserMessage:'用户要求',latestAssistantMessage:'已处理',activities:[{id:'a',type:'assistant_message',text:'已处理',at:date(-1500)}]});
  await f.sync(a,[item]);assert.equal((await f.req(detailRoute(a,item)+'/pin',{method:'POST',data:{pinned:true}})).status,200);
  await f.sync(a,[{...item,observedAt:date(-10000),title:'迟到旧标题',latestAssistantMessage:'旧结果'}]);
  await f.sync(a,[{threadId:item.threadId,project:'workspace',title:item.title,observedAt:now(),updatedAt:item.updatedAt,status:'completed'}]);
  const d=await f.req(detailRoute(a,item));assert.equal(d.body.title,item.title);assert.equal(d.body.latestAssistantMessage,'已处理');assert.equal(d.body.pinned,true);assert.equal(d.body.status,'completed');
  assert.equal(d.body.messages[0].text,'已处理');assert.equal(d.body.detailPending,false);
});

test('keyset pagination covers more than 100 rows exactly once with tied timestamps and query-bound cursors',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),items=Array.from({length:137},(_,i)=>thread({threadId:'thread-'+String(i).padStart(3,'0'),title:i===0?'literal_%_match':'项目 '+i,updatedAt:'2026-01-01T00:00:00.000Z'}));
  for(let i=0;i<items.length;i+=20)assert.equal((await f.sync(i<80?a:b,items.slice(i,i+20))).status,200);
  await f.req(detailRoute(a,items[4])+'/pin',{method:'POST',data:{pinned:true}});
  let cursor=null,firstCursor,seen=[];
  do{const r=await f.req('/v1/desktop/threads?limit=17'+(cursor?'&cursor='+cursor:''));assert.equal(r.status,200,JSON.stringify(r.body));seen.push(...r.body.threads.map(x=>x.nodeId+':'+x.threadId));cursor=r.body.nextCursor;firstCursor??=cursor;}while(cursor);
  assert.equal(seen.length,137);assert.equal(new Set(seen).size,137);assert.equal(seen[0],a.id+':'+items[4].threadId);
  assert.equal((await f.req('/v1/desktop/threads?limit=17&q=other&cursor='+firstCursor)).status,400);
  assert.equal((await f.req('/v1/desktop/threads?q='+encodeURIComponent('_%_'))).body.total,1);
  assert.equal((await f.req('/v1/desktop/threads?pinned=true')).body.total,1);
  assert.equal((await f.req('/v1/desktop/threads?limit=101')).status,400);
  assert.equal((await f.req('/v1/desktop/threads?cursor=bad')).status,400);
});

test('on-demand reading routes only to the owning node and tolerates its clock running behind the server',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),item=thread({updatedAt:date(-90000),observedAt:date(-41000)});await f.sync(a,[item]);
  const pending=await f.req(detailRoute(a,item));assert.equal(pending.body.detailPending,true);
  assert.deepEqual((await f.sync(b,[])).body.readRequests,[]);assert.deepEqual((await f.sync(a,[])).body.readRequests,[item.threadId]);
  const delivered={...item,observedAt:date(-40000),detailUpdatedAt:date(-40000),latestUserMessage:'任务要求',activities:[{id:'u1',type:'user_message',text:'任务要求',at:date(-50000)},{id:'tool1',type:'tool_activity',toolType:'command',tool:'PowerShell',status:'completed',exitCode:0,at:date(-40000)}]};
  assert.equal((await f.sync(a,[delivered])).status,200);assert.deepEqual((await f.sync(a,[])).body.readRequests,[]);
  const ready=await f.req(detailRoute(a,item));assert.equal(ready.body.detailPending,false);assert.equal(ready.body.messages[0].text,'任务要求');assert.equal(ready.body.activities[1].tool,'PowerShell');
  assert.equal((await f.req(detailRoute(a,item)+'/refresh',{method:'POST',data:{}})).body.detailPending,true);
  await f.sync(a,[delivered]);assert.deepEqual((await f.sync(a,[])).body.readRequests,[item.threadId],'replaying an old detail cannot satisfy a fresh read request');
});

test('public detail fields are allowlisted, reasoning is rejected, and text/batch bounds are enforced',async t=>{
  const f=fixture(t),a=f.node('PC-01'),item=thread({detailUpdatedAt:date(-500),latestAssistantMessage:'公开结果',rawCredentials:'do-not-store',reasoning:'do-not-store',activities:[{id:'tool',type:'tool_activity',tool:'PowerShell',toolType:'command',status:'completed',command:'SECRET COMMAND',output:'SECRET OUTPUT',reasoning:'SECRET REASONING'}]});
  assert.equal((await f.sync(a,[item])).status,200);const serialized=JSON.stringify((await f.req(detailRoute(a,item))).body);assert.ok(!serialized.includes('SECRET'));assert.ok(!serialized.includes('do-not-store'));
  assert.equal((await f.sync(a,[thread({detailUpdatedAt:now(),activities:[{id:'r',type:'reasoning',text:'hidden'}]})])).status,400);
  assert.equal((await f.sync(a,[thread({title:'x'.repeat(241)})])).status,400);
  assert.equal((await f.sync(a,[thread({detailUpdatedAt:now(),activities:[{id:'u',type:'user_message',text:'x'.repeat(4001)}]})])).status,400);
  assert.equal((await f.sync(a,[thread()],{padding:'x'.repeat(1024*1024)})).status,413);
});

test('directory, details, pins, summary and inventory enforce project scope and revoked-node exclusion',async t=>{
  const f=fixture(t),a=f.node('PC-01',['workspace','private']),reader=f.node('PC-02',['workspace']),publicTask=thread(),privateTask=thread({project:'private',title:'private information'});
  await f.sync(a,[publicTask,privateTask],{inventory:{scannedAt:now(),complete:true,count:2,error:'private path information'}});
  const list=await f.req('/v1/desktop/threads',{token:reader.token});assert.equal(list.body.total,1);assert.equal(list.body.inventories.find(x=>x.nodeId===a.id).count,1);assert.equal(list.body.inventories.find(x=>x.nodeId===a.id).error,null);
  assert.equal((await f.req(detailRoute(a,privateTask),{token:reader.token})).status,403);
  assert.equal((await f.req(detailRoute(a,privateTask)+'/pin',{method:'POST',token:reader.token,data:{pinned:true}})).status,403);
  assert.equal((await f.req(detailRoute(a,publicTask)+'/pin',{method:'POST',token:reader.token,data:{pinned:true}})).status,200);
  const summary=await f.req('/v1/desktop/summary',{token:reader.token});assert.equal(summary.body.nodes.find(x=>x.nodeId===a.id).threads.length,1);assert.ok(!JSON.stringify(summary.body).includes('private information'));
  f.db.db.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(a.id);
  assert.equal((await f.req('/v1/desktop/threads')).body.total,0);assert.equal((await f.req(detailRoute(a,publicTask))).status,404);assert.equal((await f.sync(a,[publicTask])).status,401);
});

test('viewer can read and request public details but cannot pin; browser writes require same origin',async t=>{
  const f=fixture(t),a=f.node('PC-01'),item=thread();await f.sync(a,[item]);
  f.db.db.prepare('INSERT INTO members(id,user_id,email,role,created) VALUES(?,?,?,?,?)').run(uid(),'viewer','viewer@example.test','viewer',now());
  f.db.db.prepare('UPDATE members SET group_access=? WHERE user_id=?').run(JSON.stringify({mode:'all',groupIds:[]}),'viewer');
  const identity={'oai-authenticated-user-id':'viewer','oai-authenticated-user-email':'viewer@example.test'};
  assert.equal((await f.req(detailRoute(a,item),{token:null,identity})).status,200);
  assert.equal((await f.req(detailRoute(a,item)+'/pin',{method:'POST',token:null,identity,origin:'https://fleet.example.test',data:{pinned:true}})).status,403);
  assert.equal((await f.req(detailRoute(a,item)+'/refresh',{method:'POST',token:null,identity,origin:'https://evil.example',data:{}})).status,403);
});

test('summary limits each node to three with pinned first and returns honest stale status',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),items=Array.from({length:8},(_,i)=>thread({updatedAt:date(-i*1000-200000),observedAt:date(-190000),title:'任务 '+i}));
  await f.sync(a,items);await f.sync(b,[thread()]);await f.req(detailRoute(a,items[7])+'/pin',{method:'POST',data:{pinned:true}});
  const summary=await f.req('/v1/desktop/summary'),row=summary.body.nodes.find(x=>x.nodeId===a.id);assert.equal(row.threads.length,3);assert.equal(row.threads[0].threadId,items[7].threadId);assert.equal(row.threads[0].statusFreshness,'stale');assert.equal(row.threads[0].status,'running');assert.equal(row.inventory.storedCount,8);
});

test('a forged Fleet link cannot attach another node task and project remapping clears retained old detail',async t=>{
  const f=fixture(t),a=f.node('PC-01',['workspace','private']),b=f.node('PC-02'),taskId=uid(),item=thread({project:'private',detailUpdatedAt:date(-1000),latestAssistantMessage:'old private detail'});
  const task=await f.req('/v1/tasks',{method:'POST',data:{id:taskId,targetNode:b.id,project:'workspace',prompt:'test'}});assert.equal(task.status,200);
  assert.equal((await f.sync(a,[thread({fleetTaskId:taskId})])).status,403);
  await f.sync(a,[item]);await f.sync(a,[{threadId:item.threadId,title:'Mapped public metadata',project:'workspace',updatedAt:now(),observedAt:now()}]);
  const result=await f.req(detailRoute(a,item),{token:b.token});assert.equal(result.status,200);assert.equal(result.body.latestAssistantMessage,'');assert.equal(result.body.detailPending,true);
});

test('a failure during atomic sync rolls back every row and is never acknowledged',async t=>{
  const f=fixture(t),a=f.node('PC-01'),items=[thread(),thread()];
  f.db.db.exec("CREATE TRIGGER desktop_fail BEFORE INSERT ON desktop_threads WHEN NEW.title='trigger-failure' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  items[1].title='trigger-failure';const result=await f.sync(a,items);assert.equal(result.status,500);assert.equal(f.db.db.prepare('SELECT count(*) n FROM desktop_threads').get().n,0);assert.equal(f.db.db.prepare('SELECT count(*) n FROM desktop_inventories').get().n,0);
});

test('home, directory and detail use the latest public conversation item, not the opening preview or latest tool',async t=>{
  const f=fixture(t),a=f.node('PC-01'),messageAt=date(-3000),item=thread({
    preview:'opening question',detailUpdatedAt:date(-500),activities:[
      {id:'user-1',type:'user_message',text:'opening question',at:date(-10000)},
      {id:'assistant-1',type:'assistant_message',text:'latest response',at:messageAt},
      {id:'tool-1',type:'tool_activity',tool:'PowerShell',status:'completed',at:date(-1000)},
    ],
  });
  await f.sync(a,[item]);
  const get=async()=>[
    (await f.req('/v1/desktop/summary')).body.nodes[0].latestThread,
    (await f.req('/v1/desktop/threads')).body.threads[0],
    (await f.req(detailRoute(a,item))).body,
  ];
  for(const row of await get()){assert.deepEqual(row.latestMessage,{text:'latest response',role:'assistant',at:messageAt});assert.equal(row.messageState,'ready');}
  item.activities.push({id:'user-2',type:'user_message',text:'follow-up without timestamp'});
  await f.sync(a,[{...item,observedAt:now(),detailUpdatedAt:now()}]);
  for(const row of await get())assert.deepEqual(row.latestMessage,{text:'follow-up without timestamp',role:'user',at:null});
  const list=(await f.req('/v1/desktop/threads')).body;assert.ok(!JSON.stringify(list).includes('PowerShell'),'list exposes only the chosen message, not the full tool history');
});

test('visible-page message refresh is bounded, idempotent and excludes other projects, offline devices and unchanged histories',async t=>{
  const f=fixture(t),a=f.node('PC-01',['workspace','private']),reader=f.node('PC-02'),offline=f.node('PC-03');
  const items=Array.from({length:31},()=>thread());for(let i=0;i<items.length;i+=20)await f.sync(a,items.slice(i,i+20));
  const hidden=thread({project:'private'});await f.sync(a,[hidden]);await f.sync(offline,[thread()]);
  f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(date(-90000),offline.id);
  await f.req('/v1/desktop/threads?limit=30',{token:reader.token});
  const queued=f.db.db.prepare('SELECT * FROM desktop_read_requests ORDER BY thread_id').all();assert.equal(queued.length,20);assert.ok(queued.every(x=>x.node===a.id&&x.thread_id!==hidden.threadId));
  await f.req('/v1/desktop/threads?limit=30',{token:reader.token});assert.deepEqual(f.db.db.prepare('SELECT * FROM desktop_read_requests ORDER BY thread_id').all(),queued);
  const missing=(await f.req('/v1/desktop/threads?limit=1&nodeId='+a.id,{token:reader.token})).body.threads[0];assert.equal(missing.latestMessage,null);assert.equal(missing.messageState,'pending');
  const current=items.find(x=>x.threadId===missing.threadId),done={...current,observedAt:now(),detailUpdatedAt:now(),status:'completed',activities:[{id:'latest',type:'assistant_message',text:'complete',at:date(-1000)}]};
  await f.sync(a,[done]);await f.req('/v1/desktop/threads?limit=1',{token:reader.token});
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM desktop_read_requests WHERE thread_id=?').get(done.threadId).n,0);
});
