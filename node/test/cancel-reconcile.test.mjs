import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LocalStore} from '../src/local-store.mjs';
import {reconcileCancellation} from '../src/cancel-reconcile.mjs';
import http from 'node:http';
import {CodexRPC} from '../src/codex.mjs';

function fixture(t){
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-cancel-'),store=new LocalStore(dir);
 t.after(()=>store.close());store.add({id:'task',attempt:'attempt',spec:{project:'workspace'}});store.update('task',{status:'uncertain',thread:'thread',cwd:dir});
 const config={nodeId:'node',dataDir:dir,codexPath:process.execPath},cloud={id:'task',attempt:'attempt',target:'node',status:'cancel_requested'};let reads=0;
 const args={config,store,taskId:'task',api:async()=>{reads++;return cloud;}};
 const calls=[],rpc={start:async()=>{},close:async()=>calls.push('close'),call:async method=>{calls.push(method);assert.equal(method,'thread/read');return {thread:{id:'thread',status:{type:'idle'}}};}};
 const deps={rpcFactory:()=>rpc,probe:async()=>({supported:true,checkedAt:new Date().toISOString()}),resume:async()=>{calls.push('resume-idle');}};
 return {dir,store,cloud,args,deps,calls,rpc,reads:()=>reads};
}
test('orphan cancellation needs exclusive idle proof, emits one durable completion, and never sends a turn',async t=>{
 const f=fixture(t),r=await reconcileCancellation(f.args,f.deps);assert.equal(r.state,'cancelled');assert.equal(f.reads(),2);assert.equal(f.store.run('task').status,'cancelled');assert.equal(f.store.pending().length,1);assert.equal(f.store.pending()[0].result.cancellation.method,'exclusive_idle_writer');assert.deepEqual(f.calls,['resume-idle','thread/read','close']);assert.equal((await reconcileCancellation(f.args,f.deps)).state,'not_eligible');assert.equal(f.store.pending().length,1);
});
for(const kind of ['network','wrong-node','wrong-attempt','no-cancel','busy-writer','probe-failed','active-after-resume','native-thread','cloud-race','local-race'])test('preserves uncertain work: '+kind,async t=>{
 const f=fixture(t);
 if(kind==='network')f.args.api=async()=>{throw Error('offline');};
 if(kind==='wrong-node')f.cloud.target='other';if(kind==='wrong-attempt')f.cloud.attempt='other';if(kind==='no-cancel')f.cloud.status='running';
 if(kind==='busy-writer')f.deps.resume=async()=>{throw Error('already has an active writer');};
 if(kind==='probe-failed')f.deps.probe=async()=>({supported:false});
 if(kind==='active-after-resume')f.rpc.call=async()=>({thread:{id:'thread',status:{type:'active'}}});
 if(kind==='native-thread')f.store.db.prepare('UPDATE runs SET spec=?').run(JSON.stringify({desktopThreadId:'thread'}));
 if(kind==='cloud-race')f.deps.resume=async()=>{f.cloud.attempt='new';};
 if(kind==='local-race')f.deps.resume=async()=>{f.store.update('task',{thread:'changed'});};
 assert.equal((await reconcileCancellation(f.args,f.deps)).state,'waiting');assert.equal(f.store.run('task').status,'uncertain');assert.equal(f.store.pending().length,0);assert.ok(!fs.existsSync(path.join(f.dir,'cancel-recovery.lock')));assert.equal((await reconcileCancellation(f.args,f.deps)).state,'backoff');
});
test('a shared executor can confirm the exact idle Fleet conversation without a new writer',async t=>{
 const f=fixture(t);f.args.config.desktopSessionBridge='test';f.rpc.call=async method=>{f.calls.push(method);return method==='thread/loaded/list'?{data:['thread']}:{thread:{id:'thread',status:{type:'idle'}}};};f.deps.probe=async()=>assert.fail('No new writer needed');
 assert.equal((await reconcileCancellation(f.args,f.deps)).proof.method,'shared_executor_idle');assert.deepEqual(f.calls,['thread/loaded/list','thread/read','thread/read','close']);
});
test('active local task or concurrent recovery never enters a Codex session',async t=>{
 const f=fixture(t);assert.equal((await reconcileCancellation({...f.args,isActive:()=>true},f.deps)).state,'not_eligible');fs.writeFileSync(path.join(f.dir,'cancel-recovery.lock'),JSON.stringify({pid:process.pid}));assert.equal((await reconcileCancellation(f.args,f.deps)).state,'busy');assert.equal(f.calls.length,0);
});
test('operator-resolved uncertain attempt is reconciled locally only after proof and never overwrites its cloud result',async t=>{
 const f=fixture(t);f.cloud.status='failed';f.cloud.result={error:'Operator resolved uncertain attempt',note:'desktop closed'};
 const result=await reconcileCancellation(f.args,f.deps);assert.equal(result.state,'operator_resolved');assert.equal(f.store.run('task').status,'failed');assert.deepEqual(f.store.run('task').result.operatorResolution,f.cloud.result);assert.equal(f.store.pending().length,0);assert.ok(f.calls.includes('resume-idle'));
});

test('installed CLI refuses the live original writer then reconciles its closed idle session without another turn',{skip:!process.env.FLEET_TEST_CODEX_PATH,timeout:90000},async t=>{
 const f=fixture(t),home=path.join(f.dir,'home');fs.mkdirSync(home);const sockets=new Set();let requests=0;
 const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.created\ndata: '+JSON.stringify({type:'response.created',response:{id:'resp_cancel_probe',object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:'gpt-6.1-sol',output:[]}})+'\n\n');});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6.1-sol"\nmodel_provider = "fleet_cancel_probe"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fleet_cancel_probe]\nname = "Isolated cancellation check"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
 Object.assign(f.args.config,{codexHome:home,codexPath:process.env.FLEET_TEST_CODEX_PATH});const owner=new CodexRPC(f.args.config,null);let id,turn;
 try{
   await owner.start();id=(await owner.call('thread/start',{cwd:f.dir,approvalPolicy:'on-request',sandbox:'read-only'})).thread.id;turn=(await owner.call('turn/start',{threadId:id,input:[{type:'text',text:'Inert cancellation test. Do not execute tools.'}]})).turn.id;
   f.store.update('task',{thread:id});const first=await reconcileCancellation(f.args);assert.equal(first.state,'waiting');assert.match(first.reason,/still loaded|currently running/);assert.equal(f.store.run('task').status,'uncertain');
   await owner.call('turn/interrupt',{threadId:id,turnId:turn});await owner.close();f.store.put('cancelRecovery:task',{});const before=requests;
   const result=await reconcileCancellation(f.args);assert.equal(result.state,'cancelled',JSON.stringify(result));assert.equal(result.proof.threadId,id);assert.equal(requests,before,'No additional model request');assert.equal(f.store.pending().length,1);
 }finally{if(id&&turn&&!owner.closed)await owner.call('turn/interrupt',{threadId:id,turnId:turn}).catch(()=>{});await owner.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
