import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from '../src/worker.mjs';

function fixture(t,executor){
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-task-deadline-'),file=path.join(root,'node.json');
  const config={nodeId:'deadline-fixture',dataDir:path.join(root,'data'),projects:{workspace:{root}},maxTaskMs:3600000,nodeToken:'original-fixture-token'};
  fs.writeFileSync(file,JSON.stringify(config));const worker=new Worker(config,file,executor||(async()=>({status:'submitted'})));t.after(()=>worker.store.close());
  return {worker,file,config,write:changes=>fs.writeFileSync(file,JSON.stringify({...config,...changes}))};
}
const task=id=>({id,attempt:'attempt-'+id,spec:{id,targetNode:'deadline-fixture',project:'workspace',prompt:'isolated test',worktree:false}});

test('a new task observes a changed deadline without restarting or changing credentials and project permissions',async t=>{
  const seen=[],f=fixture(t,async cfg=>{seen.push(cfg);return {status:'submitted'};});
  await f.worker.execute(task('first'));f.write({maxTaskMs:43200000,nodeToken:'must-not-reload',projects:{unsafe:{root:'C:/',sandbox:'danger-full-access'}}});
  await f.worker.execute(task('second'));assert.deepEqual(seen.map(x=>x.maxTaskMs),[3600000,43200000]);assert.equal(seen[1].nodeToken,'original-fixture-token');assert.deepEqual(seen[1].projects,f.config.projects);assert.equal(f.worker.config.maxTaskMs,3600000);
});

test('running task keeps its deadline snapshot while the next task receives the new limit',async t=>{
  let release,entered;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r),seen=[];
  const f=fixture(t,async cfg=>{seen.push(cfg);if(seen.length===1){entered();await pending;}return {status:'submitted'};});
  const active=f.worker.execute(task('active'));await ready;f.write({maxTaskMs:43200000});assert.equal(seen[0].maxTaskMs,3600000);release();await active;await f.worker.execute(task('later'));assert.equal(seen[0].maxTaskMs,3600000);assert.equal(seen[1].maxTaskMs,43200000);
});

test('partial, invalid, foreign-node and missing configurations retain the last valid deadline with a bounded diagnostic',t=>{
  const f=fixture(t);f.write({maxTaskMs:43200000});assert.equal(f.worker.taskDeadline(),43200000);
  for(const value of [0,-1,1.5,'43200000',2147483648,null]){f.write({maxTaskMs:value});assert.equal(f.worker.taskDeadline(),43200000);assert.equal(f.worker.store.get('taskDeadline').error,'INVALID_TASK_DEADLINE');}
  f.write({nodeId:'another-node',maxTaskMs:1000});assert.equal(f.worker.taskDeadline(),43200000);assert.equal(f.worker.store.get('taskDeadline').error,'NODE_ID_CHANGED');
  fs.writeFileSync(f.file,'{');assert.equal(f.worker.taskDeadline(),43200000);assert.equal(f.worker.store.get('taskDeadline').error,'CONFIG_UNAVAILABLE');fs.unlinkSync(f.file);assert.equal(f.worker.taskDeadline(),43200000);
  assert.ok(!JSON.stringify(f.worker.store.get('taskDeadline')).includes('token'));
});
