import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now,json} from '../util.mjs';
import {advanceAutomations} from '../orchestration.mjs';

const migrations=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
class DB {
  constructor(){this.db=new DatabaseSync(':memory:');for(const name of fs.readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(migrations,name),'utf8'));}
  prepare(sql){const db=this.db;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:db.prepare(this.sql).all(...this.args)};},async run(){const x=db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(x.changes)}};}};}
  async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const x=items.map(i=>({meta:{changes:Number(this.db.prepare(i.sql).run(...i.args).changes)}}));this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class Bucket {constructor(){this.data=new Map();}async put(key,data){this.data.set(key,Buffer.from(data));}async get(key,o){let value=this.data.get(key);if(!value)return null;if(o?.range)value=value.subarray(o.range.offset,o.range.offset+o.range.length);return {body:new Response(value).body};}}
const allAccess={mode:'all',groupIds:[]},groups=(...ids)=>({mode:'groups',groupIds:ids});
function fixture(t){
  const db=new DB(),token=secret(),env={DB:db,BUCKET:new Bucket(),FLEET_ADMIN_TOKEN:token};t.after(()=>db.db.close());
  async function req(route,{method='GET',data,actor=null}={}){const headers={};if(actor?.identity)Object.assign(headers,actor.identity);if(actor?.cookie)headers.cookie=actor.cookie;if(!actor||actor.token)headers.authorization='Bearer '+(actor?.token||token);if(actor&&!actor.token&&method!=='GET')headers.origin='https://fleet.example.test';if(method!=='GET')headers['content-type']=Buffer.isBuffer(data)?'application/octet-stream':'application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:Buffer.isBuffer(data)?data:json(data)}),env);const type=r.headers.get('content-type')||'';return {status:r.status,body:type.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer()),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  function group(name){const id=uid();db.db.prepare('INSERT INTO device_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,name,now(),now());return id;}
  function node(name,groupId=null){const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities,display_group_id) VALUES(?,?,?,?,?,?,?,?)').run(id,name,hash(token),'["workspace"]',name,now(),json({projects:['workspace'],workspaceExecution:true,localExecutionPolicy:true}),groupId);return {id,token,name};}
  async function member(role='operator',access=undefined){const email=uid()+'@example.test',r=await req('/api/console/members',{method:'POST',data:{email,role,...(access?{access}:{})}});assert.equal(r.status,200,json(r.body));return {id:r.body.id,identity:{'oai-authenticated-user-id':'user-'+r.body.id,'oai-authenticated-user-email':email}};}
  const spec=n=>({id:uid(),targetNode:n.id,project:'workspace',prompt:'Authorized work',mode:'question',worktree:false,outputs:[],inputs:[],dependencies:[]});
  async function task(n,actor=null){const s=spec(n),r=await req('/v1/tasks',{method:'POST',data:s,actor});assert.equal(r.status,200,json(r.body));return r.body;}
  async function native(n,title){const threadId=uid(),r=await req('/v1/desktop/sync',{method:'POST',actor:n,data:{threads:[{threadId,title,preview:title+' content',cwd:'D:/'+title,project:'workspace',status:'running',statusSource:'app_server_runtime',updatedAt:now(),observedAt:now(),archived:false}],inventory:{scannedAt:now(),complete:true,count:1}}});assert.equal(r.status,200,json(r.body));return threadId;}
  async function file(n,taskId,name){const data=Buffer.from(name),sha=hash(data);let r=await req('/v1/files',{method:'POST',actor:n,data:{project:'workspace',sha,name,size:data.length}});assert.equal(r.status,200);r=await req('/v1/files/'+sha+'?project=workspace&offset=0',{method:'PUT',actor:n,data});assert.equal(r.status,200);if(taskId)db.db.prepare('INSERT INTO artifact_refs(task,sha,name,direction) VALUES(?,?,?,?)').run(taskId,sha,name,'output');return sha;}
  const poll=n=>req('/v1/sync',{method:'POST',actor:n,data:{events:[],capabilities:{ready:true,projects:['workspace'],workspaceExecution:true,localExecutionPolicy:true}}});
  const access=(member,access)=>req('/api/console/members/'+member.id,{method:'PATCH',data:{access}});
  return {db,env,req,group,node,member,spec,task,native,file,poll,access};
}

