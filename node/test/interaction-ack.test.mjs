import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LocalStore} from '../src/local-store.mjs';
import {Worker} from '../src/worker.mjs';
import {CodexRPC} from '../src/codex.mjs';
import {queueInteractionResolution,retryInteractionResolutions} from '../src/interactive.mjs';
import {validateSpec} from '../src/common.mjs';

function directory(){return fs.mkdtempSync('D:\\codex+\\temp\\fleet-ack-test-');}
function fixture(t){const root=directory(t),store=new LocalStore(root);t.after(()=>store.close());return {store,worker:{store,clean:text=>text.replaceAll('credential-test','[redacted]')}};}
function received(store,id='request',task='task',attempt='attempt'){store.put('interaction:'+id,{id,taskId:task,attemptId:attempt,status:'answer_received',expiresAt:new Date(Date.now()+60000).toISOString()});}

test('sent interaction ACK survives restart and lost cloud ACK without replaying approval',async t=>{
  const root=directory(t),config={dataDir:root,nodeId:'node',hubUrl:'https://fixture.invalid',enrollmentState:'enrolled',projects:{workspace:{root}},desktopSync:false};let injections=0,acks=0;
  const executor=async(_config,_file,_run,hooks)=>{const value=await hooks.onInteraction({id:'request',kind:'approval',method:'item/commandExecution/requestApproval',request:{command:'node --version'},expiresAt:new Date(Date.now()+60000).toISOString()},new AbortController().signal);assert.deepEqual(value,{decision:'accept'});injections++;hooks.onInteractionResolved('request');return {status:'submitted',summary:'Done'};};
  let worker=new Worker(config,null,executor);worker.api=async(route,options)=>{assert.ok(!route.endsWith('/resolve'),'Sending to Codex persists first; it does not synchronously require a cloud ACK');return options?.method==='POST'?{}:{interactions:[{id:'request',attemptId:'attempt',status:'answered',response:{decision:'accept'}}]};};
  await worker.execute({id:'task',attempt:'attempt',spec:{id:'task',targetNode:'node',project:'workspace',prompt:'Authorized operation',worktree:false}});assert.equal(worker.store.get('interaction:request').status,'sent_pending_ack');assert.equal(worker.store.get('interaction:request').attemptId,'attempt');worker.store.close();
  worker=new Worker(config,null,async()=>{throw Error('Approval must never be replayed');});t.after(()=>worker.store.close());worker.api=async(route,options)=>{if(route.endsWith('/resolve')){acks++;assert.deepEqual(options.body,{attemptId:'attempt'});if(acks===1)throw Object.assign(Error('ACK response dropped after hub commit'),{status:503});return {status:'resolved'};}assert.equal(route,'/v1/sync');return {ack:[],tasks:[]};};
  await worker.tick();await worker.interactionAckPromise;assert.equal(worker.store.get('interaction:request').status,'sent_pending_ack');const pending=worker.store.get('interaction:request');assert.ok(pending.ackRetryAt>Date.now());assert.equal(pending.ackFailures,1);assert.equal(injections,1);
  await retryInteractionResolutions(worker,{at:pending.ackRetryAt});assert.equal(worker.store.get('interaction:request').status,'resolved');assert.equal(acks,2);assert.equal(injections,1);await retryInteractionResolutions(worker,{at:pending.ackRetryAt+60000});assert.equal(acks,2);
});

test('old-attempt conflicts and expired acknowledgements end retry without reapproving',async t=>{
  const {store,worker}=fixture(t);received(store);queueInteractionResolution(worker,{task:'task',attempt:'attempt'},'request');let calls=0;worker.api=async()=>{calls++;throw Object.assign(Error('Different current attempt'),{status:409});};await retryInteractionResolutions(worker);assert.equal(store.get('interaction:request').status,'ack_ended');await retryInteractionResolutions(worker,{at:Date.now()+1e6});assert.equal(calls,1);
  received(store,'expired');queueInteractionResolution(worker,{task:'task',attempt:'attempt'},'expired');worker.api=async()=>({status:'expired'});await retryInteractionResolutions(worker);assert.equal(store.get('interaction:expired').status,'ack_ended');
  received(store,'foreign');assert.throws(()=>queueInteractionResolution(worker,{task:'task',attempt:'new-attempt'},'foreign'),/attempt/);assert.equal(store.get('interaction:foreign').status,'answer_received');
});

test('ACK retry is bounded, backoffs failures and sanitizes errors',async t=>{
  const {store,worker}=fixture(t);for(let i=0;i<6;i++){received(store,'request-'+i);queueInteractionResolution(worker,{task:'task',attempt:'attempt'},'request-'+i);}let calls=0;worker.api=async(_route,options)=>{calls++;assert.equal(options.timeout,5000);throw Error('offline credential-test');};const at=Date.now();assert.equal(await retryInteractionResolutions(worker,{at,limit:100}),4);assert.equal(calls,4);assert.equal(store.get('interaction:request-0').ackError,'offline [redacted]');assert.equal(await retryInteractionResolutions(worker,{at}),2);assert.equal(calls,6);assert.equal(await retryInteractionResolutions(worker,{at}),0);
});

test('slow ACK requests do not block the main heartbeat',async t=>{
  const root=directory(t),worker=new Worker({dataDir:root,nodeId:'node',hubUrl:'https://fixture.invalid',enrollmentState:'enrolled',projects:{}},null,async()=>{});t.after(()=>worker.store.close());received(worker.store);queueInteractionResolution(worker,{task:'task',attempt:'attempt'},'request');let finish,heartbeats=0;worker.api=async route=>{if(route.endsWith('/resolve'))return new Promise(resolve=>finish=resolve);heartbeats++;return {ack:[],tasks:[]};};await worker.tick();assert.equal(heartbeats,1);assert.equal(worker.store.get('interaction:request').status,'sent_pending_ack');finish({status:'resolved'});await worker.interactionAckPromise;assert.equal(worker.store.get('interaction:request').status,'resolved');
});

test('actual App Server launch approves controller tools only in execute mode',async t=>{
  for(const fleetReadOnly of [false,true]){const root=directory(t);fs.writeFileSync(path.join(root,'app-server'),"const fs=require('node:fs');fs.writeFileSync('launch.json',JSON.stringify(process.argv.slice(2)));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});");const rpc=new CodexRPC({codexPath:process.execPath,dataDir:root,fleetReadOnly},path.join(root,'node.json'));try{await rpc.start();const args=JSON.parse(fs.readFileSync(path.join(root,'launch.json'),'utf8'));for(const name of ['fleet_projects','fleet_automations'])assert.ok(args.includes(`mcp_servers.codex_fleet.tools.${name}.approval_mode="approve"`));for(const name of ['fleet_project_create','fleet_automation_create','fleet_automation_control','fleet_assign'])assert.equal(args.includes(`mcp_servers.codex_fleet.tools.${name}.approval_mode="approve"`),!fleetReadOnly);}finally{await rpc.close();}}
});

test('local policy requires explicit execute mode before a task can enter durable outbox',()=>{const spec={id:'task',targetNode:'node',project:'workspace',prompt:'Do authorized work',executionPolicy:'local'};assert.throws(()=>validateSpec(spec),/explicit execute/);assert.throws(()=>validateSpec({...spec,mode:'question'}),/read-only/);assert.doesNotThrow(()=>validateSpec({...spec,mode:'execute'}));});
