import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {WorkspaceCatalog} from '../src/workspace-catalog.mjs';
import {WorkspaceBindings} from '../src/workspaces.mjs';
import {LocalStore} from '../src/local-store.mjs';
import {prepareNode} from '../src/client.mjs';

function fixture(t){
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-catalog-test-'),base=path.join(dir,'base'),native=path.join(dir,'本地项目'),empty=path.join(dir,'没有对话的项目');for(const r of [base,native,empty])fs.mkdirSync(r);
  const config={nodeId:'this-node',dataDir:path.join(dir,'data'),desktopProjectBridge:false,projects:{workspace:{root:base,sandbox:'workspace-write'}}},store=new LocalStore(config.dataDir);t.after(()=>store.close());
  store.db.exec('CREATE TABLE desktop_threads(thread TEXT PRIMARY KEY,payload TEXT NOT NULL)');store.db.prepare('INSERT INTO desktop_threads VALUES(?,?)').run('native-1',JSON.stringify({threadId:'native-1',cwd:native,project:'workspace'}));
  const calls=[],registry=[{id:'registered-project',name:'已登记项目',roots:[{path:empty},{path:native.toUpperCase()},{path:path.join(dir,'removed')}]}];
  const rpc={async start(){},async close(){},async call(method,params){calls.push({method,params});if(method==='project/list')return params.cursor?{data:registry}:{data:[],nextCursor:'next'};if(method==='project/read')return {project:registry.find(p=>p.id===params.projectId)};throw Error('Unexpected RPC '+method);}};
  const catalog=new WorkspaceCatalog(config,store,{rpcFactory:()=>rpc});t.after(()=>catalog.close());return {dir,base,native,empty,config,store,calls,registry,rpc,catalog};
}
test('imports registered projects with no chats, all roots, configured roots and local thread directories; skips missing directories and deduplicates',async t=>{
  const f=fixture(t),before=JSON.stringify(f.config),result=await f.catalog.scan();assert.equal(result.entries.length,3);assert.equal(result.skipped,1);assert.equal(result.registryError,null);assert.equal(JSON.stringify(f.config),before);assert.ok(result.entries.some(e=>e.source==='registered'&&e.root===f.empty));assert.equal(result.entries.filter(e=>e.source==='registered').length,2);assert.equal(f.calls.filter(c=>c.method==='project/list').length,2);assert.ok(!f.calls.some(c=>/create|resume|start$/.test(c.method)));
});
test('old Codex registry failure falls back to valid locally observed and configured directories with an explicit partial status',async t=>{
  const f=fixture(t);f.rpc.call=async()=>{throw Object.assign(Error('Method not found'),{code:-32601});};const result=await f.catalog.scan();assert.equal(result.entries.length,2);assert.ok(result.entries.some(e=>e.source==='discovered'));await f.catalog.sync(async()=>({workspaces:[{}]}),{force:true});assert.equal(f.catalog.summary().state,'partial');assert.match(f.catalog.summary().registryError,/not found/);
});
test('disconnected upload retries the same workspace identities and disabled auto import makes no calls',async t=>{
  const f=fixture(t),sent=[];await f.catalog.sync(async(r,o)=>{sent.push(o.body.workspaces.map(w=>w.id));throw Error('offline');});assert.equal(f.catalog.summary().state,'retrying');assert.equal(f.catalog.summary().lastSuccess,undefined);
  await f.catalog.sync(async(r,o)=>{sent.push(o.body.workspaces.map(w=>w.id));return {workspaces:o.body.workspaces};},{force:true});assert.deepEqual(sent[0],sent[1]);assert.equal(f.catalog.summary().state,'synced');assert.equal(f.catalog.summary().count,3);
  f.config.workspaceAutoImport=false;await f.catalog.sync(()=>{throw Error('must not contact API');},{force:true});assert.equal(f.catalog.summary().enabled,false);
});
test('auto imported bindings become selectable without registering extra desktop projects, then task execution rechecks local provenance',async t=>{
  const f=fixture(t);let rows=[];const api=async(route,options)=>{if(route==='/v1/workspaces/sync'){rows=options.body.workspaces.map(r=>({...r,nodeId:f.config.nodeId,status:'ready',autoImported:true,updatedAt:'2026-10-20T00:00:00Z'}));return {workspaces:rows};}if(route.startsWith('/v1/workspaces?'))return {workspaces:rows};return {...rows[0],updatedAt:'2026-10-20T00:01:00Z'};};let registrations=0;
  const bindings=new WorkspaceBindings(f.config,f.store,{catalog:f.catalog,desktopProjects:{ensure:async()=>{registrations++;return {state:'registered'};}}});await bindings.sync(api);assert.equal(rows.length,3);assert.ok(rows.every(w=>bindings.cached(w.id)?.status==='ready'));assert.equal(registrations,0);
  const row=rows.find(w=>w.root===f.empty);await bindings.ensure(row.id,api);assert.equal(registrations,1);assert.ok(f.calls.some(c=>c.method==='project/read'));assert.equal(bindings.root({workspaceId:row.id,project:'workspace'}),f.empty);
  await assert.rejects(bindings.verify({...row,root:f.base}),/not a registered/);await assert.rejects(bindings.verify({...row,sourceProjectId:'forged'}),/not a registered/);await assert.rejects(bindings.verify({...row,source:'configured'}),/differs/);
  fs.rmdirSync(f.empty);await assert.rejects(bindings.verify(row),/not a registered/);
});
test('new node configuration enables auto import and reconfiguration preserves an explicit opt out',t=>{
  const f=fixture(t),file=path.join(f.dir,'node.json'),args={dataDir:f.config.dataDir,codexPath:'codex',projects:f.config.projects,name:'new-pc'};prepareNode(file,args);let cfg=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(cfg.workspaceAutoImport,true);const identity=cfg.nodeId;cfg.workspaceAutoImport=false;fs.writeFileSync(file,JSON.stringify(cfg));prepareNode(file,args);cfg=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(cfg.workspaceAutoImport,false);assert.equal(cfg.nodeId,identity);
});
