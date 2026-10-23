import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Worker} from '../src/worker.mjs';
import {FleetClient,enroll,prepareNode} from '../src/client.mjs';
import {runCodex,publicProgress,publicSanitizer,CodexRPC} from '../src/codex.mjs';
import {uid,hash,mkdir,validateSpec,httpRequest,writeJson,fileHash} from '../src/common.mjs';

function fixture(t,executor=async()=>({status:'submitted',summary:'tested'}),inspector){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-sites-test-')),project=mkdir(path.join(root,'project')),data=mkdir(path.join(root,'node'));
  const config={nodeId:uid(),nodeToken:'private-node-token',sitesToken:'private-platform-token',hubUrl:'http://127.0.0.1:1',enrollmentState:'enrolled',dataDir:data,desktopSync:false,projects:{workspace:{root:project,sandbox:'workspace-write'}}},file=path.join(root,'node.json');writeJson(file,config);
  // This suite tests Fleet transport/execution, not the native task collector or
  // workspace synchronizer (both have their own dedicated suites).
  const worker=new Worker(config,file,executor,inspector);worker.workspaces.sync=async()=>{};worker.delivery.tick=async()=>{};t.after(async()=>{worker.stopping=true;await worker.desktop?.close();await Promise.allSettled([worker.uploadPromise,worker.probePromise,worker.desktopPromise,worker.workspacePromise,worker.interactionAckPromise].filter(Boolean));worker.store.close();});
  const task=(extra={})=>{const id=uid();return {id,attempt:uid(),status:'claimed',spec:{id,targetNode:config.nodeId,project:'workspace',prompt:'Read the input',worktree:false,...extra}};};return {root,project,data,config,file,worker,task};
}
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return {s,url:`http://127.0.0.1:${s.address().port}`};}

test('inputs reject escaping, duplicate and Windows device paths',()=>{
  const base={id:'safe',targetNode:'node',project:'workspace',prompt:'x'},a={sha:hash('x'),size:1,name:'notes/input.txt'};validateSpec({...base,inputs:[a]});
  for(const name of ['../escape','a/../b','C:\\data','/root','a//b','CON','a/nul.txt','name.','a:stream','star*.txt'])assert.throws(()=>validateSpec({...base,inputs:[{...a,name}]}));
  assert.throws(()=>validateSpec({...base,inputs:[a,{...a,name:'NOTES/INPUT.TXT'}]}),/Duplicate/);
});

test('staging resumes partial files in the actual Git worktree and read receipts stay task-scoped',async t=>{
  let executed;const bytes=Buffer.from('Project budget is 42. 已确认资料。'),sha=hash(bytes);
  const f=fixture(t,async(c,file,run,h)=>{executed=run;h.onContextAttached();assert.equal(fs.readFileSync(run.inputs[0].path,'utf8'),bytes.toString());const client=new FleetClient({...c,parentTaskId:run.task});try{const receipt=client.readReceipt({taskId:run.task,sha256:sha,localPath:run.inputs[0].path,summary:'Budget is 42; verified the supplied text. '+c.nodeToken});assert.equal(receipt.evidence,'codex_self_report');assert.throws(()=>client.readReceipt({taskId:uid(),sha256:sha,localPath:run.inputs[0].path,summary:'wrong task'}),/current Fleet task/);}finally{client.close();}return {status:'submitted',summary:'Read budget 42'};});
  const git=(...args)=>execFileSync('git',['-C',f.project,...args],{encoding:'utf8',windowsHide:true});git('init');fs.writeFileSync(path.join(f.project,'tracked.txt'),'seed');git('add','.');git('-c','user.name=Fleet test','-c','user.email=fleet@example.test','commit','-m','fixture');
  const task=f.task({worktree:true,mode:'question',inputs:[{sha,size:bytes.length,name:'notes.txt'}]});const run=f.worker.prepare({...task,task:task.id});const destination=path.join(run.cwd,'inbox',task.id,'notes.txt');mkdir(path.dirname(destination));fs.writeFileSync(destination+'.'+sha+'.partial',bytes.subarray(0,8));
  const ranges=[];f.worker.api=async(route,options)=>{assert.ok(route.includes(`task=${task.id}`));const m=/bytes=(\d+)-(\d+)/.exec(options.headers.range);ranges.push(Number(m[1]));return bytes.subarray(Number(m[1]),Number(m[2])+1);};
  await f.worker.execute(task);assert.equal(executed.sandbox,'read-only');assert.notEqual(executed.cwd,f.project);assert.deepEqual(ranges,[8]);assert.equal(fileHash(destination),sha);assert.equal(fs.existsSync(path.join(f.project,'inbox',task.id,'notes.txt')),false);
  const input=f.worker.store.inputs(task.id)[0];assert.equal(input.stage,'context_attached');assert.equal(input.receipt.evidence,'codex_self_report');assert.ok(!input.receipt.summary.includes(f.config.nodeToken));assert.ok(input.receipt.summary.includes('[credential redacted]'));assert.equal(f.worker.store.pending().filter(e=>e.kind==='input_read_receipt').length,1);
});

