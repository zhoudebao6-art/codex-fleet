import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DesktopProjects} from '../src/desktop-projects.mjs';
import {WorkspaceBindings} from '../src/workspaces.mjs';
import {LocalStore} from '../src/local-store.mjs';
import {CodexRPC,runCodex} from '../src/codex.mjs';

function fixture(t){
  const dir=fs.mkdtempSync('D:/codex+/temp/fleet-desktop-project-test-'),root=path.join(dir,'workspace');fs.mkdirSync(root);
  const config={nodeId:'this-node',desktopProjectBridge:false,dataDir:path.join(dir,'data'),projects:{workspace:{root}}},store=new LocalStore(config.dataDir);t.after(()=>store.close());
  const workspaces=new WorkspaceBindings(config,store),calls=[],registry=[];
  const rpc={async start(){calls.push({method:'initialize'});return this;},async call(method,params){calls.push({method,params});if(method==='project/list')return {data:registry,nextCursor:null};if(method==='project/create'){const project={id:'internal-project-id',name:params.name,roots:params.roots};registry.push(project);return {project};}if(method==='project/read')return {project:registry.find(p=>p.id===params.projectId)};throw new Error('unexpected '+method);},async close(){}};
  const bridge=new DesktopProjects(config,store,{rpcFactory:()=>rpc});return {dir,root,config,store,workspaces,calls,registry,rpc,bridge,verify:(id='selected')=>workspaces.verify({id,nodeId:config.nodeId,project:'workspace',source:'created',name:'网站选定项目'})};
}

test('only a verified website workspace is registered and receives the actual internal project identity',async t=>{
  const f=fixture(t),binding=await f.verify();const result=await f.bridge.ensure(binding);assert.equal(result.state,'registered');assert.equal(result.projectId,'internal-project-id');assert.equal(result.visibility,'not_verified');
  const create=f.calls.find(c=>c.method==='project/create').params;assert.deepEqual(create.roots,[{path:fs.realpathSync(binding.root)}]);assert.equal(create.metadata.fleetWorkspaceId,binding.id);assert.match(create.idempotencyKey,/^fleet-[a-f0-9]{64}$/);assert.ok(f.calls.some(c=>c.method==='project/read'));
  await f.bridge.ensure(binding);await f.bridge.ensure(binding,{force:true});assert.equal(f.calls.filter(c=>c.method==='project/create').length,1);assert.ok(!f.calls.some(c=>/import|resume/.test(c.method)));
});

test('canonical directory mapping reuses a paginated Codex project rather than using the desktop tool UI id',async t=>{
  const f=fixture(t),binding=await f.verify(),project={id:'internal-not-ui-id',name:'Existing',roots:[{path:binding.root.toUpperCase()}]};let pages=0;const original=f.rpc.call;
  f.rpc.call=async(method,params)=>{if(method==='project/list'){pages++;return params.cursor?{data:[project],nextCursor:null}:{data:[],nextCursor:'next-page'};}if(method==='project/read')return {project};return original(method,params);};
  const result=await f.bridge.ensure(binding);assert.equal(result.projectId,'internal-not-ui-id');assert.equal(pages,2);assert.equal(f.calls.filter(c=>c.method==='project/create').length,0);
});

test('foreign, unselected and forged-source workspaces cannot call the registration API',async t=>{
  const f=fixture(t),binding=await f.verify();await assert.rejects(f.bridge.ensure({...binding,nodeId:'another'}),/verified workspace/);await assert.rejects(f.bridge.ensure({...binding,id:'not-selected'}),/saved website/);await assert.rejects(f.bridge.ensure({...binding,root:f.root,realRoot:f.root}),/changed since verification/);
  const discovered={...binding,id:'discovered',source:'discovered',sourceThreadId:'actual-source'};f.store.put('workspace:discovered',discovered);await assert.rejects(f.bridge.ensure({...discovered,sourceThreadId:'fabricated'}),/verified local source/);assert.equal(f.calls.length,0);
});

test('additional project folders and mismatched server paths never expand the selected workspace',async t=>{
  const f=fixture(t),binding=await f.verify();f.registry.push({id:'multi',name:'Existing',roots:[{path:binding.root},{path:f.root}]});const result=await f.bridge.ensure(binding);assert.equal(result.state,'error');assert.match(result.error,/additional folders/);assert.equal(f.calls.filter(c=>c.method==='project/create').length,0);
  f.registry.length=0;f.rpc.call=async(method)=>method==='project/list'?{data:[]}:{project:{id:'wrong',roots:[{path:f.root}]}};const wrong=await f.bridge.ensure(binding,{force:true});assert.equal(wrong.state,'error');assert.match(wrong.error,/different project directory/);
});

