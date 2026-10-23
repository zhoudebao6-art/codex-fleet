import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readCompletionProof} from '../src/completion-proof.mjs';
import {recoverCompletedAttempt} from '../src/completion-recovery.mjs';
import {CodexRPC,runCodex} from '../src/codex.mjs';
import {Worker} from '../src/worker.mjs';

const turn=(overrides={})=>({id:'turn',status:'completed',completedAt:1792522536,items:[
  {type:'userMessage',content:[{type:'text',text:'Fleet task task. Role: worker.'}]},
  {type:'agentMessage',phase:'final_answer',text:'actual final'}],...overrides});
function reader({value=turn(),cwd='D:/project',status='notLoaded'}={}){
  const calls=[];return {calls,start:async()=>{},close:async()=>{},call:async(method,params)=>{
    calls.push({method,params});if(method==='thread/read')return {thread:{id:'thread',cwd,status:{type:status}}};
    if(method==='thread/turns/list')return {data:[value]};throw Error('Unexpected mutating method '+method);
  }};
}
test('exact terminal proof reads only and cannot confuse idle, later or active turns with completion',async()=>{
  const args={task:'task',thread:'thread',cwd:'D:/project',turnId:'turn'};
  const ok=reader();assert.equal((await readCompletionProof(ok,args)).summary,'actual final');
  assert.deepEqual(ok.calls.map(c=>c.method),['thread/read','thread/turns/list']);
  for(const options of [{value:turn({id:'later'})},{value:turn({status:'inProgress'})},{value:turn({completedAt:null})},{cwd:'D:/other'},{status:'active'}]){
    assert.equal(await readCompletionProof(reader(options),args),null);
  }
  assert.equal(await readCompletionProof(reader(),{...args,turnId:null}),null);
  assert.ok(await readCompletionProof(reader(),{...args,turnId:null,legacy:true}));
  assert.equal(await readCompletionProof(reader({value:turn({items:[]})}),{...args,turnId:null,legacy:true}),null);
});
test('lost completion notification is recovered without resending, resuming or interrupting the task',async t=>{
  const calls=[];
  t.mock.method(CodexRPC.prototype,'start',async function(){if(this.config.desktopSessionBridge)this.bridge={};return this;});
  t.mock.method(CodexRPC.prototype,'close',async()=>{});
  t.mock.method(CodexRPC.prototype,'call',async function(method,params){
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start')return {turn:{id:'turn'}};
    if(method==='thread/read')return {thread:{id:'thread',cwd:'D:/project',status:{type:'notLoaded'}}};
    if(method==='thread/turns/list')return {data:[turn()]};
    return {};
  });
  const result=await runCodex({desktopSessionBridge:'fixture',completionCheckMs:50},null,{task:'task',attempt:'a',cwd:'D:/project',spec:{mode:'execute',prompt:'test'}});
  assert.equal(result.status,'submitted');assert.equal(result.completionProof.method,'exact_terminal_turn');
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1);
  assert.equal(calls.some(x=>['thread/resume','turn/interrupt','turn/steer'].includes(x.method)),false);
});
test('restart recovery snapshots real outputs for the same attempt; cancellation and active executions are untouched',async t=>{
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-completion-'),cwd=path.join(dir,'project');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'receipt.json'),'{"actual":true}');
  const w=new Worker({nodeId:'node',dataDir:dir,projects:{}},null,async()=>{});
  t.after(()=>w.store.close());w.store.add({id:'task',attempt:'attempt',spec:{outputs:['receipt.json']}});w.store.update('task',{status:'uncertain',thread:'thread',cwd});
  let cloud={id:'task',attempt:'attempt',target:'node',status:'running'};
  w.api=async()=>cloud;
  w.active.set('task',{});assert.equal(await recoverCompletedAttempt(w,'task'),false);w.active.clear();
  cloud={...cloud,status:'cancel_requested'};assert.equal(await recoverCompletedAttempt(w,'task'),false);
  cloud={...cloud,status:'running'};
  assert.equal(await recoverCompletedAttempt(w,'task',{rpcFactory:()=>reader({cwd})}),true);
  const recovered=w.store.run('task');assert.equal(recovered.status,'uploading');assert.equal(recovered.result.artifacts.length,1);
  assert.equal(fs.readFileSync(path.join(dir,'artifacts',recovered.result.artifacts[0].sha),'utf8'),'{"actual":true}');
  assert.equal(await recoverCompletedAttempt(w,'task'),false);
});