test('download verification does not fabricate reading receipts and blocks mismatching file overwrite',async t=>{
  const f=fixture(t),bytes=Buffer.from('real input'),a={sha:hash(bytes),size:bytes.length,name:'source.txt'},task=f.task({inputs:[a]});f.worker.store.add(task);const plan=f.worker.prepare({...task,task:task.id});f.worker.api=async()=>bytes;
  const [input]=await f.worker.prepareInputs(plan,{});assert.equal(f.worker.store.inputs(task.id)[0].stage,'checksummed');assert.equal(f.worker.store.inputs(task.id)[0].receipt,null);f.worker.store.update(task.id,{cwd:plan.cwd,status:'running'});
  const c=new FleetClient({...f.config,parentTaskId:task.id});try{assert.throws(()=>c.readReceipt({taskId:task.id,sha256:a.sha,localPath:input.path,summary:'not attached'}),/not attached/);}finally{c.close();}
  fs.writeFileSync(input.path,'changed');await assert.rejects(f.worker.prepareInputs(plan,{}),/different contents/);
});

test('retryable 408 425 and 429 preserve every queued event',async t=>{
  const f=fixture(t);for(const status of [408,425,429]){const id=f.worker.store.emit({type:'message',taskId:uid(),text:'keep me'});f.worker.api=async()=>{throw Object.assign(new Error('retry'),{status});};await assert.rejects(f.worker.tick(),/retry/);assert.ok(f.worker.store.pending().some(e=>e.id===id));assert.deepEqual(f.worker.store.errors(),[]);}
});

test('slow Codex inspection reports checking without delaying the heartbeat',async t=>{
  let finish;const f=fixture(t,runCodex,()=>new Promise(r=>finish=r));const seen=[];f.worker.api=async(route,options)=>{seen.push(options.body.capabilities);return {ack:[],tasks:[],nextPollMs:10000};};await f.worker.tick();assert.equal(seen[0].executorState,'checking');assert.equal(seen[0].ready,false);finish({ready:true});await f.worker.probePromise;await f.worker.tick();assert.equal(seen[1].ready,true);assert.equal(f.worker.nextPollMs,10000);
});

test('slow upload does not block a second heartbeat and each upload pass is bounded',async t=>{
  const f=fixture(t),task=f.task(),bytes=Buffer.alloc(2*1024*1024+3,7),sha=hash(bytes);f.worker.store.add(task);f.worker.store.update(task.id,{status:'uploading',result:{status:'submitted',artifacts:[{sha,size:bytes.length,name:'out.bin'}]}});mkdir(path.join(f.data,'artifacts'));fs.writeFileSync(path.join(f.data,'artifacts',sha),bytes);
  let release,offset=0,syncs=0,puts=0;f.worker.api=async(route,options)=>{if(route==='/v1/sync'){syncs++;return {ack:[],tasks:[]};}if(options.method==='POST')return new Promise(r=>release=()=>r({offset,complete:false}));puts++;offset+=options.body.length;return {offset,complete:offset===bytes.length};};
  await f.worker.tick();await f.worker.tick();assert.equal(syncs,2);release();await f.worker.uploadPromise;assert.equal(puts,1);assert.equal(offset,1024*1024);assert.equal(f.worker.store.run(task.id).status,'uploading');
});