test('group permissions filter all directories, overview counts, running projects and event streams on a shared project domain',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),u=f.node('PC-U'),reader=await f.member('viewer',groups(ga)),ta=await f.task(a),tb=await f.task(b);
  for(const [n,task]of [[a,ta],[b,tb]]){f.db.db.prepare("UPDATE tasks SET status='running',attempt=? WHERE id=?").run(uid(),task.id);f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({activeTasks:[task.id]}),n.id);}
  const da=await f.native(a,'Aproject'),db=await f.native(b,'Bsecret'),fa=await f.file(a,ta.id,'Afile'),fb=await f.file(b,tb.id,'Bsecretfile');
  const wa=(await f.req('/v1/workspaces',{method:'POST',data:{nodeId:a.id,name:'A workspace',sourceThreadId:da}})).body,wb=(await f.req('/v1/workspaces',{method:'POST',data:{nodeId:b.id,name:'B secret workspace',sourceThreadId:db}})).body;
  for(const route of ['/api/console/overview','/v1/nodes','/v1/tasks','/v1/tasks/page','/v1/desktop/threads','/v1/desktop/summary','/v1/workspaces','/v1/device-groups']){
    const r=await f.req(route,{actor:reader});assert.equal(r.status,200,route+' '+json(r.body));const text=json(r.body);assert.ok(!text.includes(b.id)&&!text.includes(u.id)&&!text.includes('Bsecret')&&!text.includes(wb.id),route);
  }
  const overview=(await f.req('/api/console/overview',{actor:reader})).body;assert.equal(overview.taskStats.total,1);assert.equal(overview.nodes.length,1);assert.ok(overview.runningProjects.length>0);assert.equal(overview.files.length,1);assert.equal(overview.files[0].sha,fa);
  for(const route of ['/v1/tasks/'+tb.id,'/v1/tasks/'+tb.id+'/events','/v1/tasks/'+tb.id+'/messages','/v1/tasks/'+tb.id+'/interactions','/v1/desktop/threads/'+b.id+'/'+db,'/v1/workspaces/'+wb.id+'/threads','/v1/artifacts/'+fb+'?task='+tb.id])assert.equal((await f.req(route,{actor:reader})).status,403,route);
  assert.equal((await f.req('/v1/files/'+fb+'?project=workspace',{actor:reader})).status,404);assert.equal((await f.req('/v1/files/'+fa+'?project=workspace',{actor:reader})).status,200);
  assert.equal((await f.req('/v1/workspaces/'+wa.id+'/threads',{actor:reader})).status,200);
});

test('operators write only to permitted groups and cannot use hidden file hashes, continuations, dependencies or workspace bindings',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),op=await f.member('operator',groups(ga)),ta=await f.task(a),tb=await f.task(b),sha=await f.file(b,tb.id,'secret-output');
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:f.spec(a)})).status,200);
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:f.spec(b)})).status,403);
  for(const body of [{...f.spec(a),dependencies:[tb.id]},{...f.spec(a),parentId:tb.id},{...f.spec(a),resumeTaskId:tb.id},{...f.spec(a),inputs:[{sha,name:'secret-output',size:13}]}])assert.ok([403,404].includes((await f.req('/v1/tasks',{method:'POST',actor:op,data:body})).status));
  assert.equal((await f.req('/v1/tasks/'+tb.id+'/messages',{method:'POST',actor:op,data:{text:'hidden'}})).status,403);
  assert.equal((await f.req('/v1/tasks/'+ta.id+'/messages',{method:'POST',actor:op,data:{text:'visible'}})).status,200);
  assert.equal((await f.req('/v1/workspaces',{method:'POST',actor:op,data:{nodeId:b.id,name:'forbidden'}})).status,403);
  assert.equal((await f.req('/v1/files',{method:'POST',actor:op,data:{project:'workspace',sha,size:13,name:'secret-output'}})).status,404);
  await f.req('/api/console/members/'+op.id,{method:'PATCH',data:{role:'viewer'}});
  assert.equal((await f.req('/v1/tasks/'+ta.id+'/messages',{method:'POST',actor:op,data:{text:'viewer cannot write'}})).status,403);
});

