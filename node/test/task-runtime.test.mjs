import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from '../src/worker.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,executor){const dir=fs.mkdtempSync('D:\\codex+\\temp\\fleet-runtime-test-'),worker=new Worker({nodeId:'self',dataDir:path.join(dir,'data'),projects:{workspace:{root:dir}}},null,executor||(async()=>({status:'submitted'})));t.after(()=>worker.store.close());return {worker,dir};}
const task=(id='task')=>({id,attempt:'attempt-'+id,spec:{id,targetNode:'self',project:'workspace',prompt:'Authorized work',worktree:false}});

test('heartbeat reports actual preparing running uploading phases and verified cwd, then removes finished task',async t=>{
  const preparing=gate(),start=gate(),finish=gate();const {worker,dir}=fixture(t,async()=>{start.resolve();return finish.promise;});worker.prepareInputs=async()=>{await preparing.promise;return [];};const job=worker.execute(task());
  assert.deepEqual(worker.capabilities().taskRuntime,[{taskId:'task',attemptId:'attempt-task',phase:'preparing',cwd:fs.realpathSync(dir)}]);
  preparing.resolve();await start.promise;assert.equal(worker.capabilities().taskRuntime[0].phase,'running');finish.resolve({status:'submitted',summary:'Finished execution'});await job;assert.equal(worker.active.has('task'),false);assert.equal(worker.capabilities().taskRuntime[0].phase,'uploading');worker.finishUpload(worker.store.run('task'));assert.deepEqual(worker.capabilities().taskRuntime,[]);
});

test('orphan and mismatched attempts never look live, and runtime telemetry is bounded and public',t=>{
  const {worker}=fixture(t);for(const id of ['orphan','wrong','pending']){worker.store.add(task(id));worker.store.update(id,{status:id==='pending'?'preparing':'running',cwd:null});}worker.active.set('wrong',{attemptId:'a-different-attempt'});worker.active.set('pending',{attemptId:'attempt-pending'});
  assert.deepEqual(worker.capabilities().taskRuntime,[{taskId:'pending',attemptId:'attempt-pending',phase:'preparing',cwd:null}]);for(let i=0;i<103;i++){const id='upload-'+i;worker.store.add(task(id));worker.store.update(id,{status:'uploading',result:{summary:'must not enter telemetry'},cwd:'D:\\project'});}const runtime=worker.capabilities().taskRuntime;assert.equal(runtime.length,100);assert.ok(runtime.every(r=>['preparing','running','uploading'].includes(r.phase)));assert.ok(runtime.every(r=>Object.keys(r).sort().join(',')==='attemptId,cwd,phase,taskId'));assert.ok(!runtime.some(r=>['orphan','wrong'].includes(r.taskId)));
});