test('Sites service header is separate, redirects are never followed and raw errors are meaningful',async t=>{
  let credentials;const s=await server(t,(req,res)=>{credentials=req.headers;if(req.url==='/redirect'){res.writeHead(302,{location:'https://untrusted.example/'});res.end();}else if(req.url==='/html'){res.writeHead(200,{'content-type':'text/html'});res.end('sign in');}else if(req.url==='/limit'){res.writeHead(429,{'content-type':'text/plain','retry-after':'3'});res.end('limited');}else{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}});
  await httpRequest(s.url,'/ok',{token:'node',sitesToken:'platform'});assert.equal(credentials.authorization,'Bearer node');assert.equal(credentials['oai-sites-authorization'],'Bearer platform');
  await assert.rejects(httpRequest(s.url,'/redirect'),e=>e.code==='HUB_LOGIN_REDIRECT');await assert.rejects(httpRequest(s.url,'/html'),e=>e.code==='HUB_LOGIN_REQUIRED');await assert.rejects(httpRequest(s.url,'/limit',{raw:true}),e=>e.status===429&&e.retryAfterMs===3000);await assert.rejects(httpRequest(s.url,'//other.example'),/same-hub/);
});

test('HTTP CONNECT proxy receives no Fleet or Sites credentials when it rejects a tunnel',async t=>{
  const s=await server(t,(req,res)=>res.end());let headers;s.s.on('connect',(req,socket)=>{headers=req.headers;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});await assert.rejects(httpRequest('https://fleet-proxy-test.example','/v1/nodes',{proxy:s.url,token:'node-secret',sitesToken:'site-secret'}),e=>e.status===407);assert.equal(headers.authorization,undefined);assert.equal(headers['oai-sites-authorization'],undefined);
});

test('public progress excludes reasoning and raw command, MCP arguments and output',()=>{
  assert.equal(publicProgress('item/completed',{type:'reasoning',text:'private'}),null);assert.equal(publicProgress('item/reasoning/textDelta',{type:'agentMessage',text:'private'}),null);
  const p=publicProgress('item/completed',{id:'tool-42',type:'mcpToolCall',tool:'read_file',arguments:{password:'secret'},result:'sensitive raw output',status:'completed',durationMs:23});assert.deepEqual({...p,observedAt:undefined},{kind:'tool_activity',toolType:'mcpToolCall',tool:'read_file',status:'completed',itemId:'tool-42',durationMs:23,observedAt:undefined});assert.ok(!JSON.stringify(p).includes('secret'));assert.ok(Number.isFinite(Date.parse(p.observedAt)));assert.equal('exitCode' in p,false);
  const command=publicProgress('item/completed',{id:'cmd',type:'commandExecution',exitCode:1,durationMs:0,command:'private command',aggregatedOutput:'raw output'});assert.equal(command.exitCode,1);assert.equal(command.durationMs,0);assert.equal('command' in command,false);assert.equal('aggregatedOutput' in command,false);
});

test('console tickets only open the enrolled origin and never expose node credentials',async t=>{
  const f=fixture(t),c=new FleetClient(f.config);t.after(()=>c.close());c.api=async()=>({ticket:'one-time-ticket-for-this-device',siteUrl:'https://evil.example'});await assert.rejects(c.consoleTicket(),/match this hub/);c.api=async()=>({ticket:'one-time-ticket-for-this-device',siteUrl:f.config.hubUrl});const url=await c.consoleTicket();assert.ok(url.includes('#device-ticket='));assert.ok(!url.includes(f.config.nodeToken));
});