test('new non-admin accounts and platform members have no device grants until an administrator chooses groups',async t=>{
  const f=fixture(t),a=f.node('PC-A'),reader=await f.member();assert.equal((await f.req('/v1/nodes',{actor:reader})).body.length,0);assert.equal((await f.req('/v1/tasks',{method:'POST',actor:reader,data:f.spec(a)})).status,403);
  const created=await f.req('/api/console/accounts',{method:'POST',data:{username:'new-reader',password:'666666',role:'operator'}});assert.deepEqual(created.body.access,groups());
  const login=await f.req('/api/console/login',{method:'POST',actor:{},data:{username:'new-reader',password:'666666'}});assert.equal(login.status,200);const actor={cookie:login.cookie};assert.equal((await f.req('/v1/nodes',{actor})).body.length,0);
  await f.req('/api/console/accounts/'+created.body.id,{method:'PATCH',data:{access:groups('__ungrouped__')}});assert.equal((await f.req('/v1/nodes',{actor})).body.length,1);
  await f.req('/api/console/accounts/'+created.body.id,{method:'PATCH',data:{access:groups()}});assert.equal((await f.req('/v1/nodes',{actor})).body.length,0);
  assert.equal((await f.req('/api/console/accounts/'+created.body.id,{method:'DELETE'})).status,200);assert.equal((await f.req('/v1/nodes',{actor})).status,401);assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM login_sessions').get().n,0);
});

test('device browser grants and role change immediately without changing background node cooperation',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb);await f.req('/v1/nodes/'+a.id,{method:'PATCH',data:{consoleRole:'operator',consoleAccess:groups(ga)}});
  const ticket=await f.req('/v1/device-session',{method:'POST',actor:a,data:{}}),session=await f.req('/api/console/device-session',{method:'POST',actor:{},data:{ticket:ticket.body.ticket}}),actor={cookie:session.cookie};assert.equal(session.status,200);
  assert.equal((await f.req('/v1/nodes',{actor})).body.length,1);assert.equal((await f.req('/v1/tasks',{method:'POST',actor,data:f.spec(b)})).status,403);
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor:a,data:f.spec(b)})).status,200);
  await f.req('/v1/nodes/'+a.id,{method:'PATCH',data:{consoleRole:'viewer',consoleAccess:groups(gb)}});const me=(await f.req('/api/console/me',{actor})).body.user;assert.equal(me.role,'viewer');assert.deepEqual(me.access,groups(gb));assert.equal((await f.req('/v1/nodes',{actor})).body[0].id,b.id);
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor,data:f.spec(b)})).status,403);assert.equal((await f.req('/v1/tasks',{method:'POST',actor:a,data:f.spec(b)})).status,200);
});

test('permission withdrawal prevents queued browser tasks from being claimed and stops multi-device automation handoff',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),op=await f.member('operator',groups(ga,gb)),queued=await f.task(b,op);
  await f.access(op,groups(ga));assert.equal((await f.poll(b)).body.tasks.length,0);assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(queued.id).status,'queued');
  await f.access(op,groups(ga,gb));const flow={id:uid(),name:'A then B',project:'workspace',steps:[a,b].map((n,i)=>({name:'Step '+i,targetNode:n.id,prompt:'Do work',mode:'question'}))},created=await f.req('/v1/automations',{method:'POST',actor:op,data:flow});assert.equal(created.status,200,json(created.body));
  await f.access(op,groups(ga));assert.equal((await f.req('/v1/automations/'+flow.id,{actor:op})).status,403);assert.equal((await f.req('/v1/automations',{actor:op})).body.automations.length,0);
  await advanceAutomations(f.db);assert.equal(f.db.db.prepare('SELECT status FROM automation_flows WHERE id=?').get(flow.id).status,'needs_attention');assert.equal((await f.poll(a)).body.tasks.length,0);
});

