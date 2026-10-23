import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {submit,sync} from '../tasks.mjs';
import {createAutomation} from '../orchestration.mjs';
import {hash,uid,now,json} from '../util.mjs';

// node:sqlite has a higher expression-depth ceiling than production D1. This
// test uses workerd's actual D1 implementation so a valid local SQL query cannot
// silently break every production heartbeat again.
test('D1 claims native and scoped tasks without exceeding its expression limit, while atomic workflow revocation still wins',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'claim-regression'},d1Persist:false});
  try{
    const raw=await mf.getD1Database('DB'),migrations=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
    for(const name of fs.readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()){
      const statements=fs.readFileSync(new URL('../../../drizzle/'+name,import.meta.url),'utf8').split(/--> statement-breakpoint|;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean);
      for(const sql of statements)await raw.prepare(sql).run();
    }
    let beforeClaim=null;
    const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},statement(){return raw.prepare(this.sql).bind(...this.args);},first(){return this.statement().first();},all(){return this.statement().all();},run(){return this.statement().run();}};},async batch(items){if(beforeClaim&&items.some(s=>s.sql.includes("UPDATE tasks SET status='claimed'")))await beforeClaim();return raw.batch(items.map(s=>s.statement()));}};
    const run=(sql,...args)=>raw.prepare(sql).bind(...args).run(),admin={id:'admin',admin:true,browser:false};
    const caps={ready:true,projects:['workspace'],desktopContinuation:true,localExecutionPolicy:true,workspaceExecution:true};
    for(const id of ['group-a','group-b'])await run('INSERT INTO device_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)',id,id,now(),now());
    const nodes=['a','b'].map(id=>({id:'node-'+id,projects:'["workspace"]',admin:false,browser:false}));
    for(const n of nodes)await run('INSERT INTO nodes(id,name,token_hash,projects,account_group,last_seen,capabilities,display_group_id) VALUES(?,?,?,?,?,?,?,?)',n.id,n.id,hash(n.id),n.projects,n.id,now(),json(caps),'group-'+n.id.at(-1));
    const [a,b]=nodes,plain=n=>({id:uid(),targetNode:n.id,project:'workspace',prompt:'No external execution; database fixture only',mode:'question',worktree:false});
    const native={...plain(a),mode:'execute',desktopThreadId:uid(),desktopCwd:'D:/Fixture'};
    await submit(db,admin,native,null,{desktopContinuation:true});
    let polled=await sync(db,a,{events:[],capabilities:caps});assert.equal(polled.tasks[0].id,native.id);assert.equal(polled.tasks[0].status,'claimed');assert.ok(polled.tasks[0].attempt);
    await run("UPDATE tasks SET status='submitted' WHERE id=?",native.id);
    const access={mode:'groups',groupIds:['group-a','group-b']},member={id:'member:operator',memberId:'operator',role:'operator',admin:false,browser:true,kind:'member',access};
    await run('INSERT INTO members(id,email,role,created,group_access) VALUES(?,?,?,?,?)','operator','operator@example.test','operator',now(),json(access));
    const scoped=plain(b);await submit(db,member,scoped);polled=await sync(db,b,{events:[],capabilities:caps});assert.equal(polled.tasks[0].id,scoped.id);await run("UPDATE tasks SET status='submitted' WHERE id=?",scoped.id);
    const device={id:'device:'+a.id,nodeId:a.id,projects:a.projects,role:'operator',admin:false,browser:true,kind:'device',access};
    await run('UPDATE nodes SET console_access=? WHERE id=?',json(access),a.id);
    const deviceTask=plain(b);await submit(db,device,deviceTask);polled=await sync(db,b,{events:[],capabilities:caps});assert.equal(polled.tasks[0].id,deviceTask.id);await run("UPDATE tasks SET status='submitted' WHERE id=?",deviceTask.id);
    const flow=await createAutomation(db,member,{id:uid(),name:'Scoped handoff',project:'workspace',steps:nodes.map(n=>({name:n.id,targetNode:n.id,prompt:'Fixture',mode:'question',worktree:false}))});
    assert.equal(flow.steps[0].status,'queued');let revoked=false;
    beforeClaim=async()=>{revoked=true;await run('UPDATE members SET group_access=? WHERE id=?',json({mode:'groups',groupIds:['group-a']}),'operator');};
    polled=await sync(db,a,{events:[],capabilities:caps});assert.equal(revoked,true);assert.deepEqual(polled.tasks,[]);
    const pending=await raw.prepare('SELECT status,attempt FROM tasks WHERE id=?').bind(flow.steps[0].taskId).first();assert.equal(pending.status,'queued');assert.equal(pending.attempt,null);
    // A configuration change may arrive after the application reads a task but
    // before D1 claims it. The delivery guard must see that same-write state.
    beforeClaim=null;
    await run("INSERT INTO settings(key,value) VALUES('delivery_controller',?)",json({controller:a.id,excludedNodes:[]}));
    const delivery=plain(b),batchId=uid();await submit(db,a,delivery);
    await run("INSERT INTO delivery_batches(id,creator,creator_kind,controller,project,status,declaration,declaration_hash,created_at,updated_at) VALUES(?,?,'node',?,'workspace','preflight',?,'fixture',?,?)",batchId,a.id,a.id,json({nodes:[b.id],profile:'software'}),now(),now());
    await run("INSERT INTO delivery_jobs(id,batch_id,phase,item_index,node,attempt,task_id,spec,created_at) VALUES(?,?,'preflight',0,?,0,?,?,?)",delivery.id,batchId,b.id,delivery.id,json(delivery),now());
    beforeClaim=async()=>{await run("UPDATE settings SET value=? WHERE key='delivery_controller'",json({controller:a.id,excludedNodes:[b.id]}));};
    polled=await sync(db,b,{events:[],capabilities:caps});assert.deepEqual(polled.tasks,[]);
    assert.equal((await raw.prepare('SELECT status FROM tasks WHERE id=?').bind(delivery.id).first()).status,'queued');
    beforeClaim=null;await run("UPDATE settings SET value=? WHERE key='delivery_controller'",json({controller:a.id,excludedNodes:[]}));
    polled=await sync(db,b,{events:[],capabilities:caps});assert.equal(polled.tasks[0].id,delivery.id);
    await run("UPDATE settings SET value=? WHERE key='delivery_controller'",json({controller:a.id,excludedNodes:[b.id]}));
    await sync(db,b,{events:[],capabilities:{...caps,ready:false}});
    assert.equal((await raw.prepare('SELECT status FROM tasks WHERE id=?').bind(delivery.id).first()).status,'claimed','Exclusion does not interrupt claimed work');
    await run("UPDATE tasks SET status='submitted' WHERE id=?",delivery.id);
    const next=plain(b);await submit(db,a,next);
    await run("INSERT INTO delivery_jobs(id,batch_id,phase,item_index,node,attempt,task_id,spec,created_at) VALUES(?,?,'preflight',1,?,0,?,?,?)",next.id,batchId,b.id,next.id,json(next),now());
    await run("UPDATE settings SET value=? WHERE key='delivery_controller'",json({controller:b.id,excludedNodes:[]}));
    polled=await sync(db,b,{events:[],capabilities:caps});assert.deepEqual(polled.tasks,[],'Changing the main controller prevents stale deliveries from being claimed');
  }finally{await mf.dispose();}
});
