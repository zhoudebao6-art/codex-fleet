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


test('console cleanup is reversible, permission checked, and survives desktop inventory sync',async t=>{
 const f=fixture(t),n=f.node('PC-01'),thread=await f.syncThread(n,{cwd:'D:/test-project',title:'Test conversation'}),w=(await f.register(n,{sourceThreadId:thread.threadId})).body;await f.ack(n,w,{root:'D:/test-project'});
 const task=(await f.task(n,w)).body;f.db.db.prepare("UPDATE tasks SET status='accepted',thread_id=? WHERE id=?").run(thread.threadId,task.id);
 const before=(await f.req('/v1/tasks/page')).body.total;
 const payload={id:uid(),label:'Cleanup test',items:[{kind:'workspace',id:w.id},{kind:'task',id:task.id},{kind:'directory',nodeId:n.id,root:'d:\\test-project/'}]};
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:payload,token:n.token})).status,403);
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:payload})).status,200);
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:payload})).status,200);
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:{...payload,label:'changed'}})).status,409);
 assert.equal((await f.req('/v1/workspaces')).body.workspaces.length,0);
 assert.equal((await f.req('/v1/workspaces')).body.discovered.length,0);
 assert.equal((await f.req('/v1/tasks/page')).body.total,before-1);
 const overview=(await f.req('/api/console/overview')).body;assert.equal(overview.taskStats.total,0);assert.ok(overview.viewRevision);
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:{...payload,id:uid()}})).status,409);
 assert.equal((await f.req('/v1/desktop/threads')).body.total,0);
 assert.equal((await f.req('/v1/desktop/summary')).body.nodes[0].latestThread,null);
 await f.syncThread(n,{...thread,observedAt:now()});assert.equal((await f.req('/v1/desktop/threads')).body.total,0);
 assert.equal((await f.req('/v1/tasks/'+task.id)).status,200);
 assert.equal((await f.req('/api/console/cleanup/'+payload.id+'/restore',{method:'POST',data:{}})).status,200);
 assert.equal((await f.req('/v1/desktop/threads')).body.total,1);
 assert.equal((await f.req('/v1/tasks/page')).body.total,before);
 assert.equal((await f.req('/api/console/cleanup')).body.records[0].status,'restored');
});
test('a mixed cleanup request rejects active tasks without hiding other records',async t=>{
 const f=fixture(t),n=f.node('PC-01'),w=(await f.register(n)).body;await f.ack(n,w);const task=(await f.task(n,w)).body;
 const r=await f.req('/api/console/cleanup',{method:'POST',data:{id:uid(),label:'No partial cleanup',items:[{kind:'workspace',id:w.id},{kind:'task',id:task.id}]}});
 assert.equal(r.status,409);assert.equal((await f.req('/v1/workspaces')).body.workspaces.length,1);assert.equal((await f.req('/v1/tasks')).body.length,1);assert.equal((await f.req('/api/console/cleanup')).body.records.length,0);
});
test('cleanup exact IDs protect similarly named real work and bound SQL literals',async t=>{
 const f=fixture(t),n=f.node('PC-01');const qa=await f.syncThread(n,{cwd:"D:/qa's directory",title:'Test'}),real=await f.syncThread(n,{cwd:'D:/real',title:'Real test plan'});
 const payload={id:uid(),label:'Specific project',items:[{kind:'directory',nodeId:n.id,root:qa.cwd}]};assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:payload})).status,200);
 const list=(await f.req('/v1/desktop/threads')).body;assert.equal(list.total,1);assert.equal(list.threads[0].threadId,real.threadId);
});
test('fresh running desktop cannot be hidden',async t=>{
 const f=fixture(t),n=f.node('PC-01'),thread=await f.syncThread(n,{status:'running',statusSource:'app_server_runtime'});
 const payload={id:uid(),label:'Active desktop',items:[{kind:'desktop',nodeId:n.id,id:thread.threadId}]};assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:payload})).status,409);
});

test('uncertain native attempt cannot be hidden even if status says failed',async t=>{
 const f=fixture(t),n=f.node('PC-01'),w=(await f.register(n)).body;await f.ack(n,w);const task=(await f.task(n,w)).body;
 f.db.db.prepare("UPDATE tasks SET status='failed',result=? WHERE id=?").run(JSON.stringify({desktop:{state:'uncertain'}}),task.id);
 assert.equal((await f.req('/api/console/cleanup',{method:'POST',data:{id:uid(),label:'Uncertain',items:[{kind:'task',id:task.id}]}})).status,409);
});