test('deleting a display group does not grant ungrouped access or restore grants if its ID is reused',async t=>{
  const f=fixture(t),g=f.group('A'),a=f.node('PC-A',g),op=await f.member('operator',groups(g));await f.req('/v1/nodes/'+a.id,{method:'PATCH',data:{consoleAccess:groups(g)}});
  assert.equal((await f.req('/v1/device-groups/'+g,{method:'DELETE'})).status,200);assert.equal((await f.req('/v1/nodes',{actor:op})).body.length,0);assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT group_access FROM members WHERE id=?').get(op.id).group_access),groups());
  assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT console_access FROM nodes WHERE id=?').get(a.id).console_access),groups());
  await f.req('/v1/device-groups',{method:'POST',data:{id:g,name:'Reused'}});await f.req('/v1/nodes/'+a.id,{method:'PATCH',data:{groupId:g}});assert.equal((await f.req('/v1/nodes',{actor:op})).body.length,0);
  await f.access(op,groups('__ungrouped__'));await f.req('/v1/nodes/'+a.id,{method:'PATCH',data:{groupId:null}});assert.equal((await f.req('/v1/nodes',{actor:op})).body.length,1);
});

test('malformed access fails closed, scope changes bind pagination cursors, and ordinary operators cannot edit grants',async t=>{
  const f=fixture(t),g=f.group('A'),a=f.node('PC-A',g),op=await f.member('operator',groups(g));await f.task(a);await f.task(a);const page=await f.req('/v1/tasks/page?limit=1',{actor:op});assert.ok(page.body.nextCursor);
  assert.equal((await f.req('/api/console/members/'+op.id,{method:'PATCH',actor:op,data:{access:allAccess}})).status,403);
  for(const access of [null,{},groups('missing'),{mode:'all',groupIds:[g]},{mode:'groups',groupIds:[g,g]},{mode:'groups',groupIds:[],other:true}])assert.equal((await f.access(op,access)).status,400);
  await f.access(op,groups());assert.equal((await f.req('/v1/tasks/page?limit=1&cursor='+page.body.nextCursor,{actor:op})).status,400);
  f.db.db.prepare('UPDATE members SET group_access=? WHERE id=?').run('invalid',op.id);assert.equal((await f.req('/v1/nodes',{actor:op})).body.length,0);assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:f.spec(a)})).status,403);
});

test('browser uploads carry explicit group ownership and become unreadable to their uploader when access is removed',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),op=await f.member('operator',groups(ga,gb)),other=await f.member('viewer',groups(gb)),data=Buffer.from('scoped-upload'),sha=hash(data),init={project:'workspace',sha,name:'scoped.txt',size:data.length};
  assert.equal((await f.req('/v1/files',{method:'POST',actor:op,data:init})).body.code,'UPLOAD_GROUP_REQUIRED');
  assert.equal((await f.req('/v1/files',{method:'POST',actor:op,data:{...init,groupId:ga}})).status,200);
  assert.equal((await f.req('/v1/files/'+sha+'?project=workspace&offset=0',{method:'PUT',actor:op,data})).status,200);
  assert.equal((await f.req('/v1/files/'+sha+'?project=workspace',{actor:other})).status,404);
  await f.access(op,groups(gb));assert.equal((await f.req('/v1/files/'+sha+'?project=workspace',{actor:op})).status,404);assert.equal((await f.req('/v1/files',{method:'POST',actor:op,data:{...init,groupId:gb}})).status,404);
  await f.access(op,groups(ga));assert.equal((await f.req('/v1/files/'+sha+'?project=workspace',{actor:op})).status,200);
  await f.req('/v1/device-groups/'+ga,{method:'DELETE'});assert.equal(f.db.db.prepare('SELECT COUNT(*) AS count FROM file_group_grants').get().count,0);assert.equal((await f.req('/v1/files/'+sha+'?project=workspace',{actor:op})).status,404);
});

test('direct native continuation fields are refused and desktop detail links only a matching Fleet-owned thread',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),op=await f.member('operator',groups(ga)),thread=await f.native(a,'native'),ta=await f.task(a),tb=await f.task(b);
  for(const key of ['desktopThreadId','desktopCwd'])assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:{...f.spec(a),[key]:'unsafe'}})).body.code,'NATIVE_CONTINUATION_UNSUPPORTED');
  f.db.db.prepare('UPDATE tasks SET thread_id=? WHERE id=?').run(thread,tb.id);assert.equal((await f.req('/v1/desktop/threads/'+a.id+'/'+thread,{actor:op})).body.fleetTaskId,null);
  f.db.db.prepare('UPDATE tasks SET thread_id=?,status=? WHERE id=?').run(thread,'submitted',ta.id);const detail=(await f.req('/v1/desktop/threads/'+a.id+'/'+thread,{actor:op})).body;assert.equal(detail.fleetTaskId,ta.id);assert.equal(detail.fleetTaskStatus,'submitted');assert.equal(detail.fleetTaskNative,false);
});

