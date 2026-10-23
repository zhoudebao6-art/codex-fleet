import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {serveDesktopBridge,desktopInvocation} from '../src/desktop-session-bridge.mjs';
import {CodexRPC} from '../src/codex.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('inherited CLI tooling cannot claim the desktop endpoint',()=>{
 assert.equal(desktopInvocation(['app-server','--analytics-default-enabled']),true);
 for(const args of [['app-server'],['app-server','--listen','ws://127.0.0.1:0'],['app-server','--analytics-default-enabled','--listen=stdio://'],['app-server','--help'],['--remote','x','--environment-id','y']])assert.equal(desktopInvocation(args),false);
 for(const flag of ['--remote','--remote=host','--environment-id','--environment-id=x'])assert.equal(desktopInvocation(['app-server','--analytics-default-enabled',flag]),false);
});

test('Windows launcher flushes small JSON-RPC frames immediately and preserves Unicode argv',{skip:process.platform!=='win32'},async t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-launcher-test-'),exe=path.join(dir,'bridge.exe'),script=path.join(dir,'echo.mjs');
 const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 execFileSync(compiler,['/nologo','/target:exe','/r:System.Web.Extensions.dll','/out:'+exe,fileURLToPath(new URL('../scripts/DesktopBridgeLauncher.cs',import.meta.url))],{windowsHide:true});
 fs.writeFileSync(script,"import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>console.log(JSON.stringify({message:JSON.parse(l),args:process.argv.slice(3)}))).on('close',()=>process.exit(0));");
 fs.writeFileSync(path.join(dir,'launcher.json'),JSON.stringify({nodePath:process.execPath,adapterPath:script}));
 const args=['app-server','中文 空格','a"b','D:\\尾部\\'];const child=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.stdin.end();});
 const answer=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>{child.stdin.end();reject(Error('Small RPC frame was buffered'));},5000);child.stdout.on('data',b=>{data+=b;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});child.on('error',e=>{clearTimeout(timer);reject(e);});});
 child.stdin.write(JSON.stringify({id:1,method:'initialize'})+'\n');
 assert.deepEqual(await answer,{message:{id:1,method:'initialize'},args});child.stdin.end();
 await new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(Error('Launcher failed')));});
});
async function fixture(t){
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-desktop-bridge-'),backend=path.join(dir,'backend.mjs'),endpointFile=path.join(dir,'private/runtime.json');
 fs.writeFileSync(backend,`import readline from 'node:readline';let n=0;const threads=new Map();const send=m=>console.log(JSON.stringify(m));readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),p=m.params||{};let result={};if(m.method==='initialize')result={platformOs:'windows'};if(m.method==='thread/start'){const thread={id:'thread-'+ ++n,status:{type:'idle'}};threads.set(thread.id,thread);result={thread};}if(m.method==='thread/read'||m.method==='thread/resume')result={thread:threads.get(p.threadId)};if(m.method==='turn/start'){threads.get(p.threadId).status={type:'active'};threads.get(p.threadId).turns=[{id:'turn-1',status:'inProgress'}];result={turn:{id:'turn-1'}};setTimeout(()=>{send({method:'item/started',params:{threadId:p.threadId,item:{type:'commandExecution',id:'item-1'}}});send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,command:'echo test'}});},10);}if(m.method==='turn/interrupt'){threads.get(p.threadId).status={type:'idle'};send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:'turn-1',status:'interrupted'}}});}if(m.method)send({id:m.id,result});}).on('close',()=>process.exit(0));`);
 const input=new PassThrough(),output=new PassThrough(),messages=[];let buffer='';output.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
 const service=await serveDesktopBridge({command:process.execPath,args:[backend],endpointFile,input,output});
 t.after(async()=>{input.end();await service.finished;});
 input.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'desktop-test'}}})+'\n');
 for(let i=0;i<100&&!messages.length;i++)await wait(10);assert.ok(messages[0]?.result);
 const rpc=()=>new CodexRPC({desktopSessionBridge:endpointFile},null);
 return {input,messages,endpointFile,rpc,service};
}

test('desktop and Fleet share the same writer and preserve colliding request IDs; disconnect does not kill it',async t=>{
 const f=await fixture(t),a=f.rpc(),b=f.rpc();t.after(()=>Promise.all([a.close(),b.close()]));await a.start();await b.start();
 const started=await a.call('thread/start',{}),id=started.thread.id;
 f.input.write(JSON.stringify({id:1,method:'thread/resume',params:{threadId:id}})+'\n');
 for(let i=0;i<100&&!f.messages.some(m=>m.result?.thread?.id===id);i++)await wait(10);
 assert.ok(f.messages.some(m=>m.id===1&&m.result?.thread?.id===id));
 await assert.rejects(b.call('turn/start',{threadId:id}),/does not own/);
 let request;const events=[];a.on('request',m=>{request=m;});a.on('notification',m=>events.push(m));
 await a.call('turn/start',{threadId:id});for(let i=0;i<100&&!request;i++)await wait(10);
 assert.equal(request.method,'item/commandExecution/requestApproval');assert.ok(events.length);assert.ok(!f.messages.some(m=>m.method==='item/commandExecution/requestApproval'));
 await assert.rejects(b.call('thread/resume',{threadId:id}),/busy/);
 await a.call('turn/interrupt',{threadId:id,turnId:'turn-1'});await a.close();
 await wait(25);assert.ok(f.messages.some(m=>m.method==='item/commandExecution/requestApproval'));
 assert.equal((await b.call('thread/read',{threadId:id})).thread.status.type,'idle');
 assert.equal((await b.call('thread/resume',{threadId:id})).thread.id,id);
});

