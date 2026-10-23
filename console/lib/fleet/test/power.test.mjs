import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {handle} from '../handler.mjs';
import {hash,secret,uid,now} from '../util.mjs';
function fixture(t){
 const db0=new DatabaseSync(':memory:');t.after(()=>db0.close());
 const dir=new URL('../../../drizzle/',import.meta.url);for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db0.exec(fs.readFileSync(new URL(f,dir),'utf8'));
 const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db0.prepare(sql).get(...this.args)||null;},async all(){return {results:db0.prepare(sql).all(...this.args)};},async run(){return {meta:{changes:db0.prepare(sql).run(...this.args).changes}};}};}};
 const token=secret(),env={DB:db,FLEET_ADMIN_TOKEN:token};
 const node=(online=true)=>{const id=uid(),key=secret();db0.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities) VALUES(?,?,?,?,?,?,?)').run(id,id,hash(key),'["workspace"]','group',online?now():'2020-01-01T00:00:00Z','{"ready":true}');return {id,key};};
 const req=async(route,body,auth=token,method=body?'POST':'GET')=>{const r=await handle(new Request('https://fleet.test'+route,{method,headers:{authorization:'Bearer '+auth,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);return {status:r.status,body:await r.json()};};
 const report=(networkId='a'.repeat(64))=>({version:'0.1.0',networks:[{networkId,address:'192.168.2.20',subnet:'192.168.2.0',broadcast:'192.168.2.255',prefix:24,mac:'00:e0:4f:45:c5:66',wakeOnMagicPacket:'Enabled',wakeArmed:true}],inventory:{sleep:{s3:true},adapters:[]},guard:{active:true,apiOk:true,at:now()}});
 const poll=(n,data=report())=>req('/v1/power/poll',data,n.key),wake=(n,probe=false,id=uid())=>req('/v1/nodes/'+n.id+'/wake',{id,probe});
 return {db0,node,req,poll,wake,report};
}
test('offline wake uses only live relays on matching physical networks; sending is not waking',async t=>{
 const f=fixture(t),a=f.node(false),relay=f.node(),remote=f.node();await f.poll(a);await f.poll(relay);await f.poll(remote,f.report('b'.repeat(64)));
 const created=await f.wake(a);assert.equal(created.status,200);assert.deepEqual(created.body.relays.map(r=>r.nodeId),[relay.id]);
 assert.equal((await f.poll(remote,f.report('b'.repeat(64)))).body.actions.length,0);
 const act=(await f.poll(relay)).body.actions[0];assert.equal(act.kind,'wake');
 assert.equal((await f.req('/v1/power/actions/'+act.id+'/ack',{id:act.id,status:'sent',evidence:[{networkId:'a'.repeat(64),bytes:102,packets:3}]},remote.key)).status,403);
 await f.req('/v1/power/actions/'+act.id+'/ack',{id:act.id,status:'sent',evidence:[{networkId:'a'.repeat(64),bytes:102,packets:3}]},relay.key);
 let view=(await f.req('/v1/nodes/'+a.id+'/power')).body;assert.equal(view.actions[0].status,'sent');assert.equal((await f.poll(relay)).body.actions.length,0);
 f.db0.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(new Date(Date.now()+1000).toISOString(),a.id);
 view=(await f.req('/v1/nodes/'+a.id+'/power')).body;assert.equal(view.actions[0].status,'ready');
});
test('online link tests never claim a sleep/wake test passed; retries are idempotent',async t=>{
 const f=fixture(t),a=f.node(),relay=f.node();await f.poll(a);await f.poll(relay);assert.equal((await f.wake(a)).status,409);
 const id=uid(),first=await f.wake(a,true,id);assert.equal((await f.wake(a,true,id)).body.id,id);assert.equal((await f.wake(relay,true,id)).status,409);
 await f.req('/v1/power/actions/'+id+'/ack',{id,status:'sent',evidence:[{networkId:'a'.repeat(64),bytes:102,packets:3}]},relay.key);
 assert.equal((await f.req('/v1/nodes/'+a.id+'/power')).body.actions[0].status,'packet_sent');
});
test('no same LAN relay is a clear blocker; stale relay and node tokens cannot set policy',async t=>{
 const f=fixture(t),a=f.node(false),b=f.node();await f.poll(a);await f.poll(b);
 f.db0.prepare("UPDATE power_nodes SET reported_at='2020-01-01' WHERE node=?").run(b.id);
 assert.equal((await f.wake(a)).status,409);
 assert.equal((await f.req('/v1/nodes/'+a.id+'/power',{mode:'off'},a.key,'PATCH')).status,403);
 assert.equal((await f.req('/v1/nodes/'+a.id+'/power',{mode:'off'},undefined,'PATCH')).status,200);
 assert.equal((await f.poll(a)).body.policy.mode,'off');
});
test('wake timeout is terminal and does not repeatedly send packets',async t=>{
 const f=fixture(t),a=f.node(false),b=f.node();await f.poll(a);await f.poll(b);const x=await f.wake(a);
 f.db0.prepare("UPDATE wake_actions SET expires_at='2020-01-01' WHERE id=?").run(x.body.id);
 assert.equal((await f.req('/v1/nodes/'+a.id+'/power')).body.actions[0].status,'timeout');assert.equal((await f.poll(b)).body.actions.length,0);
});
test('guard freshness uses a relative age across Windows and cloud clock skew',async t=>{
 const f=fixture(t),a=f.node(),r=f.report();r.guard.at='2020-01-01';r.guard.ageMs=2000;
 await f.poll(a,r);const view=(await f.req('/v1/nodes/'+a.id+'/power')).body;
 assert.ok(Math.abs(Date.now()-Date.parse(view.guard.at)-2000)<1000);
 assert.equal(view.guardFresh,true);
 r.guard.ageMs=90000;await f.poll(a,r);const old=(await f.req('/v1/nodes/'+a.id+'/power')).body;
 assert.ok(Date.now()-Date.parse(old.guard.at)>85000);
 assert.equal(old.guardFresh,false);
});
test('revoking the requesting device prevents queued wake delivery',async t=>{
 const f=fixture(t),target=f.node(false),relay=f.node(),caller=f.node();
 await f.poll(target);await f.poll(relay);
 const action=await f.req('/v1/nodes/'+target.id+'/wake',{id:uid()},caller.key);
 assert.equal(action.status,200);
 f.db0.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(caller.id);
 assert.equal((await f.poll(relay)).body.actions.length,0);
});