test('a permission withdrawal racing an atomic workflow claim cannot start a task with an inaccessible step',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),op=await f.member('operator',groups(ga,gb)),flow={id:uid(),name:'A B',project:'workspace',steps:[a,b].map(n=>({name:n.name,targetNode:n.id,prompt:'Run',mode:'question'}))};
  assert.equal((await f.req('/v1/automations',{method:'POST',actor:op,data:flow})).status,200);
  let revoked=false;const original=f.db.batch.bind(f.db);f.db.batch=async items=>{if(items.some(i=>i.sql?.includes("UPDATE tasks SET status='claimed'"))){revoked=true;f.db.db.prepare('UPDATE members SET group_access=? WHERE id=?').run(json(groups(ga)),op.id);}return original(items);};
  const r=await f.poll(a);assert.equal(r.status,200,json(r.body));assert.equal(r.body.tasks.length,0);assert.equal(revoked,true);
});

test('dedicated native continuation uses only synchronized routing, rejects overrides and gates capability, online state and browser access',async t=>{
  const f=fixture(t),ga=f.group('A'),gb=f.group('B'),a=f.node('PC-A',ga),b=f.node('PC-B',gb),thread=await f.native(a,'native'),op=await f.member('operator',groups(ga)),viewer=await f.member('viewer',groups(ga)),outside=await f.member('operator',groups(gb)),route='/v1/desktop/threads/'+a.id+'/'+thread+'/message',body={id:uid(),prompt:'Continue the original conversation'};
  assert.equal((await f.req(route,{method:'POST',actor:op,data:body})).body.code,'NATIVE_CONTINUATION_UNSUPPORTED');
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({desktopContinuation:true}),a.id);
  for(const field of ['desktopCwd','executionPolicy','sandbox','model','skills','outputs','inputs','workspaceId','resumeTaskId','targetNode'])assert.equal((await f.req(route,{method:'POST',actor:op,data:{...body,[field]:'override'}})).status,400);
  for(const actor of [viewer,outside])assert.equal((await f.req(route,{method:'POST',actor,data:body})).status,403);
  f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run('2000-01-01T00:00:00.000Z',a.id);assert.equal((await f.req(route,{method:'POST',actor:op,data:body})).body.code,'NODE_OFFLINE');f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(now(),a.id);
  const sent=await f.req(route,{method:'POST',actor:op,data:body});assert.equal(sent.status,200,json(sent.body));assert.deepEqual(sent.body.spec,{...body,targetNode:a.id,project:'workspace',mode:'execute',worktree:false,desktopThreadId:thread,desktopCwd:'D:/native'});
  f.db.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run('2000-01-01T00:00:00.000Z',a.id);assert.equal((await f.req(route,{method:'POST',actor:op,data:body})).body.id,body.id);
  assert.equal((await f.req(route,{method:'POST',actor:op,data:{...body,prompt:'different'}})).status,409);
});

test('native requests atomically allow one active turn per thread and do not claim on an unsupported adapter',async t=>{
  const f=fixture(t),g=f.group('A'),a=f.node('PC-A',g),op=await f.member('operator',groups(g)),thread=await f.native(a,'native'),route='/v1/desktop/threads/'+a.id+'/'+thread+'/message';f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({desktopContinuation:true}),a.id);
  const result=await Promise.all([f.req(route,{method:'POST',actor:op,data:{id:uid(),prompt:'first'}}),f.req(route,{method:'POST',actor:op,data:{id:uid(),prompt:'second'}})]);assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);assert.equal(result.find(r=>r.status===409).body.code,'NATIVE_CONTINUATION_PENDING');const task=result.find(r=>r.status===200).body;
  assert.equal((await f.poll(a)).body.tasks.length,0);
  const claimed=await f.req('/v1/sync',{method:'POST',actor:a,data:{events:[],capabilities:{ready:true,projects:['workspace'],desktopContinuation:true}}});assert.equal(claimed.status,200,json(claimed.body));assert.equal(claimed.body.tasks[0].id,task.id);
  const finish=await f.req('/v1/sync',{method:'POST',actor:a,data:{events:[{id:uid(),type:'finished',taskId:task.id,attemptId:claimed.body.tasks[0].attempt,status:'blocked',result:{desktop:{state:'busy'},summary:'Original Codex owns this thread; not resumed.'}}],capabilities:{ready:false,projects:['workspace'],desktopContinuation:true}}});assert.equal(finish.status,200,json(finish.body));assert.equal((await f.req('/v1/tasks/'+task.id,{actor:op})).body.result.desktop.state,'busy');
  assert.equal((await f.req(route,{method:'POST',actor:op,data:{id:uid(),prompt:'A deliberate later retry'}})).status,200);
});

