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
  async function req(route,{method='GET',data,token=adminToken,identity,origin,cookie}={}) {
    const headers={...identity};if(token)headers.authorization='Bearer '+token;if(identity&&method!=='GET')headers.origin='https://fleet.example.test';if(origin)headers.origin=origin;if(cookie)headers.cookie=cookie;
    if(data!==undefined)headers['content-type']='application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);return {status:r.status,body:await r.json(),headers:r.headers};
  }
  const register=(n,extra={})=>req('/v1/workspaces',{method:'POST',data:{id:uid(),nodeId:n.id,name:'新建项目',...extra}});
  const ack=(n,w,extra={})=>req('/v1/workspaces/'+w.id+'/ack',{method:'POST',token:n.token,data:{status:'ready',root:'D:\\CodexFleet\\workspace\\projects\\'+w.id,...extra}});
  const syncThread=async(n,{threadId=uid(),cwd='E:\\项目\\已有工程',project='workspace',title='项目任务',...extra}={})=>{const item={threadId,cwd,project,title,updatedAt:now(),observedAt:now(),...extra};const r=await req('/v1/desktop/sync',{method:'POST',token:n.token,data:{threads:[item]}});assert.equal(r.status,200);return item;};
  const task=(n,w,extra={})=>req('/v1/tasks',{method:'POST',data:{id:uid(),targetNode:n.id,project:w.project,workspaceId:w.id,prompt:'Read and work in the selected project',...extra}});
  const poll=(n,capabilities={})=>req('/v1/sync',{method:'POST',token:n.token,data:{events:[],capabilities:{ready:true,projects:['workspace'],...capabilities}}});
  return {db,req,node,register,ack,syncThread,task,poll};
}

test('new workspace waits for a target-node directory acknowledgement and legacy nodes cannot claim it',async t=>{
  const f=fixture(t),n=f.node('PC-01'),created=await f.register(n);assert.equal(created.status,200);const w=created.body;assert.equal(w.status,'pending');assert.equal(w.root,null);assert.equal(w.source,'created');
  assert.equal((await f.task(n,w)).status,409);assert.equal((await f.ack(n,w)).body.status,'ready');
  const assigned=await f.task(n,w);assert.equal(assigned.status,200,JSON.stringify(assigned.body));assert.equal((await f.poll(n)).body.tasks.length,0);
  const active=(await f.poll(n,{workspaceExecution:true})).body.tasks[0];assert.equal(active.id,assigned.body.id);assert.equal(active.spec.workspaceId,w.id);
});

test('source directories must come from observed desktop tasks and registration deduplicates Windows path spelling',async t=>{
  const f=fixture(t),n=f.node('PC-01'),source=await f.syncThread(n),same=await f.syncThread(n,{cwd:'e:/项目/已有工程/'});
  let list=await f.req('/v1/workspaces?nodeId='+n.id);assert.equal(list.body.discovered.length,1);assert.equal(list.body.discovered[0].threadCount,2);
  assert.equal((await f.register(n,{root:'C:\\arbitrary'})).status,400);assert.equal((await f.register(n,{sourceThreadId:uid()})).status,404);
  const w=(await f.register(n,{sourceThreadId:source.threadId,name:'现有项目'})).body;assert.equal(w.root,source.cwd);assert.equal(w.source,'discovered');assert.equal(w.controllerThreadId,source.threadId);
  const duplicate=await f.register(n,{sourceThreadId:same.threadId,name:'无需重复创建'});assert.equal(duplicate.body.id,w.id);
  assert.equal((await f.ack(n,w,{root:'e:/项目/已有工程/'})).status,200);list=await f.req('/v1/workspaces?nodeId='+n.id);assert.equal(list.body.discovered.length,0);assert.equal(list.body.workspaces.length,1);
});

test('only the correct node can acknowledge and paths remain immutable after registration',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),w=(await f.register(a)).body;
  assert.equal((await f.ack(b,w)).status,403);assert.equal((await f.ack(a,w,{status:'error',error:'Directory unavailable'})).body.status,'error');
  assert.equal((await f.ack(a,w)).body.status,'ready');assert.equal((await f.ack(a,w,{root:'D:\\different'})).status,409);
  const other=(await f.register(a)).body;assert.equal((await f.ack(a,other,{root:'D:\\CodexFleet\\workspace\\projects\\'+w.id})).status,409);
  assert.equal((await f.req('/v1/workspaces/'+w.id,{method:'PATCH',data:{root:'D:\\changed'}})).status,400);
});

