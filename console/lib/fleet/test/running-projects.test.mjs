import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {runningProjects} from '../running-projects.mjs';
import {directoryKey} from '../project-paths.mjs';
import {hash,secret,uid,now} from '../util.mjs';

class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)}};}};}
}
const at=(delta=0)=>new Date(Date.now()+delta).toISOString();
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const admin=secret(),env={DB:db,FLEET_ADMIN_TOKEN:admin};
  const node=(name,projects=['workspace'])=>{const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen) VALUES(?,?,?,?,?,?)').run(id,name,hash(token),JSON.stringify(projects),id,now());return {id,token,projects};};
  const caps=(n,value)=>db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(value),n.id);
  const workspace=(n,root,name='真实项目',project='workspace')=>{const w={id:uid(),nodeId:n.id,project,root,name};db.db.prepare("INSERT INTO project_workspaces(id,node,project,name,root,root_key,source,status,creator,create_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,'created','ready','admin',?,?,?)").run(w.id,n.id,project,name,root,directoryKey(root),hash(w.id),now(),now());return w;};
  const task=(n,options={})=>{const x={id:uid(),attempt:uid(),threadId:null,project:'workspace',status:'running',workspaceId:null,prompt:'真实任务',created:at(-3600000),updated:at(-5000),result:null,...options},spec={id:x.id,targetNode:n.id,project:x.project,prompt:x.prompt,...(x.workspaceId?{workspaceId:x.workspaceId}:{})};db.db.prepare('INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,attempt,created,updated,result,thread_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(x.id,'admin',n.id,x.project,x.status,JSON.stringify(spec),hash(JSON.stringify(spec)),x.attempt,x.created,x.updated,x.result?JSON.stringify(x.result):null,x.threadId);return x;};
  const desktop=(n,options={})=>{const x={id:uid(),project:'workspace',cwd:'E:\\Project',title:'电脑任务',status:'running',source:'app_server_runtime',observed:at(-1000),received:at(-1000),updated:at(-1000),archived:0,fleetTaskId:null,...options};db.db.prepare('INSERT INTO desktop_threads(node,thread_id,project,title,cwd,archived,updated_at,observed_at,status,status_source,last_activity_at,fleet_task_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(n.id,x.id,x.project,x.title,x.cwd,x.archived,x.updated,x.observed,x.status,x.source,x.updated,x.fleetTaskId,x.received);return x;};
  const event=(n,x,payload,options={})=>db.db.prepare('INSERT INTO events(id,node,task,type,payload,created) VALUES(?,?,?,?,?,?)').run(uid(),n.id,x.id,options.type||'progress',JSON.stringify({taskId:x.id,attemptId:x.attempt,...payload}),options.created||now());
  const req=async(route,token=admin)=>{const r=await handle(new Request('https://fleet.example.test'+route,{headers:{authorization:'Bearer '+token}}),env);return {status:r.status,body:await r.json()};};
  return {db,node,caps,workspace,task,desktop,event,req};
}

test('preparing an original-thread message keeps its project and does not double count the desktop conversation',async t=>{
  const f=fixture(t),n=f.node('PC'),w=f.workspace(n,'E:\\Original','原项目'),d=f.desktop(n,{cwd:w.root});
  const task=f.task(n,{status:'claimed'}),row=f.db.db.prepare('SELECT spec FROM tasks WHERE id=?').get(task.id);
  f.db.db.prepare('UPDATE tasks SET spec=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.spec),desktopThreadId:d.id}),task.id);
  f.caps(n,{taskRuntime:[{taskId:task.id,attemptId:task.attempt,phase:'preparing'}]});
  const result=await f.req('/api/console/overview');
  assert.equal(result.status,200);assert.equal(result.body.runningProjects.length,1);
  assert.equal(result.body.runningProjects[0].name,'原项目');assert.equal(result.body.runningProjects[0].total,1);
  assert.equal(result.body.runningProjects[0].currentTasks[0].threadId,d.id);
});

test('overview discovers old active projects outside the recent page, separates computers and deduplicates native Fleet threads',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),w=f.workspace(a,'E:\\Project','主项目'),other=f.workspace(b,'E:\\Project','异地主项目');
  for(let i=0;i<150;i++)f.task(a,{status:'accepted',created:now()});
  const threadId=uid(),first=f.task(a,{workspaceId:w.id,threadId}),second=f.task(a,{workspaceId:w.id}),remote=f.task(b,{workspaceId:other.id});
  f.caps(a,{taskRuntime:[{taskId:first.id,attemptId:first.attempt,phase:'running',cwd:'D:\\worktrees\\task-a'},{taskId:second.id,attemptId:second.attempt,phase:'uploading',cwd:'E:\\Project'}]});
  f.caps(b,{taskRuntime:[{taskId:remote.id,attemptId:remote.attempt,phase:'preparing',cwd:null}]});
  f.desktop(a,{id:threadId,cwd:'D:\\worktrees\\task-a',fleetTaskId:first.id});f.desktop(a,{cwd:'e:/project/'});
  f.event(a,first,{kind:'tool_activity',toolType:'commandExecution',tool:'run-test',status:'running',command:'must not expose raw arguments'});
  const r=await f.req('/api/console/overview?limit=1');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.tasks.length,1);assert.equal(r.body.runningProjects.length,2);
  const group=r.body.runningProjects.find(x=>x.nodeId===a.id);assert.equal(group.workspaceId,w.id);assert.equal(group.name,'主项目');assert.equal(group.total,3);assert.equal(group.fleetCount,2);assert.equal(group.desktopCount,1);assert.equal(group.latestActivity,'run-test · running');assert.ok(group.currentTasks.some(x=>x.phase==='uploading'));assert.ok(!JSON.stringify(group).includes('must not expose'));
  const remoteGroup=r.body.runningProjects.find(x=>x.nodeId===b.id);assert.equal(remoteGroup.total,1);assert.equal(remoteGroup.currentTasks[0].phase,'preparing');assert.notEqual(group.id,remoteGroup.id);
});

test('reference lists stay bounded while project totals cover every active task, with fresh runtime attempt matching',async t=>{
  const f=fixture(t),a=f.node('PC-01'),runtime=[];for(let i=0;i<16;i++){const x=f.task(a);runtime.push({taskId:x.id,attemptId:x.attempt,phase:'running',cwd:'E:\\Many'});}const mismatch=f.task(a);runtime.push({taskId:mismatch.id,attemptId:uid(),phase:'running',cwd:'E:\\Wrong'});f.caps(a,{taskRuntime:runtime});
  const groups=await runningProjects(f.db,{admin:true});assert.equal(groups.length,1);assert.equal(groups[0].total,16);assert.equal(groups[0].currentTasks.length,8);assert.equal(groups[0].root,'E:\\Many');
  const history=await f.req('/v1/tasks/page?target='+a.id+'&cwd='+encodeURIComponent('e:/many/')+'&phase=active');assert.equal(history.status,200,JSON.stringify(history.body));assert.equal(history.body.total,16);
});

test('recent activity, persisted stale turns, offline nodes and unconfirmed server states are not advertised as running',async t=>{
  const f=fixture(t),a=f.node('PC-01'),offline=f.node('PC-02');f.task(a);f.desktop(a,{status:'recent_activity'});f.desktop(a,{source:'persisted_turn'});f.desktop(a,{observed:at(-180000)});f.desktop(a,{received:at(-180000)});f.desktop(a,{archived:1});f.desktop(offline);f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(at(-70000),offline.id);
  assert.deepEqual(await runningProjects(f.db,{admin:true}),[]);
  const legacy=f.task(a,{threadId:uid()}),upload=f.task(a),uncertain=f.task(a,{status:'uncertain'});f.caps(a,{activeTasks:[legacy.id,uncertain.id],waitingInteractions:[{taskId:legacy.id,id:uid()}]});f.event(a,upload,{kind:'output_transfer',stage:'uploading'});
  const groups=await runningProjects(f.db,{admin:true});assert.equal(groups.length,1);assert.equal(groups[0].total,2);assert.deepEqual(groups[0].currentTasks.map(x=>x.phase).sort(),['uploading','waiting']);
});

test('active project summaries preserve project authorization and hide revoked devices',async t=>{
  const f=fixture(t),a=f.node('PC-01',['workspace','private']),b=f.node('PC-02');f.desktop(a);f.desktop(a,{project:'private',cwd:'E:\\Private'});f.desktop(b);f.db.db.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(b.id);
  const groups=await runningProjects(f.db,{admin:false,browser:false,projects:'["workspace"]'});assert.equal(groups.length,1);assert.equal(groups[0].project,'workspace');assert.ok(!JSON.stringify(groups).includes('Private'));
});

test('project history filters exact normalized paths and preserves completion time when acceptance changes updated time',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),w=f.workspace(a,'E:\\Project'),done=f.task(a,{workspaceId:w.id,status:'accepted',result:{summary:'Actual work completed',cwd:'D:\\worktree'}}),same=f.task(a,{status:'submitted',result:{cwd:'e:/project/'}}),elsewhere=f.task(a,{status:'submitted',result:{cwd:'E:\\Project-other'}});f.task(b,{status:'submitted',result:{cwd:'E:\\Project'}});
  const completed=at(-20000);f.event(a,done,{status:'submitted'},{type:'finished',created:completed});f.event(b,done,{status:'submitted'},{type:'finished',created:at(-30000)});f.event(a,done,{status:'submitted',attemptId:uid()},{type:'finished',created:at(-40000)});f.db.db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(now(),done.id);
  let r=await f.req('/v1/tasks/page?workspaceId='+w.id+'&phase=completed&limit=1');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,2);const cursor=r.body.nextCursor;assert.ok(cursor);
  const all=await f.req('/v1/tasks/page?target='+a.id+'&cwd='+encodeURIComponent('e:/PROJECT/')+'&phase=completed');assert.deepEqual(new Set(all.body.tasks.map(x=>x.id)),new Set([done.id,same.id]));assert.ok(!all.body.tasks.some(x=>x.id===elsewhere.id));
  assert.equal(all.body.tasks.find(x=>x.id===done.id).completedAt,completed);assert.equal(all.body.tasks.find(x=>x.id===same.id).completedAt,null);assert.equal((await f.req('/v1/tasks/'+done.id)).body.completedAt,completed);
  assert.equal((await f.req('/v1/tasks/page?workspaceId='+w.id+'&phase=all&cursor='+cursor)).status,400);assert.equal((await f.req('/v1/tasks/page?cwd='+encodeURIComponent('E:\\Project'))).status,400);
  const privateNode=f.node('PC-03',['private']);assert.equal((await f.req('/v1/tasks/page?workspaceId='+w.id,privateNode.token)).status,403);
});