test('Fleet-created thread is announced to desktop even when backend omits its creation notification',async t=>{
 const f=await fixture(t),rpc=f.rpc();t.after(()=>rpc.close());await rpc.start();
 const {thread}=await rpc.call('thread/start',{});
 for(let i=0;i<100&&!f.messages.some(m=>m.method==='thread/started');i++)await wait(10);
 assert.equal(f.messages.filter(m=>m.method==='thread/started'&&m.params.thread.id===thread.id).length,1);
 assert.ok(!f.messages.some(m=>m.result?.thread?.id===thread.id),'Fleet responses must not collide with desktop request IDs');
});
test('message into a running original conversation keeps its owner and never creates or interrupts a thread',async t=>{
 const f=await fixture(t),owner=f.rpc(),sender=f.rpc();t.after(()=>Promise.all([owner.close(),sender.close()]));
 await owner.start();await sender.start();const {thread}=await owner.call('thread/start',{});
 const requests=[];owner.on('request',m=>requests.push(m));await owner.call('turn/start',{threadId:thread.id});
 const delivered=await sender.call('fleet/thread/message',{threadId:thread.id,text:'只回复我你好'});
 assert.equal(delivered.threadId,thread.id);assert.equal(delivered.delivery,'steered');
 assert.equal((await sender.call('thread/read',{threadId:thread.id})).thread.status.type,'active');
 await assert.rejects(sender.call('turn/interrupt',{threadId:thread.id,turnId:'turn-1'}),/does not own/);
 for(let i=0;i<100&&!requests.length;i++)await wait(10);assert.equal(requests.length,1);
 assert.equal(f.messages.filter(m=>m.method==='thread/started').length,1);
 await owner.call('turn/interrupt',{threadId:thread.id,turnId:'turn-1'});
 await assert.rejects(sender.call('fleet/thread/message',{threadId:thread.id,text:'stale'}),/no longer running/);
});
test('desktop streams and RPCs cannot starve each other in a constrained global HTTP pool',async t=>{
 const prior=http.globalAgent.maxSockets;http.globalAgent.maxSockets=1;t.after(()=>{http.globalAgent.maxSockets=prior;});
 const f=await fixture(t),a=f.rpc(),b=f.rpc();t.after(()=>Promise.all([a.close(),b.close()]));
 await a.start();await b.start();assert.ok((await a.call('thread/start',{},1500)).thread.id);
 assert.ok((await b.call('thread/start',{},1500)).thread.id);
});
test('bridge rejects missing credentials, browser origins and stale endpoint without spawning a fallback writer',async t=>{
 const f=await fixture(t),info=JSON.parse(fs.readFileSync(f.endpointFile,'utf8')),url='http://127.0.0.1:'+info.port;
 assert.equal((await fetch(url+'/health')).status,403);
 assert.equal((await fetch(url+'/health',{headers:{authorization:'Bearer '+info.token,origin:'https://untrusted.example'}})).status,403);
 const health=await fetch(url+'/health',{headers:{authorization:'Bearer '+info.token}});assert.equal((await health.json()).ready,true);
 const rpc=new CodexRPC({desktopSessionBridge:path.join(path.dirname(f.endpointFile),'missing.json')},null);
 await assert.rejects(rpc.start(),/后台没有另开执行器/);assert.equal(rpc.child,undefined);await rpc.close();
});

test('Windows desktop output backpressure keeps health responsive and recovers when the reader resumes',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-pipe-backpressure-'),backend=path.join(dir,'backend.mjs'),runner=path.join(dir,'runner.mjs'),endpoint=path.join(dir,'runtime.json');
 fs.writeFileSync(backend,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{ok:true}}));if(m.method==='flood')for(let i=0;i<160;i++)console.log(JSON.stringify({method:'fixture',params:{text:'x'.repeat(65536)}}));}).on('close',()=>process.exit(0));`);
 fs.writeFileSync(runner,`import {serveDesktopBridge} from ${JSON.stringify(new URL('../src/desktop-session-bridge.mjs',import.meta.url).href)};const s=await serveDesktopBridge({command:process.execPath,args:[${JSON.stringify(backend)}],endpointFile:${JSON.stringify(endpoint)}});await s.finished;`);
 const child=spawn(process.execPath,[runner],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
 t.after(async()=>{child.stdout.resume();child.stdin.end();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));});
 for(let i=0;i<200&&!fs.existsSync(endpoint);i++)await wait(10);
 const info=JSON.parse(fs.readFileSync(endpoint)),health=()=>fetch('http://127.0.0.1:'+info.port+'/health',{headers:{authorization:'Bearer '+info.token},signal:AbortSignal.timeout(1500)}).then(r=>r.json());
 child.stdin.write(JSON.stringify({id:1,method:'initialize'})+'\n');
 for(let i=0;i<100&&!(await health()).ready;i++)await wait(10);
 child.stdin.write(JSON.stringify({id:2,method:'flood'})+'\n');
 let stalled=false;for(let i=0;i<100;i++){if((await health()).desktopBackpressure){stalled=true;break;}await wait(20);}
 assert.equal(stalled,true);assert.equal((await health()).ready,false);
 child.stdout.resume();
 let recovered=false;for(let i=0;i<100;i++){if((await health()).ready){recovered=true;break;}await wait(20);}
 assert.equal(recovered,true);
});
