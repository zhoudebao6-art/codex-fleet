import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {accountFingerprint} from '../src/codex.mjs';
import {createHub} from '../src/hub.mjs';
import {Worker} from '../src/worker.mjs';
import {FleetClient,enroll,prepareNode} from '../src/client.mjs';
import {hash,secret,uid,mkdir,writeJson,httpRequest,sleep,within,fileHash} from '../src/common.mjs';

async function fixture(t,{limit=2}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-fleet-test-'));const adminToken=secret();const cfg={dataDir:mkdir(path.join(root,'hub')),port:0,adminTokenHash:hash(adminToken),defaultGroupLimit:limit};
 let hub=createHub(cfg);const a=await hub.listen();const url=`http://127.0.0.1:${a.port}`;cfg.port=a.port;
 const admin=new FleetClient({hubUrl:url,adminToken});const clients=[],workers=[];
 const result={root,cfg,url,admin,get hub(){return hub;},async restart(){await hub.close();hub=createHub(cfg);await hub.listen();},async node(name,group='same-account',project='demo',executor){
   const inv=await admin.api('/v1/invites',{method:'POST',body:{name,projects:[project],accountGroup:group}});const invFile=path.join(root,name+'.invite.json');writeJson(invFile,{...inv,hubUrl:url});
   const dataDir=mkdir(path.join(root,name)),projectRoot=mkdir(path.join(dataDir,'project')),configFile=path.join(dataDir,'node.json');
   await enroll(configFile,invFile,{dataDir,projects:{[project]:{root:projectRoot,sandbox:'read-only'}},codexPath:'codex'});
   const c=new FleetClient(JSON.parse(fs.readFileSync(configFile,'utf8')));clients.push(c);const w=new Worker(c.config,configFile,executor);workers.push(w);await w.tick();return {c,w,configFile,projectRoot,invFile};
 }};
 t.after(async()=>{for(const w of workers){while(w.active.size)await sleep(10);w.store.close();}for(const c of clients)c.close();admin.close();await hub.close();});return result;
}
const spec=(node,extra={})=>({id:uid(),targetNode:node.c.config.nodeId,project:'demo',prompt:'Test task',worktree:false,...extra});
const finished=async()=>({status:'submitted',summary:'fixture result',artifacts:[]});

test('pending installation retains identity and does not dispatch or contact a hub',async t=>{
 const f=await fixture(t),dataDir=mkdir(path.join(f.root,'pending')),configFile=path.join(dataDir,'node.json'),projects={demo:{root:dataDir,sandbox:'read-only'}};
 prepareNode(configFile,{dataDir,codexPath:'codex',projects,name:'waiting'});const before=JSON.parse(fs.readFileSync(configFile));
 prepareNode(configFile,{dataDir,codexPath:'codex',projects,name:'changed'});const cfg=JSON.parse(fs.readFileSync(configFile));assert.equal(cfg.nodeId,before.nodeId);assert.equal(cfg.nodeToken,before.nodeToken);
 const c=new FleetClient(cfg),w=new Worker(cfg,configFile,finished);t.after(()=>{c.close();w.store.close();});w.api=()=>{throw new Error('Pending worker contacted a hub');};
 await w.tick();await w.tick();assert.equal(c.local().connection.state,'awaiting_enrollment');assert.equal(c.local().enrollmentState,'pending');assert.equal(c.local().pending.length,0);
 await assert.rejects(c.assign({targetNode:uid(),project:'demo',prompt:'blocked'}),/awaiting a hub invitation/);assert.throws(()=>c.message(uid(),'blocked'),/awaiting a hub invitation/);assert.equal(c.local().pending.length,0);
 assert.ok(!JSON.stringify(c.local()).includes(cfg.nodeToken));
});