test('unsupported RPC and interrupted registration report explicit state; a retry reuses one idempotency key',async t=>{
  const f=fixture(t),binding=await f.verify();f.rpc.call=async()=>{throw Object.assign(new Error('Method not found'),{code:-32601});};const unsupported=await f.bridge.ensure(binding);assert.equal(unsupported.state,'unsupported');assert.equal(unsupported.projectId,undefined);assert.equal(unsupported.visibility,'not_verified');
  const keys=[];let created=false;f.rpc.call=async(method,params)=>{if(method==='project/list')return {data:[]};if(method==='project/create'){keys.push(params.idempotencyKey);if(!created){created=true;throw new Error('connection lost after create');}return {project:{id:'durable-id',name:'Project',roots:[{path:binding.root}]}};}return {project:{id:'durable-id',name:'Project',roots:[{path:binding.root}]}};};
  assert.equal((await f.bridge.ensure(binding,{force:true})).state,'error');assert.equal((await f.bridge.ensure(binding,{force:true})).state,'registered');assert.equal(keys[0],keys[1]);
});

test('continuation workspace verification never creates an additional desktop project',async t=>{
  const f=fixture(t),row={id:'continued',nodeId:f.config.nodeId,project:'workspace',source:'created',name:'Continue',status:'ready',updatedAt:'2026-10-19T00:00:00Z'};let called=0;
  const bindings=new WorkspaceBindings(f.config,f.store,{desktopProjects:{async ensure(){called++;throw new Error('Must not register during continuation');}}});const result=await bindings.ensure(row.id,async()=>({workspaces:[row]}),{registerDesktop:false});assert.equal(result.status,'ready');assert.equal(called,0);
});

test('auto imported multi-root project retains its actual Codex identity without creating a replacement',async t=>{
  const f=fixture(t),original=await f.verify(),binding={...original,source:'registered',sourceProjectId:'native-project',autoImported:true};f.store.put('workspace:'+binding.id,binding);f.registry.push({id:'native-project',name:'已有多目录项目',roots:[{path:binding.root},{path:f.root}]});
  const result=await f.bridge.ensure(binding);assert.equal(result.state,'registered');assert.equal(result.projectId,'native-project');assert.ok(!f.calls.some(c=>c.method==='project/create'));assert.equal(f.calls.filter(c=>c.method==='project/read').length,1);
  f.registry[0].roots=[{path:f.root}];const removed=await f.bridge.ensure(binding,{force:true});assert.equal(removed.state,'error');assert.match(removed.error,/no longer contains/);
});

function fakeExecution(t,projectId='internal-project'){
  const calls=[];t.mock.method(CodexRPC.prototype,'start',async function(){calls.push({method:'initialize',experimentalApi:this.config.fleetExperimentalApi});return this;});t.mock.method(CodexRPC.prototype,'close',async()=>{});
  t.mock.method(CodexRPC.prototype,'call',async function(method,params){calls.push({method,params});if(method==='thread/start'||method==='thread/resume')return {thread:{id:'fleet-thread',projectId},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};if(method==='thread/read')return {thread:{id:'fleet-thread',projectId}};if(method==='turn/start'){queueMicrotask(()=>this.emit('notification',{method:'turn/completed',params:{threadId:'fleet-thread',turn:{id:'turn',status:'completed'}}}));return {turn:{id:'turn'}};}return {};});return calls;
}
const run={task:'task-id',cwd:'D:\\selected',sandbox:'read-only',spec:{mode:'question',prompt:'检查导出结果\n较长细节',project:'workspace'},desktopProject:{state:'registered',projectId:'internal-project'},context:{name:'已选项目'}};

test('new Fleet thread uses the verified internal project id, readable title and official deep link without resuming native threads',async t=>{
  const calls=fakeExecution(t),events=[],result=await runCodex({},null,run,{onProgress:e=>events.push(e)});assert.equal(calls.find(c=>c.method==='thread/start').params.projectId,'internal-project');assert.equal(calls.find(c=>c.method==='initialize').experimentalApi,true);assert.equal(calls.find(c=>c.method==='thread/start').params.sandbox,'read-only');assert.equal(calls.find(c=>c.method==='thread/name/set').params.name,'Fleet · 已选项目 · 检查导出结果');assert.ok(!calls.some(c=>c.method==='thread/resume'));assert.equal(result.desktop.deepLink,'codex://threads/fleet-thread');assert.equal(result.desktop.visibility,'not_verified');assert.ok(events.some(e=>e.kind==='desktop_thread'&&e.state==='project_linked'));
});

test('continuation resumes only its Fleet thread and does not rename or reassign the project',async t=>{
  const calls=fakeExecution(t);await runCodex({},null,{...run,resumeThreadId:'fleet-thread'});assert.equal(calls.find(c=>c.method==='thread/resume').params.projectId,undefined);assert.ok(!calls.some(c=>['thread/start','thread/name/set','project/create'].includes(c.method)));assert.equal(calls.find(c=>c.method==='thread/resume').params.threadId,'fleet-thread');
});

test('unverified project association blocks a turn instead of falsely claiming desktop integration',async t=>{
  const calls=fakeExecution(t,'wrong-project');await assert.rejects(runCodex({},null,run),/association could not be verified/);assert.ok(!calls.some(c=>c.method==='turn/start'));
});
