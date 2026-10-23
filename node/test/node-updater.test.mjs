import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {LocalStore} from '../src/local-store.mjs';
import {NodeUpdater,validateUpgradeAction} from '../src/node-updater.mjs';
import {writeJson} from '../src/common.mjs';
import {Worker} from '../src/worker.mjs';

function fixture(t,{size=32,version='0.3.1',launch}={}){
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-self-upgrade-'),dataDir=path.join(root,'data/node'),nodeId=crypto.randomUUID(),id=crypto.randomUUID();
  let store=new LocalStore(dataDir);
  const bytes=crypto.randomBytes(size),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const action={id,nodeId,action:'upgrade',installer:{sha256,size,version:'0.3.1',name:'codex-fleet-0.3.1-windows-x64.zip',project:'workspace'},downloadPath:`/v1/files/${sha256}?project=workspace`};
  let clock=Date.now(),calls=[],launches=[],downloadFailure=false,ackFailure=false,actions=[action];
  const worker={store,configFile:path.join(root,'config/node.json'),config:{dataDir,nodeId,hubUrl:'https://fleet.example'},stopping:false,active:new Map(),api:async(route,opts={})=>{
    calls.push({route,...opts});if(route==='/v1/node/actions')return {actions};
    if(route.endsWith('/ack')){if(ackFailure)throw new Error('offline');return {ok:true};}
    if(route===action.downloadPath){if(downloadFailure)throw new Error('network disconnected');const [,start,end]=opts.headers.range.match(/bytes=(\d+)-(\d+)/);return bytes.subarray(Number(start),Number(end)+1);}
    throw new Error('Unexpected route '+route);
  }};
  const make=()=>new NodeUpdater(worker,{installation:{root},version,clock:()=>clock,launch:async(record)=>{launches.push(record.id);if(launch)return launch(record);writeJson(path.join(dataDir,'upgrades',record.id+'.queued.json'),{actionId:record.id,packageSha256:sha256,state:'queued',pid:process.pid});return {pid:process.pid};}});
  let agent=make();t.after(()=>store.close());
  return {root,dataDir,get store(){return store;},worker,action,bytes,calls,launches,get agent(){return agent;},advance(ms=15000){clock+=ms;},restart(){store.close();store=new LocalStore(dataDir);worker.store=store;agent=make();},setDownloadFailure(v){downloadFailure=v;},setAckFailure(v){ackFailure=v;},setActions(v){actions=v;},status(state,extra={}){writeJson(path.join(dataDir,'upgrades',id+'.status.json'),{actionId:id,packageSha256:sha256,version:'0.3.1',state,pid:process.pid,...extra});},record(){return store.get('node-action:'+id);}};
}

test('maintenance rejects arbitrary URLs, commands, destinations and foreign node actions before download',async t=>{
  const f=fixture(t);for(const bad of [{downloadPath:'https://evil.example/release.zip'},{command:'powershell arbitrary'},{installDir:'C:\\other'},{nodeId:'foreign'},{action:'execute'}])assert.throws(()=>validateUpgradeAction({...f.action,...bad},f.worker.config.nodeId));
  assert.throws(()=>validateUpgradeAction({...f.action,installer:{...f.action.installer,url:'https://other.example'}},f.worker.config.nodeId));
  assert.throws(()=>validateUpgradeAction({...f.action,id:'CON'},f.worker.config.nodeId));
  f.setActions([{...f.action,downloadPath:'//evil.example/release.zip'}]);await f.agent.tick();assert.equal(f.record().status,'failed');assert.equal(f.launches.length,0);assert.equal(f.calls.filter(x=>x.raw).length,0);
});

test('wrong registered SHA fails closed without launching the updater',async t=>{
  const f=fixture(t);f.action.installer.sha256='0'.repeat(64);f.action.downloadPath=`/v1/files/${f.action.installer.sha256}?project=workspace`;
  await f.agent.tick();assert.equal(f.record().status,'failed');assert.match(f.record().detail,/SHA256 mismatch/);assert.deepEqual(f.launches,[]);
});

test('busy node downloads and queues once while active tasks remain untouched, including repeated delivery and restart',async t=>{
  const f=fixture(t);f.worker.active.set('busy-task',{attemptId:'live'});f.store.add({id:'busy-task',attempt:'live',spec:{}});f.store.update('busy-task',{status:'running'});
  await f.agent.tick();assert.equal(f.record().status,'launching');assert.equal(f.launches.length,1);f.restart();f.advance();await f.agent.tick();f.advance();await f.agent.tick();
  assert.equal(f.record().status,'waiting');assert.equal(f.launches.length,1);assert.equal(f.store.run('busy-task').status,'running');assert.equal(f.worker.active.size,1);assert.equal(fs.existsSync(path.join(f.dataDir,'stop.request')),false);
});

