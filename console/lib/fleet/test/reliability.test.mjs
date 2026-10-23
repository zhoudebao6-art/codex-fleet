import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {submit,sync,taskAccess} from '../tasks.mjs';
import {hash,uid,now,json} from '../util.mjs';
import {nodeRuntime} from '../runtime-readiness.mjs';
import {capacityView} from '../capacity.mjs';
import {controllerRecovery,transferController,withControllerTick} from '../controller-recovery.mjs';
import {createBackup,downloadBackup,planBackupSegments,backupView} from '../backups.mjs';
import {restoreBackup,snapshotLocalStore} from '../../../public/fleet-restore.mjs';
const admin={id:'admin',admin:true,browser:false};
const caps={ready:true,parallelExecution:true,maxRunning:4,projects:['workspace'],desktopContinuation:true,desktopSessionBridge:true,conversationDispatch:true,conversationReady:true,conversationSlots:4,deliveryControl:true};
class D1 {
 constructor(){this.db=new DatabaseSync(':memory:');const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())this.db.exec(fs.readFileSync(path.join(dir,file),'utf8'));}
 prepare(sql){const d=this;return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return d.db.prepare(sql).get(...this.args)||null;},async all(){return {results:d.db.prepare(sql).all(...this.args)};},async run(){return {meta:{changes:Number(d.db.prepare(sql).run(...this.args).changes)}};}};}
 async batch(items){this.db.exec('BEGIN');try{const results=items.map(i=>/^\s*(SELECT|PRAGMA)/i.test(i.sql)?{results:this.db.prepare(i.sql).all(...i.args),meta:{changes:0}}:{meta:{changes:Number(this.db.prepare(i.sql).run(...i.args).changes)}});this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
function fixture(t){const db=new D1();t.after(()=>db.db.close());const node=(id,extra={})=>{db.db.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,fingerprint,last_seen,capabilities) VALUES(?,?,?,?,?,?,?,?)').run(id,id,hash(id),'["workspace"]','shared','f'.repeat(64),now(),json({...caps,...extra}));return {id,projects:'["workspace"]',admin:false,browser:false};};
 const spec=(n,extra={})=>({id:uid(),targetNode:n.id,project:'workspace',prompt:'isolated fixture only',mode:'execute',worktree:false,...extra});
 const poll=(n,extra={})=>sync(db,n,{events:[],capabilities:{...caps,accountFingerprint:'f'.repeat(64),...extra}});
 return {db,node,spec,poll};}
test('fresh heartbeat never makes stale or failed desktop health dispatchable',()=>{
 const n={lastSeen:now(),capabilities:{...caps,desktopBridgeHealth:{ready:false,checkedAt:now()}}};assert.equal(nodeRuntime(n).canConverse,false);
 assert.equal(nodeRuntime({...n,lastSeen:'2000-01-01'}).state,'offline');
 assert.equal(nodeRuntime({...n,capabilities:{...caps,desktopBridgeHealth:{ready:true,checkedAt:'2000-01-01'}}}).canExecute,false);
 assert.equal(nodeRuntime({...n,capabilities:{...caps,ready:false,executorState:'ready'}}).canConverse,true);
});
test('shared-account budget covers conversations and ordinary tasks without changing existing attempts',async t=>{
 const f=fixture(t),a=f.node('a'),b=f.node('b');f.db.db.prepare("INSERT INTO settings VALUES('default_group_limit','1')").run();
 const sa=f.spec(a,{intent:'conversation',requireDesktop:true}),sb=f.spec(b);await submit(f.db,admin,sa);await submit(f.db,admin,sb);
 const claimed=(await f.poll(a)).tasks[0];assert.equal(claimed.id,sa.id);assert.equal((await f.poll(b)).tasks.length,0);
 assert.match((await taskAccess(f.db,admin,sb.id)).waitReason,/同账号/);
 await f.poll(a,{desktopBridgeHealth:{ready:false,checkedAt:now()}});const unchanged=f.db.db.prepare('SELECT * FROM tasks WHERE id=?').get(sa.id);assert.equal(unchanged.attempt,claimed.attempt);assert.equal(unchanged.status,'claimed');
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(sa.id);assert.equal((await f.poll(b)).tasks[0].id,sb.id);
});
test('repeated cached desktop checks do not renew their server freshness',async t=>{
 const f=fixture(t),a=f.node('a'),checkedAt=now(),old='2000-01-01T00:00:00.000Z';
 f.db.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(json({...caps,desktopBridgeHealth:{ready:true,checkedAt},desktopHealthReceivedAt:old}),a.id);
 const spec=f.spec(a,{intent:'conversation',requireDesktop:true});await submit(f.db,admin,spec);
 assert.equal((await f.poll(a,{desktopBridgeHealth:{ready:true,checkedAt}})).tasks.length,0);
 assert.equal(JSON.parse(f.db.db.prepare('SELECT capabilities FROM nodes WHERE id=?').get(a.id).capabilities).desktopHealthReceivedAt,old);
 assert.equal((await f.poll(a,{desktopBridgeHealth:{ready:true,checkedAt:new Date(Date.now()+1000).toISOString()}})).tasks[0].id,spec.id);
});
test('native observations occupy the budget and steering reuses an existing thread slot',async t=>{
 const f=fixture(t),a=f.node('a'),b=f.node('b');f.db.db.prepare("INSERT INTO settings VALUES('default_group_limit','1')").run();
 const thread=uid();f.db.db.prepare("INSERT INTO desktop_threads(node,thread_id,project,title,updated_at,observed_at,status,status_source,received_at) VALUES(?,?,'workspace','existing',?,?,'running','app_server_runtime',?)").run(a.id,thread,now(),now(),now());
 const other=f.spec(b);await submit(f.db,admin,other);assert.equal((await f.poll(b)).tasks.length,0);
 const message=f.spec(a,{desktopThreadId:thread,desktopCwd:'E:/fixture'});await submit(f.db,admin,message,null,{desktopContinuation:true});assert.equal((await f.poll(a)).tasks[0].id,message.id);
 f.db.db.prepare("UPDATE tasks SET status='running',thread_id=? WHERE id=?").run(thread,message.id);assert.equal((await capacityView(f.db,a.id)).accountUsed,1,'native and managed observation deduplicate');
 const next=f.spec(a,{desktopThreadId:thread,desktopCwd:'E:/fixture'});await submit(f.db,admin,next,null,{desktopContinuation:true});assert.ok((await f.poll(a)).tasks.some(t=>t.id===next.id));
});
test('lowering node budget queues new work but keeps running attempt and cancellation recovery',async t=>{
 const f=fixture(t),a=f.node('a');const first=f.spec(a);await submit(f.db,admin,first);const run=(await f.poll(a)).tasks[0];f.db.db.prepare("UPDATE tasks SET status='uncertain' WHERE id=?").run(run.id);
 f.db.db.prepare("INSERT INTO settings VALUES('parallel_limit:a','1')").run();const next=f.spec(a);await submit(f.db,admin,next);const state=await f.poll(a);assert.equal(state.tasks[0].id,run.id);assert.equal(state.tasks[0].attempt,run.attempt);assert.equal(state.tasks.length,1);assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(next.id).status,'queued');
});
test('scheduler lease excludes overlaps and fences an expired handler before any late write',async t=>{
 const f=fixture(t),a=f.node('a');f.db.db.prepare("INSERT INTO settings VALUES('delivery_controller',?)").run(json({controller:a.id,excludedNodes:[]}));
 await withControllerTick(f.db,a,async guarded=>{assert.equal((await withControllerTick(f.db,a,async()=>{throw Error('overlap');})).busy,true);
  f.db.db.prepare("UPDATE settings SET value=? WHERE key='delivery_controller_lock'").run(json({token:'replacement',expiresAt:new Date(Date.now()+60000).toISOString()}));
  await assert.rejects(guarded.prepare("INSERT INTO settings VALUES('must-not-exist','true')").run());return {operations:[]};
 }).then(()=>assert.fail('expired tick must fail'),()=>{});
 assert.equal(f.db.db.prepare("SELECT * FROM settings WHERE key='must-not-exist'").get(),undefined);
 assert.ok(f.db.db.prepare("SELECT * FROM settings WHERE key='delivery_controller_lock'").get(),'old handler cannot delete the new lease');
});
test('controller handover blocks active work, preserves attempts, and pauses recovered batches',async t=>{
 const f=fixture(t),a=f.node('a'),b=f.node('b');f.db.db.prepare("INSERT INTO settings VALUES('delivery_controller',?)").run(json({controller:a.id,dispatchMode:'direct',excludedNodes:[]}));
 const s=f.spec(b);await submit(f.db,a,s);const running=(await f.poll(b)).tasks[0];f.db.db.prepare("UPDATE nodes SET last_seen='2000-01-01' WHERE id='a'").run();
 const v=await controllerRecovery(f.db,admin);assert.equal(v.canTransfer,false);await assert.rejects(transferController(f.db,admin,{id:'recover',target:b.id,revision:v.revision,reason:'original controller unavailable'}));
 assert.equal(f.db.db.prepare('SELECT attempt FROM tasks WHERE id=?').get(s.id).attempt,running.attempt);
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(s.id);
 f.db.db.prepare("INSERT INTO delivery_batches(id,creator,creator_kind,controller,project,declaration,declaration_hash,status,created_at,updated_at) VALUES('batch','admin','service','a','workspace',?,'h','collecting',?,?)").run(json({name:'batch',profile:'software',nodes:[b.id]}),now(),now());
 const ready=await controllerRecovery(f.db,admin),body={id:'recover',target:b.id,revision:ready.revision,reason:'original controller unavailable'};const receipt=await transferController(f.db,admin,body);assert.equal(receipt.to,b.id);
 assert.deepEqual(await transferController(f.db,admin,body),receipt);const row=f.db.db.prepare("SELECT * FROM delivery_batches WHERE id='batch'").get();assert.equal(row.controller,b.id);assert.equal(row.status,'paused');assert.equal(JSON.parse(row.error).resume,'collecting');
 assert.equal((await withControllerTick(f.db,a,async()=>{throw Error('old controller');})).enabled,false);
});
test('business snapshot includes immutable bytes and restores offline without changing live records',async t=>{
 const f=fixture(t),a=f.node('a'),spec=f.spec(a);f.node('b');await submit(f.db,admin,spec);const active=(await f.poll(a)).tasks[0];
 const content=Buffer.from('真实成果\nproof of restore'),sha=hash(content),key='fleet/fixture/chunk';
 f.db.db.prepare("INSERT INTO files(id,project,sha,size,name,status,offset,owner,created,updated) VALUES('file','workspace',?,?,'成果.txt','complete',?,'admin',?,?)").run(sha,content.length,content.length,now(),now());
 f.db.db.prepare("INSERT INTO file_chunks(project,sha,offset,size,key,digest) VALUES('workspace',?,0,?,?,?)").run(sha,content.length,key,sha);
 f.db.db.prepare("INSERT INTO artifact_refs VALUES(?,?,'成果.txt','output')").run(spec.id,sha);
 const info=await createBackup(f.db,admin,{id:'backup'});assert.equal(info.files,1);assert.deepEqual(await createBackup(f.db,admin,{id:'backup'}),info);
 const bucket={get:async k=>k===key?{body:new Response(content).body}:null};
 f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(spec.id);
 const archive=await (await downloadBackup(f.db,bucket,admin,'backup')).text();assert.ok(!archive.includes(hash(a.id)),'node credential hashes are excluded');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-restore-test-')),file=path.join(dir,'backup.ndjson');t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('fleet-restore-test-'));fs.rmSync(dir,{recursive:true,force:true});});fs.writeFileSync(file,archive);
 const result=await restoreBackup(file,path.join(dir,'restored'));assert.equal(result.verifiedFiles,1);
 assert.deepEqual(fs.readFileSync(path.join(dir,'restored',result.files[0].path)),content);
 const restored=new DatabaseSync(path.join(dir,'restored','fleet.sqlite'));try{const task=restored.prepare('SELECT status,attempt FROM tasks WHERE id=?').get(spec.id);assert.equal(task.status,'uncertain');assert.equal(task.attempt,active.attempt);assert.equal(restored.prepare('SELECT revoked FROM nodes').get().revoked,1);}finally{restored.close();}
 assert.equal(f.db.db.prepare('SELECT status FROM tasks WHERE id=?').get(spec.id).status,'submitted');
 fs.writeFileSync(path.join(dir,'truncated.ndjson'),archive.split('\n').slice(0,-2).join('\n')+'\n');await assert.rejects(restoreBackup(path.join(dir,'truncated.ndjson'),path.join(dir,'bad')),/截断/);
 await assert.rejects(restoreBackup(file,path.join(dir,'restored')),/不存在/);
 const source=path.join(dir,'live.sqlite');const local=new DatabaseSync(source);local.exec('PRAGMA journal_mode=WAL;CREATE TABLE outbox(id TEXT);INSERT INTO outbox VALUES(\'pending\')');snapshotLocalStore(source,path.join(dir,'local-copy.sqlite'));assert.equal(local.prepare('SELECT count(*) n FROM outbox').get().n,1);local.close();
});
test('missing or corrupt object cannot produce a successful backup footer',async t=>{
 const f=fixture(t),a=f.node('a');const sha=hash('bytes');f.db.db.prepare("INSERT INTO file_chunks VALUES('workspace',?,0,5,'missing',?)").run(sha,sha);await createBackup(f.db,admin,{id:'missing'});
 const r=await downloadBackup(f.db,{get:async()=>null},admin,'missing');await assert.rejects(r.text(),/缺失/);
});
test('independent backup segments restore together, reject missing parts, and coalesce tiny object reads',async t=>{
 const f=fixture(t);f.node('a');f.node('b');const bytes=Buffer.alloc(5000,7),sha=hash(bytes),key='segmented-object';
 f.db.db.prepare("INSERT INTO files(id,project,sha,size,name,status,offset,owner,created,updated) VALUES('file','workspace',5000,5000,'proof.bin','complete',5000,'admin',?,?)").run(now(),now());
 f.db.db.prepare("UPDATE files SET sha=? WHERE id='file'").run(sha);f.db.db.prepare("INSERT INTO file_chunks VALUES('workspace',?,0,5000,?,?)").run(sha,key,sha);
 await createBackup(f.db,admin,{id:'segmented'});const parts=await planBackupSegments(f.db,'segmented',1000);assert.ok(parts.length>1);f.db.db.prepare("UPDATE settings SET value=? WHERE key='backup:segmented:segments'").run(json(parts));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-segments-test-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('fleet-segments-test-'));fs.rmSync(dir,{recursive:true,force:true});});
 const bucket={get:async()=>({body:new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=100)c.enqueue(bytes.subarray(i,i+100));c.close();}})})};let blobs=0;
 for(const part of parts){const body=await (await downloadBackup(f.db,bucket,admin,'segmented',part.index)).text();blobs+=body.split('\n').filter(s=>s.startsWith('{"type":"blob"')).length;fs.writeFileSync(path.join(dir,part.filename),body);if(part.index<parts.length)assert.equal((await backupView(f.db,admin,'segmented')).status,'ready');}
 assert.equal(blobs,1);assert.equal((await backupView(f.db,admin,'segmented')).status,'verified');const result=await restoreBackup(path.join(dir,parts[0].filename),path.join(dir,'restored'));assert.equal(result.verifiedFiles,1);assert.deepEqual(fs.readFileSync(path.join(dir,'restored',result.files[0].path)),bytes);
 fs.renameSync(path.join(dir,parts[1].filename),path.join(dir,'missing.part'));await assert.rejects(restoreBackup(path.join(dir,parts[0].filename),path.join(dir,'incomplete')),/缺少第 2/);
 await assert.rejects(downloadBackup(f.db,bucket,admin,'segmented',0),/不存在/);
});