test('pending node completes enrollment after an interrupted response without replacing identity',async t=>{
 const f=await fixture(t),dataDir=mkdir(path.join(f.root,'pending')),configFile=path.join(dataDir,'node.json'),projects={demo:{root:dataDir,sandbox:'read-only'}};
 prepareNode(configFile,{dataDir,codexPath:'codex',projects});const before=JSON.parse(fs.readFileSync(configFile));
 const inv=await f.admin.api('/v1/invites',{method:'POST',body:{name:'ready',projects:['demo']}}),invFile=path.join(dataDir,'invite.json');writeJson(invFile,{...inv,hubUrl:f.url});
 // The hub consumes the invitation, but local confirmation fails. Retrying must recover that same node.
 await assert.rejects(enroll(configFile,invFile,{dataDir,codexPath:'codex',projects:{wrong:{root:dataDir}}}),/not permitted/);
 let cfg=JSON.parse(fs.readFileSync(configFile));assert.equal(cfg.enrollmentState,'enrolling');const blocked=new FleetClient(cfg);assert.throws(()=>blocked.api('/v1/nodes'),/awaiting/);blocked.close();
 await enroll(configFile,invFile,{dataDir,codexPath:'codex',projects});cfg=JSON.parse(fs.readFileSync(configFile));assert.equal(cfg.enrollmentState,'enrolled');assert.equal(cfg.nodeId,before.nodeId);assert.equal(cfg.nodeToken,before.nodeToken);
 const other=path.join(dataDir,'other.json');writeJson(other,{...inv,hubUrl:'http://127.0.0.1:1'});await assert.rejects(enroll(configFile,other,{dataDir,codexPath:'codex',projects}),/different hub/);
 const w=new Worker(cfg,configFile,finished);try{await w.tick();assert.ok((await f.admin.nodes()).find(n=>n.id===cfg.nodeId).lastSeen);}finally{w.store.close();}
});

test('an already-running MCP sees pending-to-enrolled configuration updates',async t=>{
 const f=await fixture(t),dataDir=mkdir(path.join(f.root,'mcp-pending')),configFile=path.join(dataDir,'node.json'),projects={demo:{root:dataDir,sandbox:'read-only'}};
 prepareNode(configFile,{dataDir,codexPath:'codex',projects});const cfg=JSON.parse(fs.readFileSync(configFile));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--config',configFile],{windowsHide:true});t.after(()=>child.kill());let buffer='',seq=0;const waiting=new Map();
 child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);waiting.get(m.id)?.(m.result);waiting.delete(m.id);}});
 const call=name=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(new Error('MCP timeout')),5000);waiting.set(id,r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}})+'\n');});
 const local=await call('fleet_local');assert.equal(JSON.parse(local.content[0].text).enrollmentState,'pending');assert.ok(!local.content[0].text.includes(cfg.nodeToken));assert.equal((await call('fleet_nodes')).isError,true);
 const inv=await f.admin.api('/v1/invites',{method:'POST',body:{name:'ready',projects:['demo']}}),invFile=path.join(dataDir,'invite.json');writeJson(invFile,{...inv,hubUrl:f.url});await enroll(configFile,invFile,{dataDir,codexPath:'codex',projects});
 assert.equal(JSON.parse((await call('fleet_local')).content[0].text).enrollmentState,'enrolled');const list=await call('fleet_nodes');assert.equal(list.isError,false);assert.equal(JSON.parse(list.content[0].text)[0].id,cfg.nodeId);child.stdin.end();await new Promise(r=>child.once('exit',r));
});

