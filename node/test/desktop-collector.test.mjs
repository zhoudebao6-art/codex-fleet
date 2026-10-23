import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DesktopCollector,DESKTOP_SOURCES,publicDesktopItem,summarizeDesktopThread,desktopText} from '../src/desktop-collector.mjs';
import {LocalStore} from '../src/local-store.mjs';
import {FleetClient} from '../src/client.mjs';

const root=path.join(process.env.TEMP||'D:/codex+/temp','fleet-desktop-tests');fs.mkdirSync(root,{recursive:true});
const stamp=Date.parse('2026-10-19T06:00:00Z');
const thread=(id,updated=stamp/1000)=>({id,name:'任务 '+id,preview:'改进页面',cwd:'D:/project/'+id,source:'vscode',createdAt:updated-300,updatedAt:updated,status:{type:'notLoaded'}});
function fixture(t){const dir=fs.mkdtempSync(path.join(root,'case-')),store=new LocalStore(dir);t.after(()=>store.close());return {store,config:{dataDir:dir,projects:{workspace:{root:'D:/CodexFleet/workspace'}},nodeToken:'known-sensitive-token'}};}

test('public items omit reasoning, shell arguments/output, hidden phase and credentials',()=>{
  assert.equal(publicDesktopItem({item:{type:'agentMessage',text:'Missing stable identity'}}),null);
  assert.equal(publicDesktopItem({item:{type:'reasoning',summary:['private']}}),null);
  assert.equal(publicDesktopItem({item:{type:'agentMessage',phase:'analysis',text:'private'}}),null);
  const v=publicDesktopItem({turnId:'turn',item:{id:'cmd',type:'commandExecution',command:'secret command',aggregatedOutput:'private output',status:'completed',exitCode:0},completedAtMs:stamp});
  assert.deepEqual(Object.keys(v).sort(),['at','exitCode','id','status','tool','toolType','turnId','type'].sort());
  assert.ok(!JSON.stringify(v).includes('secret command'));
  assert.ok(!JSON.stringify(v).includes('private output'));
  const text=desktopText('hello known-sensitive-token password=guess access_token=private https://example.com/#device-ticket=abcd',{nodeToken:'known-sensitive-token'});
  assert.ok(!text.includes('known-sensitive-token'));assert.ok(!text.includes('guess'));assert.ok(!text.includes('private'));
});

test('metadata refresh cannot make an old running observation look current',()=>{
  const old=summarizeDesktopThread({...thread('x'),status:{type:'active',activeFlags:[]}},{observedAt:new Date(stamp).toISOString(),details:true,entries:[{item:{id:'a',type:'agentMessage',text:'working'},completedAtMs:stamp}]});assert.equal(old.status,'running');
  const recent=summarizeDesktopThread({...thread('x',(stamp+10000)/1000),preview:'updated title'},{previous:old,observedAt:new Date(stamp+10000).toISOString()});assert.equal(recent.status,'recent_activity');assert.equal(recent.statusSource,'recent_public_activity');assert.equal(recent.lastActivityAt,old.lastActivityAt);
  const stale=summarizeDesktopThread(thread('x',(stamp+300000)/1000),{previous:old,observedAt:new Date(stamp+300000).toISOString()});assert.equal(stale.status,'unknown');assert.equal(stale.statusSource,'stored_metadata');
});

