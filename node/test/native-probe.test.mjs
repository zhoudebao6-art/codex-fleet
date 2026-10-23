import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeContinuation,probeNativeWriterLock} from '../src/native-continuation.mjs';

function fixture(fault){
  let original,created=0;const calls=[],resumes=[];
  class RPC {
    constructor(config){this.config=config;this.owner=created++;this.closed=false;if(this.owner===0)original=this;}
    async start(){return this;}
    async close(){this.closed=true;}
    async call(method,params){
      calls.push({owner:this.owner,method,params});
      if(method==='thread/start')return {thread:{id:'inert-thread',status:{type:'idle'}}};
      if(method==='turn/start'){this.active=fault!=='no_active';return {turn:{id:fault==='missing_turn'?null:'inert-turn'}};}
      if(method==='thread/read')return {thread:{id:fault==='wrong_read_id'?'another-thread':'inert-thread',status:{type:this.active?'active':'idle'}}};
      if(method==='turn/interrupt'){this.active=false;return {};}
      if(method==='thread/resume'){
        resumes.push(original.closed?'released':original.active?'active':'idle_loaded');
        if(original.closed)return {thread:{id:fault==='wrong_released_id'?'another-thread':'inert-thread',status:{type:'idle'}}};
        if(fault==='active_ended')original.active=false;
        if(fault==='idle_owner_exited'&&!original.active)original.closed=true;
        if(fault==='message_only')throw Error('Thread already has an active writer');
        if(fault==='unrelated_code')throw Object.assign(Error('Thread already has an active writer'),{code:-32000});
        if(fault==='http502')throw Object.assign(Error('502 Bad Gateway'),{code:502});
        if((fault==='no_active_lock'&&original.active)||(fault==='no_idle_lock'&&!original.active))return {thread:{id:'inert-thread',status:{type:'idle'}}};
        throw Object.assign(Error('Thread inert-thread already has an active writer'),{code:-32600});
      }
      throw Error('Unexpected method '+method);
    }
  }
  return {calls,resumes,options:{rpcFactory:config=>new RPC(config),pause:async()=>{}}};
}

test('zero model HTTP requests still verify all three official writer exclusion stages',async()=>{
  const f=fixture(),result=await probeNativeWriterLock({codexPath:'unchanged-local-executable'},f.options);
  assert.equal(result.supported,true);assert.equal(result.modelRequestsObserved,0);
  assert.deepEqual(f.resumes,['active','idle_loaded','released']);
  const creation=f.calls.find(c=>c.method==='thread/start');assert.equal(creation.params.approvalPolicy,'never');assert.equal(creation.params.sandbox,'read-only');
  assert.ok(f.calls.filter(c=>c.method==='thread/read').length>=4);
  for(const c of f.calls.filter(c=>c.method==='thread/resume'))assert.deepEqual(c.params,{threadId:'inert-thread',excludeTurns:true});
});
for(const [fault,expected] of [['missing_turn','NATIVE_PROBE_TURN_MISSING'],['wrong_read_id','NATIVE_PROBE_THREAD_MISMATCH'],['no_active','NATIVE_PROBE_NOT_ACTIVE'],['active_ended','NATIVE_PROBE_ACTIVE_CHANGED'],['idle_owner_exited','NATIVE_PROBE_OWNER_EXITED'],['no_active_lock','NATIVE_ACTIVE_WRITER_NOT_EXCLUDED'],['no_idle_lock','NATIVE_IDLE_WRITER_NOT_EXCLUDED'],['wrong_released_id','NATIVE_PROBE_HANDOFF_MISMATCH']]){
  test('writer capability fails closed: '+fault,async()=>{const f=fixture(fault);await assert.rejects(probeNativeWriterLock({},f.options),e=>e.probeCode===expected);});
}
for(const fault of ['message_only','unrelated_code','http502']){
  test('nonofficial refusal is not writer lock proof: '+fault,async()=>{const f=fixture(fault);await assert.rejects(probeNativeWriterLock({},f.options));assert.deepEqual(f.resumes,['active']);});
}

function worker(){const data=new Map();return {config:{},desktop:{},active:new Map(),store:{put:(k,v)=>data.set(k,v),get:k=>data.get(k)}};}
test('probe is singleflight; a transient failure retries only when due and idle',async()=>{
  const w=worker();let now=1000,attempts=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const n=new NativeContinuation(w,{clock:()=>now,probe:async()=>{attempts++;if(attempts===1){await gate;throw Error('Temporary startup failure with secret detail');}return {supported:true,state:'ready'};}});
  const first=n.check(),parallel=n.check();assert.equal(first,parallel);assert.equal(attempts,1);assert.equal(n.canCheck(),false);
  release();await first;assert.equal(n.summary().state,'probe_failed');assert.equal(n.summary().attempt,1);assert.equal(n.summary().nextRetryAt,new Date(31000).toISOString());assert.ok(!JSON.stringify(n.summary()).includes('secret detail'));
  now=30999;await n.check();assert.equal(attempts,1);
  now=31000;w.active.set('business',{});assert.equal(n.canCheck(),false);await n.check();assert.equal(attempts,1);
  w.active.clear();await n.check();assert.equal(attempts,2);assert.equal(n.summary().supported,true);now=999999;await n.check();assert.equal(attempts,2);
});
test('transient checks stop after three attempts and never become a false unsupported claim',async()=>{
  const w=worker();let now=0,attempts=0;const n=new NativeContinuation(w,{clock:()=>now,probe:async()=>{attempts++;throw Error('Temporary probe failure');}});
  await n.check();now=30000;await n.check();assert.equal(n.summary().nextRetryAt,new Date(150000).toISOString());
  now=150000;await n.check();assert.equal(attempts,3);assert.equal(n.summary().state,'probe_failed');assert.equal(n.summary().retryExhausted,true);assert.equal(n.summary().nextRetryAt,undefined);
  now=9999999;await n.check();assert.equal(attempts,3);assert.equal(n.canCheck(),false);assert.deepEqual(w.store.get('nativeContinuationCapability'),n.summary());
});
test('explicit lock mismatch or absent official method is unsupported without automatic retry',async()=>{
  for(const error of [Object.assign(Error('Writer not excluded'),{probeState:'lock_unsupported',probeCode:'NATIVE_ACTIVE_WRITER_NOT_EXCLUDED'}),Object.assign(Error('Method not found'),{code:-32601})]){
    const w=worker();let attempts=0;const n=new NativeContinuation(w,{probe:async()=>{attempts++;throw error;}});await n.check();assert.equal(n.summary().state,'lock_unsupported');assert.equal(n.summary().retryExhausted,false);await n.check();assert.equal(attempts,1);
  }
});
test('stopping and busy nodes never begin an isolated probe',async()=>{
  const w=worker();let attempts=0;const n=new NativeContinuation(w,{probe:async()=>{attempts++;return {supported:true,state:'ready'};}});
  w.active.set('business',{});await n.check();assert.equal(attempts,0);w.active.clear();w.stopping=true;await n.check();assert.equal(attempts,0);w.stopping=false;await n.check();assert.equal(attempts,1);
});