test('same-account nodes have independent IDs and can assign in both directions',async t=>{
 const f=await fixture(t),a=await f.node('A','same-account','demo',finished),b=await f.node('B','same-account','demo',finished),c=await f.node('C','different-account','demo',finished);
 assert.notEqual(a.c.config.nodeId,b.c.config.nodeId);const one=spec(b),two=spec(a),three=spec(c);
 await a.c.assign(one);await b.c.assign(two);await b.c.assign(three);
 for(let i=0;i<5;i++){await a.w.tick();await b.w.tick();await c.w.tick();await sleep(10);}
 assert.equal((await a.c.task(one.id)).status,'submitted');assert.equal((await b.c.task(two.id)).status,'submitted');assert.equal((await a.c.task(three.id)).status,'submitted');
});
test('shared account concurrency is enforced independently of node count',async t=>{
 let release;const wait=new Promise(r=>release=r);const slow=async()=>{await wait;return finished();};const f=await fixture(t,{limit:1}),a=await f.node('A','same','demo',slow),b=await f.node('B','same','demo',slow),c=await f.node('C','different','demo',slow);t.after(()=>release());
 const x=spec(a),y=spec(b),z=spec(c);for(const s of[x,y,z])await f.admin.api('/v1/tasks',{method:'POST',body:s});
 await a.w.tick();await b.w.tick();await c.w.tick();assert.equal((await f.admin.task(y.id)).status,'queued');assert.equal((await f.admin.task(z.id)).status,'claimed');release();await sleep(20);
});
test('replayed enrollment recovers the same identity; copied invitation cannot enroll another machine',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished);const cfg=a.c.config;
 await enroll(a.configFile,a.invFile,{dataDir:cfg.dataDir,projects:cfg.projects,codexPath:'codex'});
 const inv=JSON.parse(fs.readFileSync(a.invFile));await assert.rejects(httpRequest(f.url,'/v1/enroll',{method:'POST',body:{token:inv.token,nodeId:uid(),nodeToken:secret()}}),/already used/);
});
test('task idempotency rejects changed payload and replay does not duplicate execution',async t=>{
 let executions=0;const f=await fixture(t),a=await f.node('A','same','demo',async()=>{executions++;return finished();});const s=spec(a);
 await a.c.assign(s);await a.c.assign(s);for(let i=0;i<4;i++){await a.w.tick();await sleep(10);}assert.equal(executions,1);
 await assert.rejects(a.c.api('/v1/tasks',{method:'POST',body:{...s,prompt:'changed'}}),/already used/);
});
test('outbox survives hub outage and hub restart; result is eventually delivered',async t=>{
 let release;const waiting=new Promise(r=>release=r);const f=await fixture(t),a=await f.node('A','same','demo',async()=>{await waiting;return finished();});
 const s=spec(a);await a.c.assign(s);await a.w.tick();await f.hub.close();
 release();await sleep(20);await assert.rejects(a.w.tick());assert.equal(a.w.store.run(s.id).status,'uploading');
 const recovered=createHub(f.cfg);await recovered.listen(); // fixture close must target this replacement
 await a.w.tick();await a.w.tick();assert.equal((await a.c.task(s.id)).status,'submitted');await recovered.close();
 // Keep fixture-owned server closed; closing it a second time is supported by helper.
});
test('worker restart marks running attempts uncertain instead of re-executing',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished);const s=spec(a);await f.admin.api('/v1/tasks',{method:'POST',body:s});
 const sync=await a.c.api('/v1/sync',{method:'POST',body:{capabilities:a.w.capabilities(),events:[]}});const task=sync.tasks[0];a.w.store.add(task);a.w.store.update(s.id,{status:'running'});a.w.recover();await a.w.tick();
 assert.equal((await a.c.task(s.id)).status,'uncertain');assert.equal(a.w.active.size,0);
 await assert.rejects(f.admin.api(`/v1/tasks/${s.id}/resolve`,{method:'POST',body:{note:'not verified'}}),/Confirm/);
});
test('dependencies wait for explicit acceptance and access is isolated by project',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished),b=await f.node('B','different','demo',finished),other=await f.node('outside','different','other',finished);
 const first=spec(b),next=spec(b,{dependencies:[first.id]});await a.c.assign(first);await a.w.tick();await a.c.assign(next);await a.w.tick();for(let i=0;i<4;i++){await b.w.tick();await sleep(10);}
 assert.equal((await a.c.task(first.id)).status,'submitted');assert.equal((await a.c.task(next.id)).status,'queued');
 await assert.rejects(other.c.task(first.id),/denied/);await assert.rejects(b.c.accept(first.id,'self acceptance'),/creator/);
 await a.c.accept(first.id,'Verified fixture result');await b.w.tick();assert.equal((await a.c.task(next.id)).status,'claimed');await sleep(10);
});
test('cancel before execution never starts Codex',async t=>{
 let count=0;const f=await fixture(t),a=await f.node('A','same','demo',async()=>{count++;return finished();});const s=spec(a);await f.admin.api('/v1/tasks',{method:'POST',body:s});await f.admin.cancel(s.id);await a.w.tick();assert.equal(count,0);assert.equal((await f.admin.task(s.id)).status,'cancelled');
});
test('chunked artifact upload resumes and verifies SHA256 before download',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished);const s=spec(a);await f.admin.api('/v1/tasks',{method:'POST',body:s});
 const bytes=Buffer.from('resumable-artifact-数据'),sha=hash(bytes),route=`/v1/artifacts/${sha}?task=${s.id}`;
 assert.equal((await a.c.api(route,{method:'POST',body:{size:bytes.length,name:'result.txt'}})).offset,0);
 await a.c.api(route+'&offset=0',{method:'PUT',body:bytes.subarray(0,7)});await f.restart();
 assert.equal((await a.c.api(route,{method:'POST',body:{size:bytes.length,name:'result.txt'}})).offset,7);
 await a.c.api(route+'&offset=7',{method:'PUT',body:bytes.subarray(7)});const got=await httpRequest(f.url,route,{token:a.c.config.nodeToken,raw:true});assert.deepEqual(got,bytes);
});
test('invalid auth, remote plaintext, and escaping output paths fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(httpRequest(f.url,'/v1/nodes',{token:'incorrect'}),/token/);
 await assert.rejects(async()=>httpRequest('http://192.168.0.1:43127','/health'),/HTTPS/);
 assert.throws(()=>within(f.root,'../secret'),/escapes/);
});