test('read-only MCP hides and rejects mutating tools',async t=>{
  const f=fixture(t);const messages=[{id:1,method:'tools/list'},{id:2,method:'tools/call',params:{name:'fleet_assign',arguments:{project:'workspace',prompt:'mutate'}}}];
  const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--config',f.file,'--read-only'],{windowsHide:true});let out='';child.stdout.on('data',b=>out+=b);child.on('error',reject);child.on('exit',code=>code?reject(new Error('MCP failed')):resolve(out.trim().split('\n').map(JSON.parse)));child.stdin.end(messages.map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');});
  assert.ok(!result[0].result.tools.some(x=>x.name==='fleet_assign'));assert.ok(result[0].result.tools.some(x=>x.name==='fleet_read_receipt'));assert.equal(result[1].result.isError,true);assert.match(result[1].result.content[0].text,/read-only/);
});

test('file handoff survives source changes and upload interruptions before exactly one assignment',async t=>{
  const f=fixture(t),c=new FleetClient(f.config);t.after(()=>c.close());const data=Buffer.alloc(2*1024*1024+11,23);fs.writeFileSync(path.join(f.project,'handoff.bin'),data);
  const args={id:'repeat-safe-handoff',project:'workspace',relativePath:'handoff.bin',targetNode:uid(),prompt:'Read this binary with appropriate local tools'};
  const transfer=await c.sendFile(args);assert.equal(transfer.status,'queued');assert.equal((await c.sendFile(args)).id,transfer.id);assert.equal(f.worker.store.pending().filter(e=>e.type==='assign').length,0);
  fs.writeFileSync(path.join(f.project,'handoff.bin'),'later edits do not change the snapshot');let received=Buffer.alloc(0),breakOnce=true;
  f.worker.api=async(route,options)=>{if(route==='/v1/files')return {offset:received.length,complete:received.length===data.length,chunkSize:1024*1024};if(breakOnce&&received.length===1024*1024){breakOnce=false;throw new Error('offline');}received=Buffer.concat([received,options.body]);return {offset:received.length,complete:received.length===data.length};};
  await f.worker.uploads();await f.worker.uploads();assert.match(c.fileStatus(transfer.id).error,/offline/);assert.equal(c.fileStatus(transfer.id).bytes,1024*1024);assert.equal(f.worker.store.pending().filter(e=>e.type==='assign').length,0);const retry=f.worker.store.get('uploadRetry:file:'+transfer.id);assert.ok(retry.retryAt>Date.now());f.worker.store.put('uploadRetry:file:'+transfer.id,{...retry,retryAt:0});await f.worker.uploads();await f.worker.uploads();await f.worker.uploads();
  assert.deepEqual(received,data);assert.equal(c.fileStatus(transfer.id).status,'complete');const assignments=f.worker.store.pending().filter(e=>e.type==='assign');assert.equal(assignments.length,1);assert.deepEqual(assignments[0].spec.inputs,[{sha:hash(data),size:data.length,name:'handoff.bin'}]);
});

test('diagnostic export excludes credentials prompts filenames and source content',async t=>{
  const f=fixture(t),c=new FleetClient(f.config);t.after(()=>c.close());const task=f.task({prompt:'private prompt body'});f.worker.store.add(task);f.worker.store.put('connection',{online:false,error:'Rejected '+f.config.nodeToken+' '+f.config.sitesToken});const report=JSON.stringify(c.diagnostics());for(const secret of [f.config.nodeToken,f.config.sitesToken,'private prompt body',f.project])assert.ok(!report.includes(secret));assert.ok(report.includes('[redacted]'));
});

