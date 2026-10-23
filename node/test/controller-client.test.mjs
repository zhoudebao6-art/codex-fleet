import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FleetClient} from '../src/client.mjs';

function fixture(){const requests=[],client=new FleetClient({});client.nodes=async()=>[{id:'node-2',name:'PC-02'},{id:'node-3',name:'PC-03'}];client.api=async(route,options)=>{requests.push({route,options});return {id:options?.body?.id,status:'pending'};};return {client,requests};}

test('ordinary conversations use direct delivery and preserve exact original-thread messages',async()=>{
  const {client,requests}=fixture();client.requireEnrollment=()=>{};
  await client.startConversation({id:'hello-on-desktop',target:'PC-02',project:'workspace',workspaceId:'actual-project',prompt:'只回复我你好'});
  const body=requests[0].options.body;assert.equal(body.intent,'conversation');assert.equal(body.prompt,'只回复我你好');assert.equal(body.requireDesktop,true);assert.equal(body.worktree,false);assert.equal(body.workspaceId,'actual-project');assert.equal(body.parentId,undefined);
  await client.desktopMessage({id:'message-on-original',target:'PC-02',threadId:'original-thread',prompt:'继续'});
  assert.equal(requests[1].route,'/v1/desktop/threads/node-2/original-thread/message');assert.deepEqual(requests[1].options.body,{id:'message-on-original',prompt:'继续'});client.close();
});
test('parallel controller retains branch inputs, dependencies, desktop requirement and collection outputs',async()=>{
  const {client,requests}=fixture();await client.createAutomation({id:'parallel-complete',name:'三机联动',project:'workspace',executionMode:'parallel',steps:[
    {key:'first',name:'制作',target:'PC-02',prompt:'制作',inputs:[{sha:'a'.repeat(64),size:1,name:'input.txt'}],outputs:['out.zip']},
    {key:'collect',name:'汇总',target:'PC-03',prompt:'汇总',dependsOn:['first'],outputs:['all.zip']}
  ]});const body=requests[0].options.body;assert.equal(body.executionMode,'parallel');assert.equal(body.steps[0].inputs[0].name,'input.txt');assert.equal(body.steps[0].requireDesktop,true);assert.deepEqual(body.steps[1].dependsOn,['first']);assert.deepEqual(body.steps[1].outputs,['all.zip']);client.close();
});
test('file handoff retains workspace, expected output and local execution policy',async()=>{
  const {client}=fixture();client.requireEnrollment=()=>{};let saved;
  client.queueFile=(project,relativePath,options)=>{saved=options.followup;return {id:options.id,status:'queued'};};
  await client.sendFile({id:'handoff-output',project:'workspace',relativePath:'raw.zip',target:'PC-02',prompt:'process',workspaceId:'real-project',outputs:['delivery.zip'],executionPolicy:'local',worktree:false});
  assert.equal(saved.workspaceId,'real-project');assert.deepEqual(saved.outputs,['delivery.zip']);assert.equal(saved.executionPolicy,'local');assert.equal(saved.worktree,false);assert.equal(saved.requireDesktop,true);client.close();
});

test('project discovery and registration resolve device codes without permitting arbitrary paths',async()=>{
  const {client,requests}=fixture();await client.projects({target:'pc-02'});assert.equal(requests[0].route,'/v1/workspaces?nodeId=node-2');
  const input={id:'project-stable',target:'PC-03',name:'共享项目',project:'workspace',sourceThreadId:'native-thread'};await client.createProject(input);assert.deepEqual(requests[1].options.body,{id:'project-stable',nodeId:'node-3',name:'共享项目',project:'workspace',sourceThreadId:'native-thread'});
  await assert.rejects(client.createProject({...input,root:'C:\\private'}),/observed|directory/);await assert.rejects(client.createProject({...input,path:'C:\\private'}),/observed|directory/);await assert.rejects(client.createProject({...input,id:undefined}),/stable/);assert.equal(requests.length,2);client.close();
});

