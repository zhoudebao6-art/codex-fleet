import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';

const migrationDir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');for(const f of fs.readdirSync(migrationDir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(migrationDir,f),'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)}};}};}
  async batch(items){this.db.exec('BEGIN IMMEDIATE');try{const result=items.map(i=>({meta:{changes:Number(this.db.prepare(i.sql).run(...i.args).changes)}}));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
function fixture(t) {
  const db=new SqliteD1();t.after(()=>db.db.close());const adminToken=secret(),env={DB:db,FLEET_ADMIN_TOKEN:adminToken};
  const node=(name,projects=['workspace'],capabilities={selfUpgrade:true})=>{const id=uid(),token=secret();db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities) VALUES(?,?,?,?,?,?,?)').run(id,name,hash(token),JSON.stringify(projects),'shared-login',now(),JSON.stringify(capabilities));return {id,token};};
  const member=(role='operator')=>{const id=uid(),email=id+'@example.test';db.db.prepare('INSERT INTO members(id,user_id,email,role,created) VALUES(?,?,?,?,?)').run(id,id,email,role,now());return {'oai-authenticated-user-id':id,'oai-authenticated-user-email':email};};
  const req=async(route,{method='GET',data,token=adminToken,identity}={})=>{const headers={...identity};if(token)headers.authorization='Bearer '+token;if(identity&&method!=='GET')headers.origin='https://fleet.example.test';if(data!==undefined)headers['content-type']='application/json';if(method==='DELETE')headers['content-type']='application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);return {status:r.status,body:await r.json()};};
  const group=(name,extra={})=>req('/v1/device-groups',{method:'POST',data:{id:uid(),name,...extra}});
  const edit=(n,data,extra={})=>req('/v1/nodes/'+n.id,{method:'PATCH',data,...extra});
  const installer=(extra={})=>{const value={sha256:hash(uid()),size:10,version:'0.3.1',name:'codex-fleet-0.3.1-windows-x64.zip',project:'workspace',...extra};db.db.prepare("INSERT INTO files(id,project,sha,size,name,status,offset,owner,created,updated) VALUES(?,?,?,?,?,'complete',?,'admin',?,?)").run(uid(),value.project,value.sha256,value.size,value.name,value.size,now(),now());db.db.prepare("INSERT INTO settings(key,value) VALUES('installer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));return value;};
  const upgrade=(n,id=uid(),extra={})=>req('/v1/nodes/'+n.id+'/upgrade',{method:'POST',data:{id},...extra});
  const ack=(n,id,data)=>req('/v1/node/actions/'+id+'/ack',{method:'POST',token:n.token,data});
  return {db,req,node,member,group,edit,installer,upgrade,ack};
}

test('display rename and group assignment preserve the stable device code, identity, permissions and account semaphore across heartbeats',async t=>{
  const f=fixture(t),n=f.node('PC-02'),group=(await f.group('办公室')).body,before=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);
  const edited=await f.edit(n,{displayName:'办公室电脑',groupId:group.id});assert.equal(edited.status,200);assert.equal(edited.body.displayName,'办公室电脑');assert.equal(edited.body.name,'PC-02');assert.equal(edited.body.code,'PC-02');assert.equal(edited.body.groupName,'办公室');
  await f.req('/v1/sync',{method:'POST',token:n.token,data:{events:[],capabilities:{ready:false,name:'local old name',displayName:'spoofed',projects:['workspace']}}});
  const after=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);for(const key of ['id','name','token_hash','projects','account_group'])assert.equal(after[key],before[key]);assert.equal(after.display_name,'办公室电脑');
  assert.equal((await f.edit(n,{displayName:null,groupId:null})).body.displayName,'PC-02');
});

test('group CRUD is idempotent, ordered and deleting a group only unassigns its devices and pending invitations',async t=>{
  const f=fixture(t),n=f.node('PC-01'),id=uid(),first=await f.group('异地',{id,sortOrder:5});assert.equal((await f.group('异地',{id,sortOrder:5})).status,200);assert.equal((await f.group('异地')).status,409);
  await f.edit(n,{groupId:id});const inv=await f.req('/v1/invites',{method:'POST',data:{name:'PC-04',projects:['workspace'],groupId:id}});assert.equal(inv.body.groupId,id);
  assert.equal((await f.req('/v1/device-groups/'+id,{method:'PATCH',data:{name:'异地办公',sortOrder:-1}})).body.sortOrder,-1);let list=await f.req('/v1/device-groups');assert.equal(list.body.groups[0].nodeCount,1);
  assert.equal((await f.req('/v1/device-groups/'+id,{method:'DELETE'})).status,200);assert.equal((await f.req('/v1/device-groups/'+id,{method:'DELETE'})).status,200);assert.equal(f.db.db.prepare('SELECT display_group_id,revoked FROM nodes WHERE id=?').get(n.id).display_group_id,null);assert.equal(f.db.db.prepare('SELECT revoked FROM nodes WHERE id=?').get(n.id).revoked,0);assert.equal(f.db.db.prepare('SELECT display_group_id FROM invites WHERE id=?').get(inv.body.id).display_group_id,null);
});

test('invitations initialize friendly names and display groups while enrollment retries do not overwrite later organization changes',async t=>{
  const f=fixture(t),g=(await f.group('工作室')).body,inv=(await f.req('/v1/invites',{method:'POST',data:{name:'PC-05',displayName:'设计电脑',groupId:g.id,projects:['workspace'],accountGroup:'same-account'}})).body,n={id:uid(),token:secret()},body={token:inv.token,nodeId:n.id,nodeToken:n.token};
  const enrolled=await f.req('/v1/enroll',{method:'POST',token:null,data:body});assert.equal(enrolled.status,200,JSON.stringify(enrolled.body));assert.equal(enrolled.body.name,'PC-05');let row=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);assert.equal(row.display_name,'设计电脑');assert.equal(row.display_group_id,g.id);
  await f.edit(n,{displayName:'主设计电脑',groupId:null});assert.equal((await f.req('/v1/enroll',{method:'POST',token:null,data:body})).status,200);row=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);assert.equal(row.display_name,'主设计电脑');assert.equal(row.display_group_id,null);assert.equal(row.account_group,'same-account');
});

test('node and ordinary operator credentials cannot change names, groups, permissions or issue upgrades',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02');
  for(const options of [{token:a.token},{token:null,identity:f.member()},{token:null,identity:f.member('viewer')}]){assert.equal((await f.edit(b,{displayName:'unauthorized'},options)).status,403);assert.equal((await f.req('/v1/device-groups',{method:'POST',data:{name:'unauthorized'},...options})).status,403);assert.equal((await f.upgrade(b,uid(),options)).status,403);}
  for(const field of ['name','projects','accountGroup','token','maxRunning'])assert.equal((await f.edit(a,{[field]:'changed'})).status,400);
  assert.equal((await f.edit(a,{groupId:uid()})).status,404);assert.equal((await f.edit(a,{displayName:'bad\nname'})).status,400);
});