test('notLoaded never means idle; recent persisted public activity is labelled as observation',()=>{
  const config={projects:{workspace:{root:'D:/workspace'}}};
  const a=summarizeDesktopThread(thread('a'),{config,observedAt:new Date(stamp).toISOString()});assert.equal(a.status,'unknown');assert.equal(a.project,'workspace');
  const b=summarizeDesktopThread(thread('a'),{config,observedAt:new Date(stamp).toISOString(),details:true,entries:[{turnId:'new-turn',item:{id:'c',type:'commandExecution',status:'completed'},completedAtMs:stamp-1000}],turns:[{id:'old-turn',status:'completed'}]});assert.equal(b.status,'recent_activity');assert.equal(b.statusSource,'recent_public_activity');
  const c=summarizeDesktopThread(thread('a'),{config,observedAt:new Date(stamp+180000).toISOString(),entries:[{turnId:'new-turn',item:{id:'c',type:'commandExecution'},completedAtMs:stamp-1000}],turns:[{id:'old-turn',status:'completed'}]});assert.equal(c.status,'unknown');
  const d=summarizeDesktopThread(thread('a'),{config,observedAt:new Date(stamp).toISOString(),entries:[{turnId:'turn',item:{id:'c',type:'commandExecution'},completedAtMs:stamp-1000}],turns:[{id:'turn',status:'interrupted',completedAt:null}]});assert.equal(d.status,'recent_activity');
  const e=summarizeDesktopThread(thread('a'),{config,observedAt:new Date(stamp).toISOString(),entries:[{turnId:'turn',item:{id:'c',type:'agentMessage',text:'done'},completedAtMs:stamp-1000}],turns:[{id:'turn',status:'completed',completedAt:stamp/1000}]});assert.equal(e.status,'completed');
});

test('bounded public activity retains latest messages during long tool sequences',()=>{
  const entries=Array.from({length:80},(_,i)=>({turnId:'turn',item:{id:'tool'+i,type:'commandExecution',status:'completed'},completedAtMs:stamp-i}));
  entries.push({item:{id:'u',type:'userMessage',content:[{type:'text',text:'主要任务要求'}]}},{item:{id:'a',type:'agentMessage',phase:'final_answer',text:'已完成公开结果'}});
  const s=summarizeDesktopThread(thread('x'),{entries,details:true});assert.equal(s.latestUserMessage,'主要任务要求');assert.equal(s.latestAssistantMessage,'已完成公开结果');assert.ok(s.activities.length<=30);
});

