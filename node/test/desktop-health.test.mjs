import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {desktopHealth} from '../src/desktop-health.mjs';
import {Worker} from '../src/worker.mjs';

test('desktop health detects backpressure, timeout and stale endpoint identity without leaking secrets',async t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-health-'),file=dir+'/runtime.json',token='a'.repeat(64);
 let value={ready:true,pid:123,backendPid:456,protocol:1},stall=false;
 const server=http.createServer((req,res)=>{
   assert.equal(req.headers.authorization,'Bearer '+token);
   if(stall)return;res.end(JSON.stringify(value));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 fs.writeFileSync(file,JSON.stringify({...value,port:server.address().port,token}));
 assert.equal((await desktopHealth(file)).ready,true);
 value.ready=false;assert.equal((await desktopHealth(file)).ready,false);
 value.ready=true;value.pid=124;assert.equal((await desktopHealth(file)).ready,false);
 stall=true;const result=await desktopHealth(file,50);assert.equal(result.ready,false);assert.ok(!JSON.stringify(result).includes(token));
});
test('an unhealthy bridge blocks new work but keeps existing task identity',t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-health-worker-'),w=new Worker({dataDir:dir,desktopSessionBridge:'fixture',projects:{}},null,async()=>{});
 t.after(()=>w.store.close());w.active.set('running-original',{conversation:false});w.bridgeHealth={ready:false};
 assert.equal(w.canExecute({mode:'execute'}),false);const caps=w.capabilities();assert.equal(caps.ready,false);assert.equal(caps.executorState,'blocked');assert.deepEqual(caps.activeTasks,['running-original']);
});