test('same account fingerprint overrides differing labels and uses the strictest group limit',async t=>{
 let release;const waiting=new Promise(r=>release=r),slow=async()=>{await waiting;return finished();};const f=await fixture(t),a=await f.node('A','strict','demo',slow),b=await f.node('B','loose','demo',slow);f.cfg.groupLimits={strict:1,loose:3};
 const salt='test-salt',fp=accountFingerprint({type:'chatgpt',email:' USER@example.test '},salt);assert.equal(fp,accountFingerprint({type:'chatgpt',email:'user@example.test'},salt));
 a.w.inspection={ready:true,accountFingerprint:fp};b.w.inspection={ready:true,accountFingerprint:fp};await a.w.tick();await b.w.tick();
 const x=spec(a),y=spec(b);await f.admin.assign(x);await f.admin.assign(y);await a.w.tick();await b.w.tick();
 try{assert.equal((await f.admin.task(y.id)).status,'queued');}finally{release();await sleep(20);}
});

test('account switch keeps node identity and queue, refuses work while logged out and resumes only after new account inspection',async t=>{
 const f=await fixture(t),a=await f.node('A','one','demo',finished);
 const identity=a.c.config.nodeId,token=a.c.config.nodeToken;
 a.w.inspection={ready:false,accountFingerprint:null};await a.w.tick();
 const s=spec(a);await f.admin.assign(s);await a.w.tick();assert.equal((await f.admin.task(s.id)).status,'queued');
 const next=accountFingerprint({type:'chatgpt',email:'next@example.test'},'salt');
 a.w.inspection={ready:true,accountFingerprint:next};await a.w.tick();
 for(let i=0;i<20&&(await f.admin.task(s.id)).status!=='submitted';i++){await sleep(20);await a.w.tick();}
 assert.equal(a.c.config.nodeId,identity);assert.equal(a.c.config.nodeToken,token);assert.equal((await f.admin.task(s.id)).status,'submitted');
});

test('offline task queue survives a new client and worker restart without losing its id',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished),b=await f.node('B','other','demo',finished);await a.c.nodes();await f.hub.close();
 const assigned=await a.c.assign({target:'B',project:'demo',prompt:'Offline queued task',worktree:false});
 const c=new FleetClient(a.c.config);assert.equal(c.local().pending[0].taskId,assigned.taskId);c.close();
 await f.restart();for(let i=0;i<4;i++){await a.w.tick();await b.w.tick();await sleep(10);}assert.equal((await a.c.task(assigned.taskId)).status,'submitted');
});

test('binary downloads resume by range and corrupted upload can restart cleanly',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished);const s=spec(a);await f.admin.assign(s);
 const bytes=Buffer.alloc(2*1024*1024+17);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;const sha=hash(bytes),route=`/v1/artifacts/${sha}?task=${s.id}`;
 await a.c.api(route,{method:'POST',body:{size:bytes.length,name:'binary.zip'}});
 for(let i=0;i<bytes.length;i+=1024*1024)await a.c.api(route+'&offset='+i,{method:'PUT',body:bytes.subarray(i,i+1024*1024)});
 const out=path.join(a.projectRoot,'result.zip');fs.writeFileSync(out+'.'+sha+'.partial',bytes.subarray(0,1937));await a.c.download(s.id,sha,out);assert.equal(fileHash(out),sha);
 const good=Buffer.from('good'),badSha=hash(good),r=`/v1/artifacts/${badSha}?task=${s.id}`;await a.c.api(r,{method:'POST',body:{size:4,name:'data.txt'}});
 await assert.rejects(a.c.api(r+'&offset=0',{method:'PUT',body:Buffer.from('bad!')}),/quarantined/);
 assert.equal((await a.c.api(r,{method:'POST',body:{size:4,name:'data.txt'}})).offset,0);await a.c.api(r+'&offset=0',{method:'PUT',body:good});
});