test('workspace request IDs retry safely while changed requests and other-target task dispatch reject',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),id=uid(),payload={id,name:'稳定请求'},first=await f.register(a,payload);
  assert.equal((await f.register(a,payload)).body.id,first.body.id);assert.equal((await f.register(a,{...payload,name:'改变请求'})).status,409);await f.ack(a,first.body);
  assert.equal((await f.task(b,first.body)).status,403);assert.equal((await f.task(a,first.body,{workspaceId:'not-found'})).status,404);
});

test('authorized node controllers create shared projects on another node without granting arbitrary directory access',async t=>{
  const f=fixture(t),controller=f.node('PC-01'),target=f.node('PC-02',['workspace','private']),isolated=f.node('PC-03',['private']);
  const id=uid(),body={id,nodeId:target.id,name:'跨机创建',project:'workspace',automationNote:'完成后交给总控汇总'},create=data=>f.req('/v1/workspaces',{method:'POST',token:controller.token,data});
  const pending=await create(body);assert.equal(pending.status,200,JSON.stringify(pending.body));assert.equal(pending.body.root,null);assert.equal(pending.body.status,'pending');
  assert.equal((await create(body)).body.id,id);assert.equal((await f.ack(controller,pending.body)).status,403);assert.equal((await f.ack(target,pending.body)).body.status,'ready');
  const source=await f.syncThread(target,{cwd:'E:\\shared-observed'}),registered=await create({nodeId:target.id,name:'已发现项目',sourceThreadId:source.threadId});assert.equal(registered.status,200);assert.equal(registered.body.root,source.cwd);
  const privateSource=await f.syncThread(target,{cwd:'E:\\private-observed',project:'private'});
  assert.equal((await create({nodeId:target.id,name:'私有',sourceThreadId:privateSource.threadId})).status,403);
  assert.equal((await create({...body,id:uid(),project:'private'})).status,403);assert.equal((await create({...body,id:uid(),nodeId:isolated.id})).status,403);
  assert.equal((await create({...body,id:uid(),root:'C:\\arbitrary'})).status,400);assert.equal((await create({...body,id:uid(),path:'C:\\arbitrary'})).status,400);
  assert.equal((await create({...body,id:uid(),sourceThreadId:uid()})).status,404);
});

test('controller binding is limited to observed threads in this computer and directory, with automation notes retained',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),source=await f.syncThread(a),same=await f.syncThread(a),other=await f.syncThread(a,{cwd:'E:\\别的项目'}),remote=await f.syncThread(b),w=(await f.register(a,{sourceThreadId:source.threadId})).body;
  let updated=await f.req('/v1/workspaces/'+w.id,{method:'PATCH',data:{controllerThreadId:same.threadId,automationNote:'写代码后交给另一台校验'}});assert.equal(updated.status,200);assert.equal(updated.body.automationNote,'写代码后交给另一台校验');
  for(const id of [other.threadId,remote.threadId])assert.equal((await f.req('/v1/workspaces/'+w.id,{method:'PATCH',data:{controllerThreadId:id}})).status,403);
  const threads=await f.req('/v1/workspaces/'+w.id+'/threads');assert.equal(threads.body.threads.length,2);assert.equal(threads.body.controllerThreadId,same.threadId);
  updated=await f.req('/v1/workspaces/'+w.id,{method:'PATCH',data:{controllerThreadId:null}});assert.equal(updated.body.controllerThreadId,null);
});