test('native-origin follow-ups cannot bypass saved policy through generic resumeTaskId or an older Fleet task on the same thread',async t=>{
  const f=fixture(t),g=f.group('A'),a=f.node('PC-A',g),op=await f.member('operator',groups(g)),thread=await f.native(a,'native'),route='/v1/desktop/threads/'+a.id+'/'+thread;
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({desktopContinuation:true,localExecutionPolicy:true}),a.id);
  const original=(await f.req(route+'/message',{method:'POST',actor:op,data:{id:uid(),prompt:'Native turn'}})).body;
  const queued=(await f.req(route,{actor:op})).body;assert.equal(queued.fleetTaskId,original.id);assert.equal(queued.fleetTaskNative,true);assert.equal(queued.fleetTaskStatus,'queued');
  for(const status of ['submitted','accepted','failed','blocked','cancelled']){
    f.db.db.prepare('UPDATE tasks SET thread_id=?,status=? WHERE id=?').run(thread,status,original.id);
    for(const mode of ['question','execute']){
      const data={...f.spec(a),resumeTaskId:original.id,mode,...(mode==='execute'?{executionPolicy:'local'}:{})};
      const denied=await f.req('/v1/tasks',{method:'POST',actor:op,data});assert.equal(denied.status,409,json(denied.body));assert.equal(denied.body.code,'NATIVE_CONTINUATION_REQUIRED');assert.equal(f.db.db.prepare('SELECT id FROM tasks WHERE id=?').get(data.id),undefined);
    }
  }
  const historical=await f.task(a);f.db.db.prepare("UPDATE tasks SET thread_id=?,status='submitted' WHERE id=?").run(thread,historical.id);
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:{...f.spec(a),resumeTaskId:historical.id}})).body.code,'NATIVE_CONTINUATION_REQUIRED');
  // An ordinary Fleet-owned conversation remains resumable through its existing path.
  f.db.db.prepare('UPDATE tasks SET thread_id=? WHERE id=?').run(uid(),historical.id);
  assert.equal((await f.req('/v1/tasks',{method:'POST',actor:op,data:{...f.spec(a),resumeTaskId:historical.id}})).status,200);
});