test('workflow stages wait for acceptance, summarize roles and store only scoped source-linked knowledge',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished),b=await f.node('B','other','demo',finished),outsider=await f.node('outside','other','private',finished);const id='flow-'+uid();
 await a.c.workflow({id,project:'demo',steps:[{key:'develop',target:'B',prompt:'Build',role:'developer',acceptance:'Tests pass',worktree:false},{key:'review',target:'B',prompt:'Review source task '+id+'-develop',role:'reviewer',dependsOn:['develop'],worktree:false}]});
 for(let i=0;i<4;i++){await a.w.tick();await b.w.tick();await sleep(10);}
 assert.equal((await a.c.task(id+'-review')).status,'queued');const note={project:'demo',key:'decision',body:'Use verified version',sourceTask:id+'-develop'};
 await assert.rejects(a.c.publishKnowledge(note),/accepted/);await a.c.accept(id+'-develop','Verified test fixture');await a.c.publishKnowledge(note);await a.c.publishKnowledge({...note,body:'Updated verified version'});
 const entries=await a.c.knowledge('demo','verified');assert.equal(entries.length,1);assert.equal(entries[0].version,2);assert.equal(entries[0].source_task,id+'-develop');await assert.rejects(outsider.c.knowledge('demo'),/denied/);
 await b.w.tick();await sleep(10);await b.w.tick();assert.equal((await a.c.summary()).tasks.find(x=>x.id===id+'-review').role,'reviewer');
});

test('existing symlink ancestors cannot receive downloaded artifacts outside the project',async t=>{
 const f=await fixture(t),project=mkdir(path.join(f.root,'bounded')),outside=mkdir(path.join(f.root,'outside'));
 fs.symlinkSync(outside,path.join(project,'escape'),process.platform==='win32'?'junction':'dir');assert.throws(()=>within(project,'escape/new.txt'),/Symlink escapes/);assert.throws(()=>within(project,'file:stream'),/Invalid/);
});

test('MCP stdio discovers tools and durably queues a real hub assignment',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished);const s=spec(a);const messages=[{id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'fleet_assign',arguments:s}}];
 const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--config',a.configFile],{windowsHide:true});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code?reject(new Error(err)):resolve(out.trim().split('\n').map(JSON.parse)));p.stdin.end(messages.map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');});
 assert.equal(result[0].result.serverInfo.name,'codex-fleet');assert.ok(result[1].result.tools.some(x=>x.name==='fleet_workflow'));assert.equal(result[2].result.isError,false);for(let i=0;i<4;i++){await a.w.tick();await sleep(10);}assert.equal((await a.c.task(s.id)).status,'submitted');
});

test('message delivery receipts suppress repeated injection during an active turn',async t=>{
 const seen=[];let release;const hold=new Promise(r=>release=r);const executor=async(c,p,r,h)=>{h.onReady({message:async text=>seen.push(text),cancel:async()=>release()});await hold;return finished();};
 const f=await fixture(t),a=await f.node('A','same','demo',executor);const s=spec(a);await f.admin.assign(s);
 try{await a.w.tick();a.c.message(s.id,'one authorized instruction');await a.w.tick();await a.w.tick();assert.deepEqual(seen,['one authorized instruction']);assert.equal(a.w.store.db.prepare('SELECT state FROM delivery WHERE task=?').get(s.id).state,'delivered');}finally{release();await sleep(20);}
});

test('knowing an artifact hash does not grant cross-project file access',async t=>{
 const f=await fixture(t),a=await f.node('A','same','demo',finished),b=await f.node('B','other','private',finished);const x=spec(a),y=spec(b,{project:'private'});await f.admin.assign(x);await f.admin.assign(y);
 const data=Buffer.from('project-specific-result'),sha=hash(data),ra=`/v1/artifacts/${sha}?task=${x.id}`,rb=`/v1/artifacts/${sha}?task=${y.id}`;
 await a.c.api(ra,{method:'POST',body:{size:data.length,name:'private.txt'}});await a.c.api(ra+'&offset=0',{method:'PUT',body:data});
 assert.equal((await b.c.api(rb,{method:'POST',body:{size:data.length,name:'guessed.txt'}})).complete,false);await assert.rejects(b.c.api(rb),/unavailable/);
});