test('network interruption resumes the exact partial byte range after reopening local state',async t=>{
  const f=fixture(t,{size:5*1024*1024+9});await f.agent.tick();assert.equal(f.record().bytes,4*1024*1024);assert.equal(f.launches.length,0);
  f.setDownloadFailure(true);await f.agent.tick();assert.equal(f.record().bytes,4*1024*1024);assert.equal(f.record().status,'downloading');f.restart();f.advance(130000);f.setDownloadFailure(false);await f.agent.tick();
  assert.equal(f.launches.length,1);const requests=f.calls.filter(x=>x.raw);assert.equal(requests.at(-2).headers.range,`bytes=${4*1024*1024}-${5*1024*1024-1}`);assert.equal(f.record().bytes,f.bytes.length);
});

test('new worker reconciles completed action and durably retries a lost completion ACK without launching again',async t=>{
  const f=fixture(t);await f.agent.tick();f.status('completed');f.setAckFailure(true);f.restart();f.advance();await f.agent.tick();assert.equal(f.record().status,'completed');assert.equal(f.record().ackPending,true);
  const first=f.calls.filter(x=>x.body?.status==='completed').at(-1).body;f.setActions([]);f.restart();f.setAckFailure(false);f.advance(130000);await f.agent.tick();
  assert.equal(f.record().ackPending,false);assert.deepEqual(f.calls.filter(x=>x.body?.status==='completed').at(-1).body,first);assert.equal(f.launches.length,1);assert.equal(first.version,'0.3.1');assert.equal(first.packageSha256,f.action.installer.sha256);
});

test('updater rollback is reported as failed and a stale completion cannot certify another version',async t=>{
  const f=fixture(t,{version:'0.3.0'});await f.agent.tick();f.status('completed');f.restart();await f.agent.tick();assert.equal(f.record().status,'failed');assert.match(f.record().detail,/version does not match/);
  const g=fixture(t);await g.agent.tick();g.status('failed');g.restart();await g.agent.tick();assert.equal(g.record().status,'failed');assert.match(g.record().detail,/UPGRADE_FAILED/);assert.equal(g.launches.length,1);
});

test('upgrade failure is actionable without publishing local secret-bearing exceptions',async t=>{
  const f=fixture(t);await f.agent.tick();
  f.status('failed',{detail:'Upgrade wait expired; current work was left running. token=private-value D:\\private'});
  f.restart();await f.agent.tick();assert.match(f.record().detail,/WAIT_FOR_IDLE_TIMEOUT/);
  assert.doesNotMatch(f.record().detail,/private-value|D:\\private/);assert.equal(f.launches.length,1);
});

test('uncertain launch intent survives restart and is never submitted twice',async t=>{
  const f=fixture(t,{launch:async()=>({pid:123})});await f.agent.tick();assert.equal(f.record().status,'launching');f.restart();f.advance(190000);await f.agent.tick();assert.equal(f.record().status,'failed');assert.match(f.record().detail,/not be launched a second time/);assert.equal(f.launches.length,1);
});

test('a recorded early launcher exit is reported without waiting or relaunching, but cannot override a confirmed queue',async t=>{
  const f=fixture(t,{launch:async()=>({pid:123})});await f.agent.tick();
  writeJson(path.join(f.dataDir,'upgrades',f.action.id+'.launcher.json'),{actionId:f.action.id,packageSha256:f.action.installer.sha256,state:'exited',code:0});
  f.restart();await f.agent.tick();assert.equal(f.record().status,'failed');assert.match(f.record().detail,/exited \(code 0\) before confirming/);assert.equal(f.launches.length,1);
  const g=fixture(t);await g.agent.tick();writeJson(path.join(g.dataDir,'upgrades',g.action.id+'.launcher.json'),{actionId:g.action.id,packageSha256:g.action.installer.sha256,state:'exited',code:0});
  g.restart();await g.agent.tick();assert.equal(g.record().status,'waiting');assert.equal(g.launches.length,1);
});

test('metadata change for an existing action fails closed and never changes installer',async t=>{
  const f=fixture(t,{size:5*1024*1024});await f.agent.tick();const original=f.record().action.installer.sha256;f.setActions([{...f.action,installer:{...f.action.installer,version:'9.9.9'}}]);f.advance();await f.agent.tick();assert.equal(f.record().status,'failed');assert.equal(f.record().action.installer.sha256,original);assert.equal(f.launches.length,0);
});

test('maintenance download runs independently of Fleet heartbeats',async t=>{
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-update-heartbeat-'),worker=new Worker({nodeId:'self',dataDir:path.join(dir,'data'),hubUrl:'https://fleet.example',enrollmentState:'enrolled',projects:{workspace:{root:dir}}},null,async()=>({status:'submitted'}));
  let finish;const slow=new Promise(resolve=>{finish=resolve;});let ticks=0,syncs=0;
  worker.updater={enabled:true,summary:()=>({enabled:true}),tick:()=>{ticks++;return slow;}};
  worker.api=async route=>{assert.equal(route,'/v1/sync');syncs++;return {ack:[],tasks:[]};};
  t.after(async()=>{finish();await worker.upgradePromise;await worker.interactionAckPromise;worker.store.close();});
  await worker.tick();await worker.tick();assert.equal(syncs,2);assert.equal(ticks,1);assert.equal(worker.capabilities().selfUpgrade,true);
});