test('uncertain native delivery remains locked after a terminal report until an administrator explicitly resolves it',async t=>{
  const f=fixture(t),g=f.group('A'),a=f.node('PC-A',g),op=await f.member('operator',groups(g)),thread=await f.native(a,'native'),route='/v1/desktop/threads/'+a.id+'/'+thread,body={id:uid(),prompt:'Perform one operation'};
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({desktopContinuation:true}),a.id);
  assert.equal((await f.req(route+'/message',{method:'POST',actor:op,data:body})).status,200);
  const caps={ready:true,projects:['workspace'],desktopContinuation:true},claimed=await f.req('/v1/sync',{method:'POST',actor:a,data:{events:[],capabilities:caps}}),attempt=claimed.body.tasks[0].attempt;
  const finish=await f.req('/v1/sync',{method:'POST',actor:a,data:{events:[{id:uid(),type:'finished',taskId:body.id,attemptId:attempt,status:'blocked',result:{desktop:{state:'uncertain'},summary:'Turn delivery acknowledgement was lost.'}}],capabilities:{...caps,ready:false}}});assert.equal(finish.status,200,json(finish.body));
  assert.equal(f.db.db.prepare('SELECT thread_id FROM tasks WHERE id=?').get(body.id).thread_id,null);
  const detail=(await f.req(route,{actor:op})).body;assert.equal(detail.fleetTaskId,body.id);assert.equal(detail.fleetTaskNative,true);assert.equal(detail.fleetTaskStatus,'blocked');
  const retries=await Promise.all([1,2].map(i=>f.req(route+'/message',{method:'POST',actor:op,data:{id:uid(),prompt:'Retry '+i}})));assert.deepEqual(retries.map(r=>r.status),[409,409]);for(const r of retries)assert.equal(r.body.code,'NATIVE_CONTINUATION_PENDING');
  assert.equal((await f.req(route+'/message',{method:'POST',actor:op,data:body})).body.id,body.id);
  // A cancelled report must not be mistaken for proof that delivery never happened.
  f.db.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(body.id);
  assert.equal((await f.req(route+'/message',{method:'POST',actor:op,data:{id:uid(),prompt:'New ID'}})).body.code,'NATIVE_CONTINUATION_PENDING');
  const resolve='/v1/tasks/'+body.id+'/resolve',evidence={confirmStopped:true,note:'Checked the original conversation and confirmed no active turn remains.'};
  assert.equal((await f.req(resolve,{method:'POST',actor:op,data:evidence})).status,403);assert.equal((await f.req(resolve,{method:'POST',data:{note:evidence.note}})).status,400);
  const resolved=await f.req(resolve,{method:'POST',data:evidence});assert.equal(resolved.status,200,json(resolved.body));assert.equal(resolved.body.status,'failed');assert.equal(resolved.body.result.note,evidence.note);
  assert.equal((await f.req(route+'/message',{method:'POST',actor:op,data:{id:uid(),prompt:'Deliberate continuation after inspection'}})).status,200);
});

test('local account and platform member deletion protect the last administrator and do not resurrect the removed owner',async t=>{
  const f=fixture(t),m=await f.member('admin');f.env.FLEET_OWNER_EMAIL=m.identity['oai-authenticated-user-email'];assert.equal((await f.req('/api/console/members/'+m.id,{method:'DELETE'})).status,409);
  const created=await f.req('/api/console/accounts',{method:'POST',data:{username:'second-admin',password:'666666',role:'admin'}});assert.equal(created.status,200);assert.equal((await f.req('/api/console/members/'+m.id,{method:'DELETE'})).status,200);assert.equal((await f.req('/v1/nodes',{actor:m})).status,403);
  assert.equal((await f.req('/api/console/accounts/'+created.body.id,{method:'DELETE'})).status,409);assert.equal((await f.req('/api/console/accounts/'+created.body.id,{method:'PATCH',data:{role:'viewer'}})).status,409);
});

test('group ACL migration preserves old identity sessions and explicit full access while new rows default to no grants',()=>{
  const db=new DatabaseSync(':memory:');try{const names=fs.readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort();for(const name of names.filter(x=>Number(x.slice(0,4))<9))db.exec(fs.readFileSync(path.join(migrations,name),'utf8'));
    db.prepare('INSERT INTO members(id,email,role,created) VALUES(?,?,?,?)').run('legacy-member','old@example.test','operator',now());db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group) VALUES(?,?,?,?,?)').run('legacy-node','PC-01','kept-token','["workspace"]','same-login');db.prepare('INSERT INTO device_sessions(hash,node,expires,created) VALUES(?,?,?,?)').run('session-kept','legacy-node','2099-01-01',now());
    for(const name of names.filter(x=>Number(x.slice(0,4))>=9))db.exec(fs.readFileSync(path.join(migrations,name),'utf8'));assert.deepEqual(JSON.parse(db.prepare('SELECT group_access FROM members').get().group_access),allAccess);const n=db.prepare('SELECT * FROM nodes').get();assert.deepEqual(JSON.parse(n.console_access),allAccess);assert.equal(n.token_hash,'kept-token');assert.equal(n.account_group,'same-login');assert.equal(db.prepare('SELECT hash FROM device_sessions').get().hash,'session-kept');
    db.prepare('INSERT INTO members(id,email,role,created) VALUES(?,?,?,?)').run('new-member','new@example.test','operator',now());assert.deepEqual(JSON.parse(db.prepare('SELECT group_access FROM members WHERE id=?').get('new-member').group_access),groups());
  }finally{db.close();}
});
