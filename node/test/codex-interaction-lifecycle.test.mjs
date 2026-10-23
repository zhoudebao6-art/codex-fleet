import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexRPC,runCodex} from '../src/codex.mjs';

function harness(t,{onStart,onInterrupt,effective={approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}}={}){
  const calls=[],sent=[],progress=[];let rpc,control,resolveReady;
  const ready=new Promise(r=>resolveReady=r);
  t.mock.method(CodexRPC.prototype,'start',async function(){rpc=this;return this;});
  t.mock.method(CodexRPC.prototype,'close',async()=>{});
  t.mock.method(CodexRPC.prototype,'send',function(message){sent.push(message);});
  t.mock.method(CodexRPC.prototype,'call',async function(method,params){
    calls.push({method,params});
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread'},...effective};
    if(method==='turn/start'){if(onStart)setImmediate(()=>onStart(this));return {turn:{id:'turn'}};}
    if(method==='turn/interrupt')return onInterrupt?.(this)||{};
    return {};
  });
  return {calls,sent,progress,ready,get rpc(){return rpc;},get control(){return control;},hooks:{onProgress:p=>progress.push(p),onReady:c=>{control=c;resolveReady(c);}},complete(status='completed'){rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status}}});}};
}
const run=(spec={})=>({task:'task',cwd:'D:\\project',sandbox:'workspace-write',spec:{mode:'execute',prompt:'Inspect actual project',...spec}});
const approval={id:7,method:'item/commandExecution/requestApproval',params:{command:'node --version',cwd:'D:\\project'}};

test('ordinary desktop conversation sends the exact message with no Fleet work-order wrapper',async t=>{
  const h=harness(t),promise=runCodex({desktopSessionBridge:'fixture'},null,run({intent:'conversation',requireDesktop:true,worktree:false,executionPolicy:'local',prompt:'只回复我你好'}),h.hooks);
  await h.ready;h.complete();await promise;
  assert.deepEqual(h.calls.find(c=>c.method==='turn/start').params.input,[{type:'text',text:'只回复我你好'}]);
  assert.equal(h.calls.find(c=>c.method==='thread/name/set').params.name,'只回复我你好');
  assert.equal(h.calls.filter(c=>c.method==='thread/start').length,1);
  assert.equal(h.calls.some(c=>c.method==='thread/resume'),false);
});
test('desktop-required work never silently runs through a background executor',async()=>{
  await assert.rejects(runCodex({},null,run({requireDesktop:true})),e=>e.preflightBlocked===true);
});

test('shared desktop transport loss after dispatch is uncertain, never a confirmed stop or automatic resend',async t=>{
  const h=harness(t),promise=runCodex({desktopSessionBridge:'fixture'},null,run(),h.hooks);
  await h.ready;h.rpc.bridge={};h.rpc.emit('exit',{bridge:true});
  await assert.rejects(promise,e=>e.deliveryUncertain===true&&e.threadId==='thread');
  assert.equal(h.calls.filter(x=>x.method==='turn/start').length,1);
});

test('execute local mode inherits machine policy and reports the returned effective policy',async t=>{
  const h=harness(t),promise=runCodex({},null,run({executionPolicy:'local'}),h.hooks);await h.ready;h.complete();await promise;
  const params=h.calls.find(c=>c.method==='thread/start').params;assert.equal(Object.hasOwn(params,'approvalPolicy'),false);assert.equal(Object.hasOwn(params,'sandbox'),false);
  const policy=h.progress.find(p=>p.kind==='execution_policy');assert.equal(policy.policy,'local');assert.equal(policy.approvalPolicy,'never');assert.equal(policy.sandbox,'dangerFullAccess');
});

test('a question cannot inherit write permission even when a caller requests local policy',async t=>{
  const h=harness(t,{effective:{approvalPolicy:'on-request',sandbox:{type:'readOnly'}}}),r=run({mode:'question',executionPolicy:'local'});r.sandbox='read-only';const promise=runCodex({},null,r,h.hooks);await h.ready;h.complete();await promise;
  const params=h.calls.find(c=>c.method==='thread/start').params;assert.equal(params.approvalPolicy,'on-request');assert.equal(params.sandbox,'read-only');assert.equal(h.progress.find(p=>p.kind==='execution_policy').policy,'project');
});