test('collector pages nonarchived and archived all sources, persists dirty entries during offline, supports requested detail',async t=>{
  const {config,store}=fixture(t),calls=[];
  const rpc={closed:false,async start(){},async close(){this.closed=true;},async call(method,p){calls.push({method,p});if(method==='thread/list'){assert.deepEqual(p.sourceKinds,DESKTOP_SOURCES);if(p.archived)return {data:[thread('archive')],nextCursor:null};return p.cursor?{data:[thread('second')],nextCursor:null}:{data:[thread('first')],nextCursor:'page2'};}if(method==='thread/turns/list')return {data:[{id:'turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'任务说明'}]}]}]};if(method==='thread/items/list')return {data:[{turnId:'turn',item:{id:'a',type:'agentMessage',text:'公开进度'},completedAtMs:stamp}],nextCursor:null};if(method==='thread/read')return {thread:thread(p.threadId)};throw new Error(method);}};
  const collector=new DesktopCollector(config,store,{rpcFactory:()=>rpc,clock:()=>stamp});await collector.collect();
  assert.equal(collector.summary().count,3);assert.equal(collector.summary().complete,true);assert.equal(collector.cached('archive').archived,true);assert.equal(collector.cached('first').latestUserMessage,'任务说明');
  await assert.rejects(collector.publish(async()=>{throw new Error('offline');}),/offline/);assert.equal(collector.summary().pending,3);
  await collector.publish(async(route,{body})=>{assert.equal(route,'/v1/desktop/sync');assert.equal(body.threads.length,3);assert.ok(body.snapshotAt);return {ok:true,readRequests:['archive']};});assert.equal(collector.summary().pending,0);assert.deepEqual(store.get('desktopReadRequests'),['archive']);
  await collector.collect();assert.deepEqual(store.get('desktopReadRequests'),[]);assert.ok(calls.every(c=>['thread/list','thread/read','thread/turns/list','thread/items/list'].includes(c.method)));await collector.close();
});

test('an older network response cannot acknowledge a changed local snapshot',async t=>{
  const {config,store}=fixture(t),collector=new DesktopCollector(config,store);
  collector.save(summarizeDesktopThread(thread('x'),{observedAt:new Date(stamp).toISOString(),config}));
  await collector.publish(async()=>{collector.save(summarizeDesktopThread({...thread('x'),name:'更新标题'},{config,observedAt:new Date(stamp+1000).toISOString()}));return {ok:true};});
  assert.equal(collector.summary().pending,1);assert.equal(collector.cached('x').title,'更新标题');
});

test('duplicate pagination cursors abort without declaring a complete inventory',async t=>{
  const {config,store}=fixture(t),rpc={closed:false,async start(){},async close(){},async call(){return {data:[thread('x')],nextCursor:'repeated'};}};
  const collector=new DesktopCollector(config,store,{rpcFactory:()=>rpc});await assert.rejects(collector.collect(),/repeated a cursor/);assert.equal(collector.summary().complete,undefined);await collector.close();
});

test('local read failure still publishes durable cached snapshots and failure state',async t=>{
  const {config,store}=fixture(t),rpc={closed:false,async start(){throw new Error('Codex temporarily unavailable');},async close(){this.closed=true;}};
  const collector=new DesktopCollector(config,store,{rpcFactory:()=>rpc,clock:()=>stamp});collector.save(summarizeDesktopThread(thread('cached'),{config}));store.put('desktopInventory',{complete:true,count:1,scannedAt:new Date(stamp-300000).toISOString()});let published=0;
  await collector.tick(async(route,{body})=>{published+=body.threads.length;assert.match(body.inventory.error,/temporarily unavailable/);assert.equal(body.inventory.complete,false);return {ok:true};});
  assert.equal(published,1);assert.equal(collector.summary().pending,0);assert.ok(collector.retryAt>stamp);await collector.close();
});

test('Fleet desktop reader resolves device codes and preserves pagination and search parameters',async()=>{
  const client=new FleetClient({}),requests=[];client.nodes=async()=>[{id:'node-2',name:'PC-02'}];client.api=async route=>{requests.push(route);return {threads:[],nextCursor:'next'};};
  await client.desktopTasks({target:'pc-02',search:'主要任务',cursor:'cursor/+?',archived:'true',limit:25});const query=new URL('https://fixture'+requests[0]).searchParams;assert.equal(query.get('node'),'node-2');assert.equal(query.get('search'),'主要任务');assert.equal(query.get('cursor'),'cursor/+?');assert.equal(query.get('archived'),'true');
  await client.desktopRead({target:'PC-02',threadId:'native-id'});assert.equal(requests[1],'/v1/desktop/threads/node-2/native-id');await assert.rejects(client.desktopTasks({limit:101}),/1-100/);client.close();
});

test('shared desktop reads live runtime instead of trusting a state-db-only directory entry',async t=>{
  const {config,store}=fixture(t);config.desktopSessionBridge='test-desktop-endpoint';
  let runtime='active',readFails=false;const calls=[];
  const rpc={closed:false,async start(){},async close(){this.closed=true;},async call(method,p){
    calls.push({method,p});
    if(method==='thread/list')return {data:p.archived?[]:[thread('live')],nextCursor:null};
    if(method==='thread/read'){if(readFails)throw Error('desktop disconnected');return {thread:{...thread('live'),status:{type:runtime,activeFlags:[]}}};}
    if(method==='thread/turns/list')return {data:[{id:'turn',status:'completed',completedAt:stamp/1000,items:[]}]};
    if(method==='thread/items/list')return {data:[{turnId:'turn',item:{id:'last',type:'agentMessage',text:'latest public response'},completedAtMs:stamp-1000}],nextCursor:null};
    throw Error('Unexpected write or method: '+method);
  }};
  const collector=new DesktopCollector(config,store,{rpcFactory:()=>rpc,clock:()=>stamp});
  await collector.collect();assert.equal(collector.cached('live').status,'running');assert.equal(collector.cached('live').statusSource,'app_server_runtime');
  runtime='idle';await collector.collect();assert.equal(collector.cached('live').status,'completed');
  readFails=true;await collector.collect();assert.match(collector.summary().detailErrors[0].error,/disconnected/);assert.notEqual(collector.cached('live').status,'running');
  assert.ok(calls.some(c=>c.method==='thread/read'&&c.p.includeTurns===false));
  assert.ok(calls.every(c=>['thread/list','thread/read','thread/turns/list','thread/items/list'].includes(c.method)));
  await collector.close();
});