test('runtime secrets are removed from assistant plan attention final summary and RPC errors',async t=>{
  const config={nodeToken:'known-node-credential',sitesToken:'known-site-credential',adminToken:'known-admin-credential'},messages=[];
  t.mock.method(CodexRPC.prototype,'start',async function(){return this;});t.mock.method(CodexRPC.prototype,'close',async()=>{});
  t.mock.method(CodexRPC.prototype,'call',async function(method){
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){queueMicrotask(()=>{
      this.emit('notification',{method:'turn/plan/updated',params:{plan:[{step:'Review '+config.nodeToken,status:'in_progress',privateOutput:'must not forward'}]}});
      this.emit('notification',{method:'item/completed',params:{item:{id:'tool',type:'mcpToolCall',tool:config.sitesToken,status:'completed',durationMs:10,arguments:{token:config.nodeToken},result:'must not forward'}}});
      this.emit('notification',{method:'item/completed',params:{item:{type:'agentMessage',text:'Result '+config.nodeToken+' '+config.sitesToken+' '+config.adminToken}}});
      this.emit('request',{id:99,method:'requestApproval/'+config.adminToken});
      this.emit('notification',{method:'turn/completed',params:{turn:{id:'turn',status:'failed',error:{message:config.adminToken}}}});
    });return {turn:{id:'turn'}};}return {};
  });
  const result=await runCodex(config,null,{task:'task',cwd:os.tmpdir(),sandbox:'read-only',spec:{prompt:'Read only',mode:'question'}},{onProgress:p=>messages.push(p)});
  const serialized=JSON.stringify({messages,result});for(const secret of Object.values(config))assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes('must not forward'));assert.ok(serialized.includes('[credential redacted]'));assert.equal(messages.find(p=>p.kind==='tool_activity').durationMs,10);assert.equal(result.status,'blocked');
  t.mock.method(CodexRPC.prototype,'call',async()=>{throw new Error('RPC failed: '+config.nodeToken);});await assert.rejects(runCodex(config,null,{task:'task',cwd:os.tmpdir(),spec:{prompt:'x'}}),e=>!e.message.includes(config.nodeToken)&&e.message.includes('[credential redacted]'));
  assert.equal(publicSanitizer({}, {OPENAI_API_KEY:'known-environment-api-key'})('known-environment-api-key'),'[credential redacted]');
});

test('worker persists only filtered public progress and failure messages before outbox replay',async t=>{
  const f=fixture(t,async(config,file,run,hooks)=>{hooks.onProgress({kind:'attention',message:'Need '+config.nodeToken});throw new Error('Failure '+config.sitesToken);}),task=f.task();await f.worker.execute(task);await f.worker.uploads();
  const events=JSON.stringify(f.worker.store.pending());assert.ok(!events.includes(f.config.nodeToken));assert.ok(!events.includes(f.config.sitesToken));assert.ok(events.includes('[credential redacted]'));assert.equal(f.worker.store.run(task.id).status,'failed');
  // Authorization payloads are user task data, not generated public progress.
  const assignment={type:'assign',spec:{id:'authorized-task',prompt:f.config.nodeToken}};f.worker.emit(assignment);assert.equal(f.worker.store.pending().find(e=>e.type==='assign').spec.prompt,f.config.nodeToken);
});

function uploading(f,text='retained output'){
  const task=f.task(),bytes=Buffer.from(text),sha=hash(bytes),snapshot=path.join(mkdir(path.join(f.data,'artifacts')),sha);fs.writeFileSync(snapshot,bytes);f.worker.store.add(task);f.worker.store.update(task.id,{status:'uploading',result:{status:'submitted',summary:text,artifacts:[{sha,size:bytes.length,name:'result.txt'}]}});return {...task,sha,bytes,snapshot};
}