test('automation retry preserves one stable declaration and target policies while rejecting unsafe shape',async()=>{
  const {client,requests}=fixture();const input={id:'review-flow',name:'实现与审查',project:'workspace',steps:[{name:'实现',target:'PC-02',prompt:'Implement the agreed change',workspaceId:'bound-project',outputs:['results/code.txt']},{name:'只读审查',target:'PC-03',prompt:'Read and review prior output',mode:'question'}]};
  const snapshot=JSON.stringify(input);await client.createAutomation(input);await client.createAutomation(input);assert.equal(requests[0].route,'/v1/automations');assert.deepEqual(requests[0],requests[1]);assert.equal(JSON.stringify(input),snapshot);
  const steps=requests[0].options.body.steps;assert.equal(steps[0].targetNode,'node-2');assert.equal(steps[0].executionPolicy,'local');assert.equal(steps[0].workspaceId,'bound-project');assert.equal(steps[1].mode,'question');assert.equal(steps[1].executionPolicy,'project');assert.ok(steps.every(s=>!Object.hasOwn(s,'target')));
  await assert.rejects(client.createAutomation({...input,id:undefined}),/stable/);await assert.rejects(client.createAutomation({...input,steps:[input.steps[0]]}),/2-12/);await assert.rejects(client.createAutomation({...input,steps:input.steps.map(s=>({...s,key:'same'}))}),/repeated/);await assert.rejects(client.createAutomation({...input,steps:[{...input.steps[0],inputs:[{name:'not-verified'}]},input.steps[1]]}),/preceding/);assert.equal(requests.length,2);client.close();
});

test('automation list details and control use distinct read and mutation routes',async()=>{
  const {client,requests}=fixture();await client.automations({status:'needs_attention',limit:20});assert.equal(requests[0].route,'/v1/automations?limit=20&status=needs_attention');await client.automations({id:'flow-1'});assert.equal(requests[1].route,'/v1/automations/flow-1');await client.controlAutomation('flow-1','pause');assert.deepEqual(requests[2],{route:'/v1/automations/flow-1/pause',options:{method:'POST',body:{}}});assert.throws(()=>client.controlAutomation('flow-1','retry'),/pause, resume or cancel/);assert.throws(()=>client.automations({limit:201}),/1-200/);client.close();
});

async function mcp(t,readOnly,messages){
  const root=fs.mkdtempSync('D:\\codex+\\temp\\fleet-controller-test-'),config=path.join(root,'node.json');fs.writeFileSync(config,JSON.stringify({enrollmentState:'pending',projects:{workspace:{root}}}));
  t.after(()=>{if(fs.realpathSync(root).toLowerCase().startsWith('d:\\codex+\\temp\\fleet-controller-test-'))fs.rmSync(root,{recursive:true,force:true});});
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--config',config,...(readOnly?['--read-only']:[])],{windowsHide:true,env:{...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp'}});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>code?reject(Error(err)):resolve(out.trim().split('\n').map(JSON.parse)));child.stdin.end(messages.map((m,index)=>JSON.stringify({jsonrpc:'2.0',id:index+1,...m})).join('\n')+'\n');});
}
test('question MCP exposes project and automation reads while hiding and rejecting their writes',async t=>{
  const writes=['fleet_project_create','fleet_automation_create','fleet_automation_control'];const output=await mcp(t,true,[{method:'tools/list'},...writes.map(name=>({method:'tools/call',params:{name,arguments:{}}}))]);const names=output[0].result.tools.map(x=>x.name);assert.ok(names.includes('fleet_projects'));assert.ok(names.includes('fleet_automations'));assert.ok(writes.every(name=>!names.includes(name)));for(const row of output.slice(1)){assert.equal(row.result.isError,true);assert.match(row.result.content[0].text,/read-only/);}
  const normal=await mcp(t,false,[{method:'tools/list'}]),tools=normal[0].result.tools;assert.ok(writes.every(name=>tools.some(t=>t.name===name)));assert.deepEqual(tools.find(t=>t.name==='fleet_assign').inputSchema.properties.executionPolicy.enum,['project','local']);
});
