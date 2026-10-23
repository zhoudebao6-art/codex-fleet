import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {createInvitation,enrollInvitation,revokeInvitation,listInvitations,invitationDetail} from '../invitations.mjs';
import {deleteDeviceGroup} from '../device-management.mjs';
import {uid,secret,now,hash} from '../util.mjs';

test('actual D1 invite transactions serialize revocation, duplicate creation, enrollment and grants without orphan nodes',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'invitation-regression'},d1Persist:false});
  try{
    const raw=await mf.getD1Database('DB'),migrationDir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
    const run=(sql,...args)=>raw.prepare(sql).bind(...args).run(),first=(sql,...args)=>raw.prepare(sql).bind(...args).first();
    const migrations=fs.readdirSync(migrationDir).filter(n=>n.endsWith('.sql')).sort();
    for(const name of migrations.filter(n=>n<'0010'))for(const sql of fs.readFileSync(migrationDir+'/'+name,'utf8').split(/--> statement-breakpoint|;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean))await run(sql);
    // A real pre-upgrade invitation keeps its token and old node identities;
    // new defaults are least privilege, with honest unknown creation dates.
    const oldId=uid(),oldToken=secret();await run('INSERT INTO invites(id,token_hash,name,projects,account_group,expires) VALUES(?,?,?,?,?,?)',oldId,hash(oldToken),'PC-OLD','["workspace"]','shared-default',new Date(Date.now()+60000).toISOString());
    for(const name of migrations.filter(n=>n>='0010'))for(const sql of fs.readFileSync(migrationDir+'/'+name,'utf8').split(/--> statement-breakpoint|;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean))await run(sql);
    let beforeBatch=null,beforeRun=null;
    const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},statement(){return raw.prepare(this.sql).bind(...this.args);},first(){return this.statement().first();},all(){return this.statement().all();},async run(){if(beforeRun){const hook=beforeRun;beforeRun=null;await hook(this.sql);}return this.statement().run();}};},async batch(items){if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}return raw.batch(items.map(i=>i.statement()));}};
    const admin={id:'admin',admin:true},create=(name,extra={})=>createInvitation(db,admin,{name,projects:['workspace'],...extra},'https://fleet.example.test'),enroll=(inv,nodeId=uid(),nodeToken=secret())=>enrollInvitation(db,{token:inv.token,nodeId,nodeToken});
    const old=await invitationDetail(db,admin,oldId);assert.equal(old.createdAt,null);assert.deepEqual(old.consoleAccess,{mode:'groups',groupIds:[]});assert.equal((await enroll({token:oldToken})).name,'PC-OLD');assert.equal((await first('SELECT token_hash FROM invites WHERE id=?',oldId)).token_hash,hash(oldToken));

    const concurrent=await Promise.allSettled([create('PC-CONCURRENT'),create('pc-concurrent')]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.find(r=>r.status==='rejected').reason.code,'INVITATION_PENDING_EXISTS');
    const inv=concurrent.find(r=>r.status==='fulfilled').value,candidates=[{id:uid(),token:secret()},{id:uid(),token:secret()}];
    const results=await Promise.allSettled(candidates.map(n=>enroll(inv,n.id,n.token)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await first('SELECT count(*) AS count FROM nodes WHERE name=? COLLATE NOCASE','PC-CONCURRENT')).count,1);
    const winner=candidates[results.findIndex(r=>r.status==='fulfilled')];await enroll(inv,winner.id,winner.token);assert.ok((await first('SELECT used_at FROM invites WHERE id=?',inv.id)).used_at);
    await assert.rejects(()=>revokeInvitation(db,admin,inv.id),e=>e.code==='INVITATION_ALREADY_USED');

    const revoked=await create('PC-REVOKED'),blockedNode=uid();beforeBatch=()=>revokeInvitation(db,admin,revoked.id);await assert.rejects(()=>enroll(revoked,blockedNode),e=>e.code==='INVITATION_REVOKED');assert.equal(await first('SELECT id FROM nodes WHERE id=?',blockedNode),null);assert.equal((await first('SELECT used_by FROM invites WHERE id=?',revoked.id)).used_by,null);
    // The opposite interleaving must preserve the successful enrollment and
    // reject revocation, never report a revoked invitation for a live node.
    const used=await create('PC-ENROLL-FIRST');beforeRun=()=>enroll(used);await assert.rejects(()=>revokeInvitation(db,admin,used.id),e=>e.code==='INVITATION_ALREADY_USED');assert.equal((await first('SELECT revoked_at FROM invites WHERE id=?',used.id)).revoked_at,null);

    const group=uid();await run('INSERT INTO device_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)',group,'Private office',now(),now());
    const scoped=await create('PC-SCOPED',{groupId:group,consoleRole:'viewer',consoleAccess:{mode:'groups',groupIds:[group]}}),scopedNode=uid();await enroll(scoped,scopedNode);let node=await first('SELECT console_role,console_access FROM nodes WHERE id=?',scopedNode);assert.equal(node.console_role,'viewer');assert.deepEqual(JSON.parse(node.console_access),{mode:'groups',groupIds:[group]});
    const pending=await create('PC-PENDING-GROUP',{consoleAccess:{mode:'groups',groupIds:[group]}});await deleteDeviceGroup(db,admin,group);const pendingNode=uid();await enroll(pending,pendingNode);node=await first('SELECT console_access FROM nodes WHERE id=?',pendingNode);assert.deepEqual(JSON.parse(node.console_access),{mode:'groups',groupIds:[]});
    const list=await listInvitations(db,admin,new URL('https://fleet.example.test/api/console/invites?status=enrolled&limit=2'));assert.equal(list.invites.length,2);assert.ok(list.nextCursor);assert.equal(list.total,5);assert.equal(JSON.stringify(list).includes('token_hash'),false);
  }finally{await mf.dispose();}
});