test('terminal conflict stops only that upload and preserves its result snapshot while following work completes',async t=>{
  const f=fixture(t),stopped=uploading(f,'retain first'),next=uploading(f,'next output');const c=new FleetClient(f.config);t.after(()=>c.close());let puts=0;
  f.worker.api=async(route,options)=>{if(route==='/v1/tasks/'+stopped.id)return {id:stopped.id,attempt:stopped.attempt,status:'failed'};if(route.includes('task='+stopped.id))throw Object.assign(new Error('Task is terminal'),{status:409});if(options.method==='POST')return {offset:0,complete:false};puts++;return {offset:next.bytes.length,complete:true};};
  await f.worker.uploads();assert.equal(puts,1);assert.equal(f.worker.store.run(stopped.id).status,'upload_stopped');assert.equal(f.worker.store.run(stopped.id).result.summary,'retain first');assert.equal(fileHash(stopped.snapshot),stopped.sha);assert.equal(f.worker.store.run(next.id).status,'submitted');assert.equal(f.worker.store.pending().filter(e=>e.type==='finished'&&e.taskId===stopped.id).length,0);assert.equal(f.worker.store.pending().filter(e=>e.type==='finished'&&e.taskId===next.id).length,1);
  const diagnostic=c.diagnostics().runs.find(r=>r.taskId===stopped.id);assert.equal(diagnostic.uploadStopped.remoteStatus,'failed');assert.equal(diagnostic.uploadStopped.snapshotRetained,true);assert.ok(!JSON.stringify(diagnostic).includes(stopped.snapshot));
});

test('unknown task conflict retains retry state across worker recreation and transient failures do not block later uploads',async t=>{
  const f=fixture(t),first=uploading(f,'first deferred'),next=uploading(f,'second proceeds');let phase='unknown',firstPosts=0;
  const api=async(route,options)=>{if(route==='/v1/tasks/'+first.id)throw new Error('offline lookup');if(route.includes('task='+first.id)){firstPosts++;if(phase!=='recovered')throw Object.assign(new Error('temporary conflict'),{status:phase==='unknown'?409:503,retryAfterMs:8000});return {offset:first.bytes.length,complete:true};}return {offset:next.bytes.length,complete:true};};f.worker.api=api;
  await f.worker.uploads();assert.equal(f.worker.store.run(first.id).status,'uploading');assert.equal(f.worker.store.run(next.id).status,'submitted');assert.equal(fileHash(first.snapshot),first.sha);const retryKey='uploadRetry:task:'+first.id,oldRetry=f.worker.store.get(retryKey);assert.ok(oldRetry.retryAt>Date.now());
  const restarted=new Worker(f.config,f.file,async()=>({status:'submitted'}));t.after(()=>restarted.store.close());restarted.api=api;await restarted.uploads();assert.equal(firstPosts,1);assert.deepEqual(restarted.store.get(retryKey),oldRetry);
  phase='transient';restarted.store.put(retryKey,{...oldRetry,retryAt:0});await restarted.uploads();assert.equal(restarted.store.run(first.id).status,'uploading');assert.equal(restarted.store.get(retryKey).failures,2);
  phase='recovered';restarted.store.put(retryKey,{...restarted.store.get(retryKey),retryAt:0});await restarted.uploads();await restarted.uploads();assert.equal(restarted.store.run(first.id).status,'submitted');assert.equal(restarted.store.pending().filter(e=>e.type==='finished'&&e.taskId===first.id).length,1);assert.equal(fileHash(first.snapshot),first.sha);
});

test('one standalone file conflict does not block another file or automatically dispatch its follow-up',async t=>{
  const f=fixture(t),c=new FleetClient(f.config);t.after(()=>c.close());fs.writeFileSync(path.join(f.project,'one.txt'),'first');fs.writeFileSync(path.join(f.project,'two.txt'),'second');const first=await c.sendFile({id:'conflict-file',project:'workspace',relativePath:'one.txt',targetNode:uid(),prompt:'Read first'}),second=c.queueFile('workspace','two.txt',{id:'other-file'});
  f.worker.api=async(route,options)=>{if(options.body.sha===first.sha)throw Object.assign(new Error('needs admin reset'),{status:409});return {offset:second.size,complete:true};};await f.worker.uploads();assert.equal(c.fileStatus(second.id).status,'complete');assert.equal(c.fileStatus(first.id).status,'uploading');assert.ok(f.worker.store.get('uploadRetry:file:'+first.id).retryAt>Date.now());assert.equal(f.worker.store.pending().filter(e=>e.type==='assign').length,0);assert.equal(fileHash(path.join(f.data,'artifacts',first.sha)),first.sha);
});