test('desktop history finds bound worktrees and archived completed tasks while active excludes inferred activity',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),w=f.workspace(a,'E:\\Project'),linked=uid();f.task(a,{workspaceId:w.id,threadId:linked,status:'submitted'});const completed=f.desktop(a,{id:linked,cwd:'D:\\worktrees\\old',status:'completed',archived:1}),native=f.desktop(a,{cwd:'e:/project/',status:'completed',archived:1});f.desktop(b,{status:'completed'});f.desktop(a,{cwd:'E:\\Project-other',status:'completed'});f.desktop(a,{status:'recent_activity'});
  let r=await f.req('/v1/desktop/threads?workspaceId='+w.id+'&phase=completed&limit=1');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,2);assert.ok(r.body.nextCursor);assert.equal((await f.req('/v1/desktop/threads?workspaceId='+w.id+'&phase=all&cursor='+r.body.nextCursor)).status,400);
  r=await f.req('/v1/desktop/threads?workspaceId='+w.id+'&phase=completed');assert.deepEqual(new Set(r.body.threads.map(x=>x.threadId)),new Set([completed.id,native.id]));
  r=await f.req('/v1/desktop/threads?nodeId='+a.id+'&cwd='+encodeURIComponent('e:/PROJECT/')+'&phase=completed');assert.equal(r.body.total,1);assert.equal(r.body.threads[0].threadId,native.id);
  assert.equal((await f.req('/v1/desktop/threads?workspaceId='+w.id+'&phase=active')).body.total,0);assert.equal((await f.req('/v1/desktop/threads?cwd='+encodeURIComponent('E:\\Project'))).status,400);
});