test('group reads and member counts are limited to the node reader project scope',async t=>{
  const f=fixture(t),publicNode=f.node('PC-01'),privateNode=f.node('PC-02',['private']),reader=f.node('PC-03'),shared=(await f.group('共用分组')).body,privateGroup=(await f.group('秘密分组')).body;
  await f.edit(publicNode,{groupId:shared.id});await f.edit(privateNode,{groupId:shared.id});let list=await f.req('/v1/device-groups',{token:reader.token});assert.equal(list.body.groups.length,1);assert.equal(list.body.groups[0].nodeCount,1);await f.edit(privateNode,{groupId:privateGroup.id});list=await f.req('/v1/device-groups',{token:reader.token});assert.ok(!JSON.stringify(list.body).includes('秘密分组'));
});

test('upgrade actions select only the registered verified installer and atomically allow one active action per node',async t=>{
  const f=fixture(t),n=f.node('PC-01'),old=f.node('PC-02',['workspace'],{}),release=f.installer(),id=uid();assert.equal((await f.upgrade(old)).body.code,'NODE_UPGRADE_BOOTSTRAP_REQUIRED');
  const responses=await Promise.all([f.upgrade(n,id),f.upgrade(n,uid())]);assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);const action=responses.find(x=>x.status===200).body;assert.deepEqual(action.installer,release);assert.equal(action.downloadPath,'/v1/files/'+release.sha256+'?project=workspace');
  f.installer({version:'0.3.2'});assert.deepEqual((await f.upgrade(n,action.id)).body.installer,release);assert.equal((await f.upgrade(old,action.id)).status,409);
  for(const field of ['url','command','path','installer'])assert.equal((await f.upgrade(n,uid(),{data:{id:uid(),[field]:'arbitrary'}})).status,400);
});

