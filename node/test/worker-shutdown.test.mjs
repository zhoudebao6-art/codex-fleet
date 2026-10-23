import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Worker} from '../src/worker.mjs';
import {CodexRPC} from '../src/codex.mjs';
import {spawn} from 'node:child_process';
import {LocalStore} from '../src/local-store.mjs';

test('a managed idle worker wakes from its 60-second poll delay and closes its own collector promptly',{timeout:5000},async()=>{
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-shutdown-test-'),worker=new Worker({nodeId:'isolated',dataDir:dir,idlePollMs:60000,projects:{}},null,async()=>({status:'submitted'}));let closes=0;worker.desktop={close:async()=>{closes++;}};worker.tick=async()=>{worker.nextPollMs=60000;};const running=worker.start();for(let i=0;i<50&&!worker.wake;i++)await sleep(10);assert.ok(worker.wake);const begin=Date.now();worker.stop();await running;assert.ok(Date.now()-begin<1000);assert.ok(closes>=1);assert.ok(!fs.existsSync(path.join(dir,'worker.lock')));
});
test('stop arriving during sync never dispatches returned work and prevents another network request',async t=>{
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-shutdown-sync-'),worker=new Worker({nodeId:'isolated',hubUrl:'http://127.0.0.1:1',dataDir:dir,projects:{}},null,async()=>{assert.fail('Stopping worker must not dispatch returned task');});t.after(()=>worker.store.close());let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});const realApi=worker.api;worker.api=async route=>{assert.equal(route,'/v1/sync');entered();await gate;return {ack:[],tasks:[{id:'late',attempt:'a',status:'claimed',spec:{}}]};};const tick=worker.tick();await ready;worker.stop();release();await tick;assert.equal(worker.active.size,0);assert.equal(worker.store.run('late'),null);worker.api=realApi;await assert.rejects(worker.api('/v1/nodes'),/stopping/);
});
test('closing a Codex reader rejects pending and later calls without leaving RPC timers',async()=>{
 const rpc=new CodexRPC({});let sent=0;rpc.send=()=>{sent++;};
 const pending=assert.rejects(rpc.call('thread/list',{},60000),/connection is closed/);
 await rpc.close();await pending;assert.equal(rpc.pending.size,0);
 await assert.rejects(rpc.call('thread/list'),/connection is closed/);assert.equal(sent,1);await rpc.close();
});
test('shutdown deadline never exits active or uncertain work',async t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-shutdown-active-'),w=new Worker({nodeId:'isolated',dataDir:dir,projects:{}},null,async()=>({status:'submitted'}));
 t.after(()=>w.store.close());w.stop();w.active.set('active',{});assert.equal(w.canFinishIdleShutdown(),false);w.active.clear();
 w.store.add({id:'uncertain',attempt:'a',spec:{}});w.store.update('uncertain',{status:'uncertain'});assert.equal(w.canFinishIdleShutdown(),false);
 w.store.update('uncertain',{status:'submitted'});assert.equal(w.canFinishIdleShutdown(),true);
});
test('an isolated worker with a hung reader exits at its idle deadline and preserves durable messages',{timeout:10000},async t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-shutdown-deadline-'),script=path.join(dir,'fixture.mjs');
 fs.writeFileSync(script,"import {Worker} from "+JSON.stringify(new URL('../src/worker.mjs',import.meta.url).href)+";const w=new Worker("+JSON.stringify({nodeId:'isolated',dataDir:dir,projects:{},shutdownGraceMs:1000})+",null,async()=>({status:'submitted'}));w.tick=async()=>{};w.desktop={close:()=>new Promise(()=>{})};w.store.emit({type:'message',taskId:'preserved',text:'durable'});w.onIdleShutdownTimeout=()=>{w.closeStorage();process.exit(0);};setTimeout(()=>w.stop(),100);await w.start();");
 const child=spawn(process.execPath,[script],{windowsHide:true,env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir},stdio:'ignore'});t.after(()=>child.kill());
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});assert.equal(result.code,0);
 const audit=JSON.parse(fs.readFileSync(path.join(dir,'shutdown-status.json')));assert.equal(audit.stage,'idle_shutdown_timeout');assert.ok(!fs.existsSync(path.join(dir,'worker.lock')));
 const store=new LocalStore(dir);try{assert.equal(store.pending().length,1);assert.equal(store.pending()[0].text,'durable');}finally{store.close();}
});
