import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeliveryController} from '../src/delivery-controller.mjs';
import {LocalStore} from '../src/local-store.mjs';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.TEMP||os.tmpdir(),'fleet-delivery-test-'));
 const store=new LocalStore(path.join(root,'state')),calls=[];
 const worker={config:{nodeId:'master',hubUrl:'https://fleet.example.test',enrollmentState:'enrolled',projects:{workspace:{root}},dataDir:path.join(root,'state')},store,clean:String,stopping:false,api:async(route,options)=>{calls.push({route,...options});return {enabled:true,operations:[]};}};
 const controller=new DeliveryController(worker);
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,store,worker,controller,calls};
}
test('collection retries preserve verified outputs and acknowledgement identity',async t=>{
 const f=fixture(t),bytes=Buffer.from('actual bytes'),sha=digest(bytes);
 const op={kind:'collect',batchId:'one',project:'workspace',name:'test',mode:'production',files:[{name:'delivery/one/produce/item-1/attempt-0/delivery.zip',sha,size:bytes.length,taskId:'task'}]};
 let downloaded=0;
 f.controller.client.download=async(task,h,out)=>{assert.equal(h,sha);downloaded++;fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes);};
 await f.controller.collect(op);await f.controller.collect(op);
 assert.equal(downloaded,1);assert.deepEqual(f.calls[0].body,f.calls[1].body);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'deliveries/one/collection.json'))).files,f.calls[0].body.files);
 fs.writeFileSync(path.join(f.root,'deliveries/one',op.files[0].name),'tampered');
 await assert.rejects(()=>f.controller.collect(op),/preserved/);assert.equal(f.calls.length,2);
});
test('controller never writes outside batch root or acknowledges missing artifacts',async t=>{
 const f=fixture(t);
 await assert.rejects(()=>f.controller.download({batchId:'safe',project:'workspace'},{name:'../outside',size:1,sha:'a'.repeat(64)}));
 await assert.rejects(()=>f.controller.inspect({batchId:'safe',project:'workspace',artifacts:[]}),/Missing/);
 assert.equal(f.calls.length,0);
 f.worker.stopping=true;
 await assert.rejects(()=>f.controller.collect({batchId:'safe',project:'workspace',files:[{name:'a',size:1,sha:'a'.repeat(64)}]}),/stopping/);
});
test('one transfer failure does not starve other batches and backoff survives controller restart',async t=>{
 const f=fixture(t),ops=[{kind:'inspect',batchId:'bad',jobId:'one'},{kind:'collect',batchId:'good'}],seen=[];
 f.worker.api=async(route,options)=>{f.calls.push({route,...options});return route.endsWith('/tick')?{enabled:true,operations:ops}:{ok:true};};
 f.controller.inspect=async()=>{seen.push('bad');throw new Error('temporary network failure');};
 f.controller.collect=async()=>seen.push('good');
 await f.controller.tick();assert.deepEqual(seen,['bad','good']);
 const restarted=new DeliveryController(f.worker);restarted.inspect=f.controller.inspect;restarted.collect=f.controller.collect;
 await restarted.tick();assert.deepEqual(seen,['bad','good','good']);
 assert.ok(f.store.get('deliveryOperationRetries')['bad:inspect:one'].retryAt>Date.now());
});
test('restarting during baseline preserves frozen GitHub revision and durable transfer IDs',async t=>{
 const f=fixture(t),op={batchId:'frozen',project:'workspace',profile:{repository:'zhoudebao6-art/software-case-batch'}},commit='a'.repeat(40),bytes=Buffer.from('archive');
 const requested=[];
 const github=async(route,binary)=>{requested.push(route);if(route.endsWith('/main'))return {object:{sha:commit}};if(route.includes('/trees/'))return {tree:[{type:'blob',path:'SKILL.md',mode:'100644',sha:'b'.repeat(40),size:1}]};return bytes;};
 f.controller.github=github;
 f.controller.exec=async(_,args)=>{const file=args[args.indexOf('-Manifest')+1];const value=JSON.parse(fs.readFileSync(file));value.archiveVerified=true;value.archiveSha256=digest(bytes);value.files[0].sha256='c'.repeat(64);fs.writeFileSync(file,JSON.stringify(value));};
 await f.controller.baseline(op);
 const next=new DeliveryController(f.worker);next.github=github;next.exec=f.controller.exec;
 for(const x of f.store.transfers())f.store.transferProgress(x.id,'complete',x.size);
 await next.baseline(op); // queues second transfer only after first is complete
 for(const x of f.store.transfers())f.store.transferProgress(x.id,'complete',x.size);
 await next.baseline(op);
 assert.equal(requested.filter(x=>x.endsWith('/main')).length,1);
 assert.equal(f.calls.at(-1).body.baseline.commit,commit);
 assert.equal(f.store.transfers().length,2);
});
test('Windows PowerShell verifies real nested GitHub-style ZIP files and rejects changed source', {skip:process.platform!=='win32'}, t=>{
 const f=fixture(t),source=path.join(f.root,'snapshot'),archive=path.join(f.root,'source.zip'),manifest=path.join(f.root,'manifest.json');
 const files=[['SKILL.md','source instruction'],['references/材料.md','原始定义']];
 const entries=files.map(([name,content])=>{
  const bytes=Buffer.from(content),file=path.join(source,'repo-commit',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  return {path:name,size:bytes.length,gitBlob:crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')};
 });
 const quote=v=>"'"+v.replaceAll("'","''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $sourceDir=${quote(source)}; $z=[IO.Compression.ZipFile]::Open(${quote(archive)},'Create'); try { Get-ChildItem -LiteralPath $sourceDir -File -Recurse | ForEach-Object { $entryName=$_.FullName.Substring($sourceDir.Length+1).Replace('\\','/'); $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$_.FullName,$entryName) } } finally { $z.Dispose() }`],{windowsHide:true,timeout:15000,stdio:'pipe'});
 fs.writeFileSync(manifest,JSON.stringify({commit:'a'.repeat(40),files:entries}));
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/Verify-SkillArchive.ps1',import.meta.url)),'-Archive',archive,'-Manifest',manifest];
 execFileSync('powershell.exe',args,{windowsHide:true,timeout:15000,stdio:'pipe'});
 const verified=JSON.parse(fs.readFileSync(manifest));assert.equal(verified.archiveVerified,true);assert.equal(verified.archiveSha256,digest(fs.readFileSync(archive)));
 assert.equal(verified.files[1].sha256,digest(Buffer.from(files[1][1])));
 verified.files[0].gitBlob='b'.repeat(40);fs.writeFileSync(manifest,JSON.stringify(verified));
 assert.throws(()=>execFileSync('powershell.exe',args,{windowsHide:true,timeout:15000,stdio:'pipe'}));
});
