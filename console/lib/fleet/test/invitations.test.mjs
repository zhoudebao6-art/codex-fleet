import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';

const migrationDir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
class SqliteD1 {
  constructor(){this.db=new DatabaseSync(':memory:');for(const f of fs.readdirSync(migrationDir).filter(x=>x.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(migrationDir+'/'+f,'utf8'));}
  prepare(sql){const database=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return database.db.prepare(this.sql).get(...this.args)||null;},async all(){return {results:database.db.prepare(this.sql).all(...this.args)};},async run(){if(database.beforeRun){const hook=database.beforeRun;database.beforeRun=null;await hook(this.sql);}const r=database.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)}};}};}
  async batch(items){if(this.beforeBatch){const hook=this.beforeBatch;this.beforeBatch=null;await hook(items);}this.db.exec('BEGIN IMMEDIATE');try{const result=items.map(i=>({meta:{changes:Number(this.db.prepare(i.sql).run(...i.args).changes)}}));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
function fixture(t){
  const db=new SqliteD1();t.after(()=>db.db.close());const adminToken=secret(),env={DB:db,FLEET_ADMIN_TOKEN:adminToken};
  const req=async(route,{method='GET',data,token=adminToken,identity,cookie}={})=>{const headers={...identity};if(token)headers.authorization='Bearer '+token;if(identity||cookie)headers.origin='https://fleet.example.test';if(cookie)headers.cookie=cookie;if(data!==undefined||method==='DELETE')headers['content-type']='application/json';const r=await handle(new Request('https://fleet.example.test'+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);return {status:r.status,body:await r.json()};};
  const create=(name='PC-04',extra={},options={})=>req('/api/console/invites',{method:'POST',data:{name,projects:['workspace'],...extra},...options});
  const enroll=(inv,node={id:uid(),token:secret()})=>req('/v1/enroll',{method:'POST',token:null,data:{token:inv.token,nodeId:node.id,nodeToken:node.token}});
  const group=async name=>(await req('/v1/device-groups',{method:'POST',data:{name}})).body;
  const member=role=>{const id=uid(),email=id+'@example.test';db.db.prepare('INSERT INTO members(id,user_id,email,role,created,group_access) VALUES(?,?,?,?,?,?)').run(id,id,email,role,now(),'{"mode":"all","groupIds":[]}');return {'oai-authenticated-user-id':id,'oai-authenticated-user-email':email};};
  const stored=id=>db.db.prepare('SELECT * FROM invites WHERE id=?').get(id);
  return {db,req,create,enroll,group,member,stored};
}

test('invitations expose bounded admin records without secrets and separate enrollment from live readiness',async t=>{
  const f=fixture(t),inv=(await f.create()).body;
  let detail=await f.req('/api/console/invites/'+inv.id);assert.equal(detail.body.status,'pending');assert.equal(detail.body.node,null);assert.ok(detail.body.createdAt);
  const node={id:uid(),token:secret()};assert.equal((await f.enroll(inv,node)).status,200);detail=await f.req('/api/console/invites/'+inv.id);assert.equal(detail.body.status,'enrolled');assert.equal(detail.body.usedBy,node.id);assert.ok(detail.body.usedAt);assert.equal(detail.body.node.online,false);assert.equal(detail.body.node.codexReady,null);
  f.db.db.prepare('UPDATE nodes SET capabilities=?,last_seen=? WHERE id=?').run(JSON.stringify({version:'0.3.4',ready:true,privateToken:'never-public',projects:['private']}),now(),node.id);
  const list=await f.req('/api/console/invites');assert.equal(list.body.total,1);assert.equal(list.body.invites[0].node.online,true);assert.equal(list.body.invites[0].node.version,'0.3.4');assert.equal(list.body.invites[0].node.codexReady,true);
  for(const output of [detail.body,list.body])for(const sensitive of ['token_hash',inv.token,hash(inv.token),node.token,hash(node.token),'never-public','capabilities'])assert.equal(JSON.stringify(output).includes(sensitive),false,sensitive);
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run('{"ready":false,"executorState":"ready"}',node.id);assert.equal((await f.req('/api/console/invites/'+inv.id)).body.node.codexReady,true);
  assert.equal((await f.req('/api/console/invites/'+inv.id)).body.node.desktopLinked,false);
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify({ready:true,desktopSessionBridge:false,desktopLaunch:{state:'failed',errorCode:'DESKTOP_APPLICATION_CONTROL_BLOCKED',error:'must-not-leak'}}),node.id);
  const blocked=(await f.req('/api/console/invites/'+inv.id)).body.node;
  assert.match(blocked.desktopIssue,/Windows 应用控制/);assert.equal(JSON.stringify(blocked).includes('must-not-leak'),false);
  f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify({ready:true,desktopSessionBridge:true,execution:'desktop-shared-app-server',workspaceCatalog:{state:'synced',count:31},secret:'must-not-leak'}),node.id);
  const linked=(await f.req('/api/console/invites/'+inv.id)).body.node;
  assert.equal(linked.desktopLinked,true);assert.equal(linked.workspaceState,'synced');assert.equal(linked.workspaceCount,31);assert.equal(JSON.stringify(linked).includes('must-not-leak'),false);
  f.db.db.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(node.id);assert.equal((await f.req('/api/console/invites/'+inv.id)).body.node.online,false);
});

test('operators, viewers, machine tokens and passwordless device sessions cannot manage or enumerate invitations',async t=>{
  const f=fixture(t),inv=(await f.create()).body,node={id:uid(),token:secret()};await f.enroll(inv,node);
  const deviceSession=secret();f.db.db.prepare('INSERT INTO device_sessions(hash,node,expires,created) VALUES(?,?,?,?)').run(hash(deviceSession),node.id,new Date(Date.now()+60000).toISOString(),now());f.db.db.prepare('UPDATE nodes SET console_access=? WHERE id=?').run('{"mode":"all","groupIds":[]}',node.id);
  for(const options of [{token:null,identity:f.member('operator')},{token:null,identity:f.member('viewer')},{token:node.token},{token:null,cookie:'__Host-fleet-device='+deviceSession}]){
    for(const route of ['/api/console/invites','/api/console/invites/'+inv.id])assert.equal((await f.req(route,options)).status,403);
    assert.equal((await f.create('PC-NEW',{},options)).status,403);assert.equal((await f.req('/api/console/invites/'+inv.id,{...options,method:'DELETE'})).status,403);
    assert.equal((await f.req('/v1/invites',{...options,method:'POST',data:{name:'PC-ALIAS',projects:['workspace']}})).status,403);
  }
  assert.equal((await f.req('/api/console/invites',{token:null})).status,401);
  assert.equal((await f.req('/api/console/invites',{token:null,identity:f.member('admin')})).status,200);
});

test('explicit console permissions are inherited once while old-style invitations safely grant no groups',async t=>{
  const f=fixture(t),g=await f.group('办公室'),access={mode:'groups',groupIds:[g.id,'__ungrouped__']},inv=(await f.create('PC-05',{consoleRole:'viewer',consoleAccess:access,groupId:g.id})).body,node={id:uid(),token:secret()};
  assert.equal((await f.enroll(inv,node)).status,200);let row=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(node.id);assert.equal(row.console_role,'viewer');assert.deepEqual(JSON.parse(row.console_access).groupIds.sort(),access.groupIds.sort());assert.equal(row.display_group_id,g.id);
  const changed={mode:'groups',groupIds:['__ungrouped__']};await f.req('/v1/nodes/'+node.id,{method:'PATCH',data:{consoleRole:'operator',consoleAccess:changed}});assert.equal((await f.enroll(inv,node)).status,200);row=f.db.db.prepare('SELECT * FROM nodes WHERE id=?').get(node.id);assert.equal(row.console_role,'operator');assert.deepEqual(JSON.parse(row.console_access),changed);
  const old={id:uid(),token:secret()};f.db.db.prepare('INSERT INTO invites(id,token_hash,name,projects,account_group,expires) VALUES(?,?,?,?,?,?)').run(old.id,hash(old.token),'PC-LEGACY','["workspace"]','shared-default',new Date(Date.now()+60000).toISOString());
  assert.equal((await f.req('/api/console/invites/'+old.id)).body.createdAt,null);const oldNode={id:uid(),token:secret()};assert.equal((await f.enroll(old,oldNode)).status,200);row=f.db.db.prepare('SELECT console_role,console_access FROM nodes WHERE id=?').get(oldNode.id);assert.equal(row.console_role,'operator');assert.deepEqual(JSON.parse(row.console_access),{mode:'groups',groupIds:[]});
  const all=(await f.create('PC-ALL',{consoleAccess:{mode:'all',groupIds:[]}})).body;assert.equal(all.consoleAccess.mode,'all');
  for(const extra of [{consoleRole:'admin'},{consoleAccess:{mode:'groups',groupIds:[uid()]}},{consoleAccess:{mode:'all',groupIds:['__ungrouped__']}},{consoleAccess:{mode:'unknown',groupIds:[]}}])assert.equal((await f.create('PC-BAD',extra)).status,400);
});

test('revocation and expiry prevent enrollment, used invitations remain idempotent and cannot be revoked',async t=>{
  const f=fixture(t),revoked=(await f.create('PC-REVOKE')).body;
  let res=await f.req('/api/console/invites/'+revoked.id,{method:'DELETE'});assert.equal(res.body.status,'revoked');const revokedAt=res.body.revokedAt;
  res=await f.req('/api/console/invites/'+revoked.id,{method:'DELETE'});assert.equal(res.body.revokedAt,revokedAt);assert.equal((await f.enroll(revoked)).body.code,'INVITATION_REVOKED');
  const expired=(await f.create('PC-EXPIRED')).body;f.db.db.prepare('UPDATE invites SET expires=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expired.id);assert.equal((await f.enroll(expired)).body.code,'INVITATION_EXPIRED');assert.equal((await f.req('/api/console/invites/'+expired.id)).body.status,'expired');assert.equal((await f.req('/api/console/invites/'+expired.id,{method:'DELETE'})).body.status,'revoked');
  const inv=(await f.create('PC-USED')).body,node={id:uid(),token:secret()};await f.enroll(inv,node);assert.equal((await f.req('/api/console/invites/'+inv.id,{method:'DELETE'})).body.code,'INVITATION_ALREADY_USED');assert.equal(f.stored(inv.id).revoked_at,null);
  f.db.db.prepare('UPDATE invites SET expires=? WHERE id=?').run('2000-01-01T00:00:00.000Z',inv.id);assert.equal((await f.enroll(inv,node)).status,200);assert.equal((await f.enroll(inv,{id:node.id,token:secret()})).status,403);assert.equal((await f.enroll(inv)).status,409);
  assert.equal((await f.req('/api/console/invites/'+uid(),{method:'DELETE'})).status,404);
});

test('case-insensitive pending and registered device codes are atomically unique; expired or revoked invites free the code',async t=>{
  const f=fixture(t),results=await Promise.all([f.create('PC-DUPE'),f.create('pc-dupe')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(results.find(r=>r.status===409).body.code,'INVITATION_PENDING_EXISTS');
  const inv=results.find(r=>r.status===200).body;await f.req('/api/console/invites/'+inv.id,{method:'DELETE'});const replacement=(await f.create('Pc-Dupe')).body;f.db.db.prepare('UPDATE invites SET expires=? WHERE id=?').run('2000-01-01T00:00:00.000Z',replacement.id);
  const fresh=(await f.create('PC-DUPE')).body;assert.ok(fresh.token);assert.equal((await f.enroll(fresh)).status,200);assert.equal((await f.create('pc-dupe')).body.code,'NODE_NAME_EXISTS');assert.equal(f.db.db.prepare('SELECT count(*) AS c FROM nodes').get().c,1);
});

test('deleting a group removes pending invitation grants and cannot widen them after that ID is recreated',async t=>{
  const f=fixture(t),g=await f.group('临时组'),inv=(await f.create('PC-GROUP',{groupId:g.id,consoleAccess:{mode:'groups',groupIds:[g.id]}})).body;
  await f.req('/v1/device-groups/'+g.id,{method:'DELETE'});assert.equal(f.stored(inv.id).display_group_id,null);assert.deepEqual(JSON.parse(f.stored(inv.id).console_access),{mode:'groups',groupIds:[]});
  await f.req('/v1/device-groups',{method:'POST',data:{id:g.id,name:'重建分组'}});const node={id:uid(),token:secret()};assert.equal((await f.enroll(inv,node)).status,200);assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT console_access FROM nodes WHERE id=?').get(node.id).console_access),{mode:'groups',groupIds:[]});
});

test('group deletion racing invitation creation cannot persist stale display or visibility grants',async t=>{
  const f=fixture(t),g=await f.group('即将删除');f.db.beforeRun=async sql=>{assert.ok(sql.includes('INSERT INTO invites'));await f.req('/v1/device-groups/'+g.id,{method:'DELETE'});};
  const result=await f.create('PC-STALE',{groupId:g.id,consoleAccess:{mode:'groups',groupIds:[g.id]}});assert.equal(result.status,409);assert.equal(result.body.code,'INVITATION_GROUP_CHANGED');assert.equal(f.db.db.prepare('SELECT count(*) AS c FROM invites').get().c,0);
});

test('enrollment does not adopt pre-existing node identities or overwrite permissions and handles revoke-before-reservation',async t=>{
  const f=fixture(t),first=(await f.create('PC-FIRST')).body,node={id:uid(),token:secret()};await f.enroll(first,node);const second=(await f.create('PC-SECOND',{consoleAccess:{mode:'all',groupIds:[]}})).body;
  assert.equal((await f.enroll(second,node)).status,409);assert.equal(f.stored(second.id).used_by,null);assert.equal(f.db.db.prepare('SELECT count(*) AS c FROM nodes').get().c,1);assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT console_access FROM nodes WHERE id=?').get(node.id).console_access),{mode:'groups',groupIds:[]});
  const collision={id:uid(),token:node.token};assert.equal((await f.enroll(second,collision)).status,409);assert.equal(f.stored(second.id).used_by,null);
  f.db.beforeBatch=async()=>{assert.equal((await f.req('/api/console/invites/'+second.id,{method:'DELETE'})).status,200);};assert.equal((await f.enroll(second)).body.code,'INVITATION_REVOKED');assert.equal(f.db.db.prepare('SELECT count(*) AS c FROM nodes').get().c,1);
});

test('invite list keyset pagination counts all rows, includes undated legacy records and binds cursor to status',async t=>{
  const f=fixture(t);for(let i=0;i<7;i++)await f.create('PC-'+i);
  const first=await f.req('/api/console/invites?status=pending&limit=3');assert.equal(first.body.invites.length,3);assert.equal(first.body.total,7);assert.ok(first.body.nextCursor);
  const second=await f.req('/api/console/invites?status=pending&limit=3&cursor='+first.body.nextCursor),third=await f.req('/api/console/invites?status=pending&limit=3&cursor='+second.body.nextCursor);assert.equal(new Set([...first.body.invites,...second.body.invites,...third.body.invites].map(i=>i.id)).size,7);assert.equal(third.body.nextCursor,null);
  assert.equal((await f.req('/api/console/invites?status=all&cursor='+first.body.nextCursor)).status,400);
  assert.equal((await f.req('/api/console/invites?status=unknown')).status,400);assert.equal((await f.req('/api/console/invites?limit=101')).status,400);assert.equal((await f.req('/api/console/invites?cursor=invalid')).status,400);
  f.db.db.prepare('UPDATE invites SET created_at=NULL WHERE id=?').run(first.body.invites[0].id);const all=await f.req('/api/console/invites');assert.equal(all.body.invites.at(-1).createdAt,null);
});

test('suggested device code considers all registered and pending identities independently of invite filters or page size',async t=>{
  const f=fixture(t);
  for(const name of ['PC-01','pc-02','PC-03']){const inv=(await f.create(name)).body;assert.equal((await f.enroll(inv)).status,200);}
  f.db.db.prepare("UPDATE nodes SET revoked=1 WHERE name='PC-01'").run();
  const pending=(await f.create('pc-04')).body,expired=(await f.create('PC-05')).body,revoked=(await f.create('PC-06')).body;
  f.db.db.prepare('UPDATE invites SET expires=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expired.id);await f.req('/api/console/invites/'+revoked.id,{method:'DELETE'});
  const first=await f.req('/api/console/invites?status=enrolled&limit=1');assert.equal(first.body.suggestedCode,'PC-05');assert.equal(first.body.invites.length,1);assert.ok(first.body.nextCursor);
  assert.equal((await f.req('/api/console/invites?status=enrolled&limit=1&cursor='+first.body.nextCursor)).body.suggestedCode,'PC-05');
  await f.req('/api/console/invites/'+pending.id,{method:'DELETE'});assert.equal((await f.req('/api/console/invites?status=pending&limit=1')).body.suggestedCode,'PC-04');
  const denied=await f.req('/api/console/invites',{token:null,identity:f.member('operator')});assert.equal(denied.status,403);assert.equal(denied.body.suggestedCode,undefined);
});