test('project scoping hides workspace paths and discovery from unrelated node and device sessions',async t=>{
  const f=fixture(t),a=f.node('PC-01',['workspace','private']),b=f.node('PC-02'),source=await f.syncThread(a,{project:'private',cwd:'E:\\私有项目'}),w=(await f.register(a,{sourceThreadId:source.threadId})).body;
  const list=await f.req('/v1/workspaces',{token:b.token});assert.equal(list.body.workspaces.length,0);assert.equal(list.body.discovered.length,0);assert.equal((await f.req('/v1/workspaces/'+w.id+'/threads',{token:b.token})).status,403);
  const ticket=await f.req('/v1/device-session',{method:'POST',token:b.token,data:{}}),exchange=await f.req('/api/console/device-session',{method:'POST',token:null,origin:'https://fleet.example.test',data:{ticket:ticket.body.ticket}}),cookie=exchange.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.req('/v1/workspaces',{method:'POST',token:null,cookie,origin:'https://fleet.example.test',data:{nodeId:a.id,name:'forbidden',sourceThreadId:source.threadId}})).status,403);
});

test('a ready workspace that becomes unavailable is not claimed and task continuation cannot switch directories',async t=>{
  const f=fixture(t),n=f.node('PC-01'),w=(await f.register(n)).body,other=(await f.register(n)).body;await f.ack(n,w);await f.ack(n,other);
  const assigned=(await f.task(n,w)).body;await f.ack(n,w,{status:'error',error:'Folder missing'});assert.equal((await f.poll(n,{workspaceExecution:true})).body.tasks.length,0);
  await f.ack(n,w);assert.equal((await f.poll(n,{workspaceExecution:true})).body.tasks[0].id,assigned.id);
  f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(assigned.id);
  assert.equal((await f.task(n,other,{resumeTaskId:assigned.id,worktree:false})).status,400);
  assert.equal((await f.task(n,w,{resumeTaskId:assigned.id,worktree:false})).status,200);
});

test('a node automatically registers all its valid workspaces, including projects without conversations, and retries preserve names and controller settings',async t=>{
  const f=fixture(t),n=f.node('PC-01'),entry={id:'auto-project',project:'workspace',name:'无对话的项目',root:'E:\\Projects\\empty',source:'registered',sourceProjectId:'codex-project'};
  const sync=workspaces=>f.req('/v1/workspaces/sync',{method:'POST',token:n.token,data:{workspaces}});
  const first=await sync([entry,{id:'auto-config',project:'workspace',name:'默认',root:'D:\\Fleet\\workspace',source:'configured'}]);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.workspaces.length,2);const w=first.body.workspaces[0];assert.equal(w.status,'ready');assert.equal(w.autoImported,true);assert.equal(w.controllerThreadId,null);assert.equal(w.sourceProjectId,entry.sourceProjectId);
  assert.equal((await f.task(n,w)).status,200);await f.req('/v1/workspaces/'+w.id,{method:'PATCH',data:{name:'我的名称',automationNote:'保留流程'}});
  const retry=await sync([{...entry,root:'e:/projects/empty/'}]);assert.equal(retry.body.workspaces[0].id,w.id);assert.equal(retry.body.workspaces[0].name,'我的名称');assert.equal(retry.body.workspaces[0].automationNote,'保留流程');assert.equal((await f.req('/v1/workspaces?nodeId='+n.id)).body.workspaces.length,2);
});

test('catalog ingestion rejects browsers, admin tokens, other-node addressing, ungranted projects and malformed batches',async t=>{
  const f=fixture(t),n=f.node('PC-01'),other=f.node('PC-02'),entry={id:'catalog-a',project:'workspace',name:'项目',root:'E:\\Project',source:'configured'},request=(data,token=n.token)=>f.req('/v1/workspaces/sync',{method:'POST',token,data});
  assert.equal((await request({workspaces:[entry]},undefined)).status,200); // own node only
  assert.equal((await f.req('/v1/workspaces/sync',{method:'POST',data:{workspaces:[entry]}})).status,403);
  assert.equal((await request({nodeId:other.id,workspaces:[entry]})).status,400);assert.equal((await request({workspaces:[{...entry,project:'private'}]})).status,403);assert.equal((await request({workspaces:[{...entry,source:'registered'}]})).status,400);assert.equal((await request({workspaces:[{...entry,root:'relative'}]})).status,400);assert.equal((await request({workspaces:Array(41).fill(entry)})).status,400);
  assert.equal((await f.req('/v1/workspaces?nodeId='+other.id)).body.workspaces.length,0);
});
