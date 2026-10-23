import test from 'node:test';
import assert from 'node:assert/strict';
import {describeInteraction,waitForInteraction} from '../src/interactive.mjs';

const message=(params={})=>({id:1,method:'item/commandExecution/requestApproval',params:{command:'node --version',cwd:'D:\\project',...params}});
const item=()=>({id:'interaction-id',kind:'approval',method:'item/commandExecution/requestApproval',request:{command:'node --version'},expiresAt:new Date(Date.now()+10000).toISOString()});
function worker(api){const records=new Map(),control={};return {stopping:false,api,active:new Map([['task',control]]),store:{put:(k,v)=>records.set(k,v)},emit(){},records,control};}

test('permission extensions and redacted actions are never silently converted to ordinary approvals',()=>{
  assert.equal(describeInteraction(message({additionalPermissions:{fileSystem:{write:['D:\\outside']}}})),null);
  assert.equal(describeInteraction(message({proposedExecpolicyAmendment:['cmd']})),null);
  assert.equal(describeInteraction(message({networkApprovalContext:{host:'example.test'}})),null);
  assert.equal(describeInteraction({...message({grantRoot:'D:\\outside'}),method:'item/fileChange/requestApproval'}),null,'grantRoot is a permission extension, not just display cwd');
  assert.equal(describeInteraction(message(),x=>({...x,command:'redacted'})),null);
});

test('interaction stays waiting through transient failure and records the answer without approving by itself',async()=>{
  const abort=new AbortController();let posts=0,gets=0;
  const w=worker(async(_route,options)=>{if(options?.method==='POST'){posts++;if(posts===1)throw Object.assign(new Error('timeout after save'),{status:503});return {};}gets++;return {interactions:[{id:'interaction-id',attemptId:'attempt',status:'answered',response:{decision:'decline'}}]};});
  const response=await waitForInteraction(w,{task:'task',attempt:'attempt'},item(),abort.signal);assert.deepEqual(response,{decision:'decline'});assert.equal(posts,2);assert.equal(gets,1);assert.equal(w.control.waitingInteraction,undefined);assert.equal(w.records.get('interaction:interaction-id').status,'answer_received');
});

test('an answer from another attempt is not delivered into the active attempt',async()=>{
  const abort=new AbortController();const w=worker(async(_route,options)=>{if(options?.method==='POST')return {};setTimeout(()=>abort.abort(),20);return {interactions:[{id:'interaction-id',attemptId:'old-attempt',status:'answered',response:{decision:'accept'}}]};});
  await assert.rejects(waitForInteraction(w,{task:'task',attempt:'new-attempt'},item(),abort.signal),/ended|expired|attempt/i);assert.equal(w.control.waitingInteraction,undefined);assert.notEqual(w.records.get('interaction:interaction-id').status,'answer_received');
});

test('cancel arriving while a response is in flight wins over the answer',async()=>{
  const abort=new AbortController();const w=worker(async(_route,options)=>{if(options?.method==='POST')return {};abort.abort();return {interactions:[{id:'interaction-id',attemptId:'attempt',status:'answered',response:{decision:'accept'}}]};});
  await assert.rejects(waitForInteraction(w,{task:'task',attempt:'attempt'},item(),abort.signal),/ended|cancel|expired/i);assert.equal(w.control.waitingInteraction,undefined);assert.notEqual(w.records.get('interaction:interaction-id').status,'answer_received');
});

test('expired interaction clears waiting state and cannot return a prior response',async()=>{
  const abort=new AbortController(),w=worker(async(_route,options)=>options?.method==='POST'?{}:{interactions:[{id:'interaction-id',attemptId:'attempt',status:'expired',response:{decision:'accept'}}]});await assert.rejects(waitForInteraction(w,{task:'task',attempt:'attempt'},item(),abort.signal),/no longer pending/);assert.equal(w.control.waitingInteraction,undefined);
});