test('upgrade polling and acknowledgements are device-bound, monotonic and verify package plus installed version before completion',async t=>{
  const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02'),release=f.installer(),action=(await f.upgrade(a)).body,id=action.id;
  assert.equal((await f.req('/v1/node/actions',{token:a.token})).body.actions.length,1);assert.equal((await f.req('/v1/node/actions',{token:b.token})).body.actions.length,0);assert.equal((await f.ack(b,id,{status:'downloading'})).status,404);assert.equal((await f.req('/v1/node/actions')).status,403);
  assert.equal((await f.ack(a,id,{status:'downloading',bytes:5})).status,200);assert.equal((await f.ack(a,id,{status:'downloading',bytes:4})).status,409);
  assert.equal((await f.ack(a,id,{status:'waiting',bytes:10})).status,409);assert.equal((await f.ack(a,id,{status:'waiting',bytes:10,packageSha256:release.sha256})).status,200);
  assert.equal((await f.ack(a,id,{status:'downloading',bytes:5})).body.status,'waiting');assert.equal((await f.ack(a,id,{status:'completed',bytes:10,packageSha256:release.sha256,version:'incorrect'})).status,409);
  const completed={status:'completed',bytes:10,packageSha256:release.sha256,version:release.version};assert.equal((await f.ack(a,id,completed)).body.status,'completed');assert.equal((await f.ack(a,id,completed)).status,200);assert.equal((await f.ack(a,id,{status:'failed',bytes:10})).status,409);
  assert.equal((await f.req('/v1/node/actions',{token:a.token})).body.actions.length,0);assert.equal((await f.req('/v1/nodes/'+a.id+'/actions')).body.actions[0].status,'completed');
});

test('an unverified or unauthorized installer cannot become a node action and failure permits a deliberate new request',async t=>{
  const f=fixture(t),a=f.node('PC-01'),privateNode=f.node('PC-02',['private']),release=f.installer();assert.equal((await f.upgrade(privateNode)).status,403);f.db.db.prepare("UPDATE files SET status='uploading' WHERE sha=?").run(release.sha256);assert.equal((await f.upgrade(a)).status,409);
  f.db.db.prepare("UPDATE files SET status='complete' WHERE sha=?").run(release.sha256);const action=(await f.upgrade(a)).body;assert.equal((await f.ack(a,action.id,{status:'failed',detail:'Verification failed'})).body.status,'failed');assert.equal((await f.upgrade(a)).body.status,'queued');
});

test('automatic upgrade rejects registered package formats the node updater cannot receive',async t=>{
  const f=fixture(t),n=f.node('PC-01');
  for(const metadata of [{version:'next'},{version:'0.3.1-beta'},{name:'folder/package.zip'},{name:'package.ZIP'},{size:0},{size:1024*1024*1024+1}]){
    f.installer(metadata);assert.equal((await f.upgrade(n)).status,409,JSON.stringify(metadata));
  }
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS count FROM node_actions').get().count,0);
});

test('additive organization and upgrade migrations preserve existing identities and scopes',()=>{
  const db=new DatabaseSync(':memory:');try{const migrations=fs.readdirSync(migrationDir).filter(x=>x.endsWith('.sql')).sort();for(const f of migrations.filter(x=>Number(x.slice(0,4))<7))db.exec(fs.readFileSync(path.join(migrationDir,f),'utf8'));
    db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group) VALUES(?,?,?,?,?)').run('stable','PC-01','retained-hash','["private"]','shared-login');for(const f of migrations.filter(x=>Number(x.slice(0,4))>=7))db.exec(fs.readFileSync(path.join(migrationDir,f),'utf8'));const n=db.prepare('SELECT * FROM nodes').get();assert.equal(n.id,'stable');assert.equal(n.token_hash,'retained-hash');assert.equal(n.projects,'["private"]');assert.equal(n.account_group,'shared-login');assert.equal(n.display_name,null);assert.equal(n.display_group_id,null);
  }finally{db.close();}
});

test('upgrade uses a safe basename for a verified installer uploaded under a project directory',async t=>{const f=fixture(t),n=f.node('PC-01'),release=f.installer();f.db.db.prepare('UPDATE files SET name=? WHERE sha=?').run('releases/'+release.name,release.sha256);const response=await f.upgrade(n);assert.equal(response.status,200);assert.equal(response.body.installer.name,release.name);});