test('older tasks without an explicit execution policy retain project restrictions',async t=>{
  const h=harness(t,{effective:{approvalPolicy:'on-request',sandbox:{type:'workspaceWrite'}}}),promise=runCodex({},null,run(),h.hooks);await h.ready;h.complete();await promise;
  const params=h.calls.find(c=>c.method==='thread/start').params;assert.equal(params.approvalPolicy,'on-request');assert.equal(params.sandbox,'workspace-write');
});

test('cancelling an interactive turn aborts its wait before interrupting and drops a late approval',async t=>{
  let resolveAnswer,interactionSignal,resolveStarted;const started=new Promise(r=>resolveStarted=r);
  const h=harness(t,{onInterrupt(){assert.equal(interactionSignal.aborted,true,'Abort must happen before the remote interrupt RPC');resolveAnswer({decision:'accept'});setImmediate(()=>h.complete('interrupted'));}});
  const promise=runCodex({},null,run(),{...h.hooks,onInteraction:(_interaction,signal)=>{interactionSignal=signal;resolveStarted();return new Promise(r=>resolveAnswer=r);}});
  await h.ready;h.rpc.emit('request',approval);await started;await h.control.cancel();const result=await promise;
  assert.equal(result.status,'cancelled');assert.equal(h.sent.some(m=>m.id===approval.id),false);assert.equal(h.progress.some(p=>p.kind==='interaction_resolved'),false);
});

test('deadline expiry also aborts pending interaction before an answer can reach Codex',async t=>{
  let resolveAnswer,interactionSignal,resolveStarted;const started=new Promise(r=>resolveStarted=r);
  const h=harness(t,{onInterrupt(){assert.equal(interactionSignal.aborted,true,'Deadline must close the approval channel before interrupt');resolveAnswer({decision:'accept'});setImmediate(()=>h.complete('interrupted'));}});
  const promise=runCodex({maxTaskMs:50},null,run(),{...h.hooks,onInteraction:(_interaction,signal)=>{interactionSignal=signal;resolveStarted();return new Promise(r=>resolveAnswer=r);}});
  await h.ready;h.rpc.emit('request',approval);await started;const result=await promise;
  assert.equal(result.status,'blocked');assert.equal(h.sent.some(m=>m.id===approval.id),false);assert.equal(h.progress.some(p=>p.kind==='interaction_resolved'),false);
});

test('a human response is forwarded once but never marks the task completed before its turn event',async t=>{
  let resolveAnswer;const resolved=[];const h=harness(t),promise=runCodex({},null,run(),{...h.hooks,onInteraction:()=>new Promise(r=>resolveAnswer=r),onInteractionResolved:id=>resolved.push(id)});let finished=false;promise.then(()=>finished=true);
  await h.ready;h.rpc.emit('request',approval);resolveAnswer({decision:'decline'});await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.deepEqual(h.sent.filter(m=>m.id===approval.id).map(m=>m.result),[{decision:'decline'}]);assert.equal(resolved.length,1);
  h.complete('completed');assert.equal((await promise).status,'submitted');
});

test('an ACK persistence failure cannot send a second decision after the human reply',async t=>{
  let resolveAnswer;const h=harness(t),promise=runCodex({},null,run(),{...h.hooks,onInteraction:()=>new Promise(r=>resolveAnswer=r),onInteractionResolved:()=>{throw Error('Local disk temporarily unavailable');}});await h.ready;h.rpc.emit('request',approval);resolveAnswer({decision:'accept'});await new Promise(r=>setImmediate(r));
  assert.deepEqual(h.sent.filter(m=>m.id===approval.id).map(m=>m.result),[{decision:'accept'}]);assert.ok(h.progress.some(p=>p.kind==='attention'&&/acknowledgement could not be recorded/.test(p.message)));h.complete();assert.equal((await promise).status,'blocked');
});
