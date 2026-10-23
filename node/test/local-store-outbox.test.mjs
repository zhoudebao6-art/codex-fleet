import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../src/local-store.mjs';
import {transaction} from '../src/common.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-outbox-priority-'));
  let store=new LocalStore(dir);
  t.after(()=>store.close());
  return {get store(){return store;},restart(){store.close();store=new LocalStore(dir);}};
}
function history(store,count,start=0,extra={}){return transaction(store.db,()=>Array.from({length:count},(_,i)=>store.emit({type:'progress',kind:'tool_activity',taskId:'running',attemptId:'attempt',sequence:start+i,...extra})));}
const ids=events=>events.map(e=>e.id);
const control=events=>events.filter(e=>!['tool_activity','input_transfer','output_transfer'].includes(e.kind)||e.threadId);

test('terminal and assignment bypass 2000 observational events without losing lifecycle or thread order',t=>{
  const f=fixture(t),s=f.store,started=s.emit({type:'started',taskId:'running',attemptId:'attempt'});
  const binding=s.emit({type:'progress',taskId:'running',attemptId:'attempt',threadId:'original-thread'}),bulk=history(s,2000);
  const read=s.emit({type:'progress',kind:'input_read_receipt',taskId:'running',attemptId:'attempt',sha:'verified'});
  const uncertain=s.emit({type:'uncertain',taskId:'running',attemptId:'attempt'});
  const finish=s.emit({type:'finished',taskId:'running',attemptId:'attempt',status:'submitted'});
  const assign=s.emit({type:'assign',spec:{id:'child'}}),message=s.emit({type:'message',taskId:'child',text:'continue'});
  const batch=s.pending();assert.equal(batch.length,25);
  assert.deepEqual(ids(control(batch)),[started,binding,read,uncertain,finish,assign,message]);
  assert.deepEqual(ids(batch.filter(e=>e.kind==='tool_activity')),bulk.slice(0,18));
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,2007,'Selecting must not remove unsent history');
});

test('assignment and following message cannot overtake each other at a batch boundary',t=>{
  const {store:s}=fixture(t);history(s,100);
  for(let i=0;i<20;i++)s.emit({type:'message',taskId:'existing',text:String(i)});
  const assign=s.emit({type:'assign',spec:{id:'new-child'}}),message=s.emit({type:'message',taskId:'new-child',text:'follow up'});
  const first=s.pending();assert.equal(first.length,25);assert.ok(!ids(first).includes(assign));assert.ok(!ids(first).includes(message));
  s.ack(ids(first));const next=s.pending();assert.deepEqual(ids(control(next)),[assign,message]);
});

test('continuous control traffic cannot starve historical progress and its FIFO order',t=>{
  const {store:s}=fixture(t),expected=history(s,100),seen=[];
  for(let round=0;round<20;round++){
    for(let i=0;i<25;i++)s.emit({type:'message',taskId:'task',text:round+':'+i});
    const batch=s.pending(),bulk=batch.filter(e=>e.kind==='tool_activity');assert.equal(bulk.length,5);
    seen.push(...ids(bulk));assert.equal(control(batch).length,20);s.ack(ids(batch));
  }
  assert.deepEqual(seen,expected);
});

test('continuous history does not starve a newly emitted terminal event',t=>{
  const {store:s}=fixture(t);history(s,500);
  for(let round=0;round<10;round++){
    history(s,100,500+round*100);const terminal=s.emit({type:'finished',taskId:'task-'+round,attemptId:'attempt',status:'submitted'});
    const batch=s.pending();assert.ok(ids(batch).includes(terminal));s.ack(ids(batch));
  }
});

test('lost response, restart and partial acknowledgement preserve IDs and exact payloads',t=>{
  const f=fixture(t);history(f.store,100);const assigned=f.store.emit({type:'assign',spec:{id:'stable-child',prompt:'same payload'}});
  const first=f.store.pending();assert.deepEqual(f.store.pending(),first);f.restart();assert.deepEqual(f.store.pending(),first);
  f.store.ack(ids(first).filter(id=>id!==assigned));const retry=f.store.pending();
  assert.deepEqual(retry.find(e=>e.id===assigned),first.find(e=>e.id===assigned));
  f.store.ack([assigned]);assert.ok(!ids(f.store.pending()).includes(assigned));
  const bad=f.store.emit({type:'message',taskId:'missing',text:'keep diagnostic'});f.store.quarantine(bad,'task not found');
  assert.ok(!ids(f.store.pending()).includes(bad));assert.equal(f.store.errors()[0].id,bad);
  assert.equal(f.store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(bad).payload.includes('keep diagnostic'),true);
});

test('UTF-8 byte budget reserves progress and control while leaving room for capabilities',t=>{
  const {store:s}=fixture(t),text='界'.repeat(250000);history(s,3,0,{message:text});
  for(let i=0;i<3;i++)s.emit({type:'finished',taskId:'task-'+i,attemptId:'attempt',status:'submitted',result:{summary:text}});
  const batch=s.pending();assert.equal(batch.length,2);assert.equal(control(batch).length,1);assert.equal(batch.filter(e=>e.kind==='tool_activity').length,1);
  assert.ok(Buffer.byteLength(JSON.stringify(batch))<=1536*1024);
  assert.ok(Buffer.byteLength(JSON.stringify({events:batch,capabilities:{summary:'界'.repeat(127900)}}))<2*1024*1024);
});

test('an invalid oversize head is returned alone for diagnosis, never erased or allowed to deadlock',t=>{
  const {store:s}=fixture(t);const bad=s.emit({type:'message',taskId:'task',text:'x'.repeat(2*1024*1024)});history(s,50);
  assert.deepEqual(ids(s.pending()),[bad]);assert.deepEqual(ids(s.pending()),[bad]);s.quarantine(bad,'Request too large');
  assert.equal(s.pending().length,25);assert.equal(s.errors()[0].id,bad);
});

test('thread-bearing observations and unknown future events stay in control FIFO',t=>{
  const {store:s}=fixture(t);history(s,100);
  const binding=s.emit({type:'progress',kind:'tool_activity',threadId:'binding',taskId:'task'}),future=s.emit({type:'future_control',taskId:'task'});
  const batch=s.pending();assert.ok(ids(batch).includes(binding));assert.ok(ids(batch).includes(future));
  assert.ok(ids(batch).indexOf(binding)<ids(batch).indexOf(future));
});
