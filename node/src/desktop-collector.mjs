import path from 'node:path';
import {CodexRPC,publicSanitizer} from './codex.mjs';
import {hash,now} from './common.mjs';

// Only documented read methods are used. This never resumes, steers, subscribes
// to or changes a user's native Codex conversations.
export const DESKTOP_SOURCES=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const MAX_TEXT=4000;
const TOOL_TYPES=new Set(['commandExecution','fileChange','mcpToolCall','webSearch','imageView','imageGeneration','subAgentActivity']);
function iso(value){if(value===null||value===undefined)return null;const n=typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;}
export function desktopText(value,config={}){
  return publicSanitizer(config)(String(value||''))
    .replace(/<(?:environment_context|permissions|skills_instructions|in-app-browser-context|system_reminder|developer_instructions)\b[^>]*>[\s\S]*?<\/(?:environment_context|permissions|skills_instructions|in-app-browser-context|system_reminder|developer_instructions)>/gi,'')
    .replace(/([?&#](?:token|ticket|password|secret|api_?key)=)[^\s&#]+/gi,'$1[redacted]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|nodeToken|adminToken|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi,'$1[redacted]')
    .trim().slice(0,MAX_TEXT);
}
function userText(item){return (item.content||[]).filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');}
export function publicDesktopItem(entry,config={}){
  const item=entry?.item||entry;if(!item||typeof item.id!=='string'||!item.id||/reasoning/i.test(item.type||''))return null;
  const at=iso(entry.completedAtMs??entry.startedAtMs??entry.at);
  const base={id:String(item.id||'').slice(0,200),turnId:String(entry.turnId||'').slice(0,200),at};
  if(item.type==='userMessage')return {...base,type:'user_message',text:desktopText(userText(item),config)};
  if(item.type==='agentMessage'&&!['analysis','reasoning'].includes(item.phase))return {...base,type:'assistant_message',text:desktopText(item.text,config)};
  if(TOOL_TYPES.has(item.type))return {...base,type:'tool_activity',toolType:item.type,tool:desktopText(item.tool||item.kind||item.type,config).slice(0,160),status:String(item.status||'completed').slice(0,40),...(Number.isSafeInteger(item.exitCode)?{exitCode:item.exitCode}:{})};
  return null;
}
export function summarizeDesktopThread(thread,{archived=false,entries=[],turns=[],config={},previous=null,observedAt=now(),fleetTaskId=null,details=false}={}){
  let messageCount=0,toolCount=0;
  const clean=value=>desktopText(value,config),visible=entries.map(x=>publicDesktopItem(x,config)).filter(Boolean).filter(x=>x.type==='tool_activity'?++toolCount<=18:++messageCount<=12).slice(0,30).reverse();
  const lastTurn=turns[0],latestEntry=entries.find(e=>iso(e.completedAtMs??e.startedAtMs)),lastActivityAt=iso(latestEntry?.completedAtMs??latestEntry?.startedAtMs)||(!details&&previous?.lastActivityAt?previous.lastActivityAt:iso(thread.updatedAt));
  const runtime=thread.status?.type,flags=thread.status?.activeFlags||[];
  const recent=lastActivityAt&&Date.parse(observedAt)-Date.parse(lastActivityAt)<120000;
  let status='unknown',statusSource='stored_metadata';
  if(runtime==='active'){status=flags.some(x=>/waiting/i.test(x))?'waiting':'running';statusSource='app_server_runtime';}
  else if(runtime==='systemError'){status='failed';statusSource='app_server_runtime';}
  else if(lastTurn?.completedAt&&latestEntry?.turnId===lastTurn.id&&Date.parse(lastActivityAt)<=Date.parse(iso(lastTurn.completedAt))+1000){status=({completed:'completed',interrupted:'interrupted',failed:'failed'})[lastTurn.status]||'unknown';statusSource='persisted_turn';}
  else if(recent&&latestEntry){status='recent_activity';statusSource='recent_public_activity';}
  else if(previous&&!details){
    // Metadata cannot renew an old in-memory running/waiting observation. Keep
    // only unchanged persisted terminal evidence, or genuinely recent public
    // activity; otherwise wait for another detailed read.
    if(previous.statusSource==='persisted_turn'&&previous.updatedAt===iso(thread.updatedAt)){status=previous.status;statusSource=previous.statusSource;}
    else if(previous.activities?.length&&previous.lastActivityAt&&Date.parse(observedAt)-Date.parse(previous.lastActivityAt)<120000){status='recent_activity';statusSource='recent_public_activity';}
  }
  // A separate app-server does not own the desktop's in-memory task. notLoaded
  // is NOT evidence that the task is idle or completed.
  if(status==='recent_activity'&&!recent)status='unknown';
  const cwd=clean(thread.cwd).slice(0,2000);
  const matchedProject=Object.entries(config.projects||{}).find(([,p])=>{if(!p.root||!cwd)return false;const rel=path.relative(path.resolve(p.root),path.resolve(cwd));return !rel||(!rel.startsWith('..')&&!path.isAbsolute(rel));})?.[0];
  // Sharing metadata does not add cwd to this node's executable project map.
  const project=matchedProject||(config.projects?.workspace?'workspace':Object.keys(config.projects||{})[0]||null);
  return {threadId:String(thread.id),title:clean(thread.name||thread.preview||'未命名任务').slice(0,240),preview:clean(thread.preview).slice(0,1000),cwd,project,archived:!!archived,source:typeof thread.source==='string'?thread.source:clean(thread.source?.type||'unknown').slice(0,80),parentThreadId:thread.parentThreadId||null,createdAt:iso(thread.createdAt),updatedAt:iso(thread.updatedAt)||iso(thread.createdAt)||observedAt,observedAt,lastActivityAt,status,statusSource,activeFlags:flags.filter(x=>typeof x==='string').slice(0,10),fleetTaskId:fleetTaskId||previous?.fleetTaskId||null,
    latestUserMessage:visible.findLast(x=>x.type==='user_message')?.text||previous?.latestUserMessage||'',latestAssistantMessage:visible.findLast(x=>x.type==='assistant_message')?.text||previous?.latestAssistantMessage||'',activities:details?visible:previous?.activities||[],detailUpdatedAt:details?observedAt:previous?.detailUpdatedAt||null};
}

export class DesktopCollector {
  constructor(config,store,{rpcFactory=()=>new CodexRPC(config,null),clock=()=>Date.now()}={}){
    this.config=config;this.store=store;this.rpcFactory=rpcFactory;this.clock=clock;this.rpc=null;this.closed=false;this.clean=publicSanitizer(config);this.lastInventory=0;this.failureCount=0;this.retryAt=0;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS desktop_threads(thread TEXT PRIMARY KEY,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,detail_at INTEGER NOT NULL DEFAULT 0);');
  }
  cached(id){const row=this.store.db.prepare('SELECT payload FROM desktop_threads WHERE thread=?').get(id);return row?JSON.parse(row.payload):null;}
  save(record){const previous=this.store.db.prepare('SELECT fingerprint FROM desktop_threads WHERE thread=?').get(record.threadId);const fingerprint=hash(JSON.stringify({...record,observedAt:null}));if(previous?.fingerprint===fingerprint)return;this.store.db.prepare('INSERT INTO desktop_threads(thread,payload,fingerprint,dirty,detail_at) VALUES(?,?,?,1,?) ON CONFLICT(thread) DO UPDATE SET payload=excluded.payload,fingerprint=excluded.fingerprint,dirty=1,detail_at=excluded.detail_at').run(record.threadId,JSON.stringify(record),fingerprint,Date.parse(record.detailUpdatedAt)||0);}
  async connection(){if(this.closed)throw Error('Desktop collector closed');if(this.rpc&&!this.rpc.closed)return this.rpc;const rpc=this.rpcFactory();this.rpc=rpc;await rpc.start();if(this.closed){await rpc.close();throw Error('Desktop collector closed');}return rpc;}
  async list(archived,{all=true}={}){
    const rpc=await this.connection(),result=[],seen=new Set();let cursor=null;
    do{const page=await rpc.call('thread/list',{limit:100,sortKey:'updated_at',sourceKinds:DESKTOP_SOURCES,archived,useStateDbOnly:true,...(cursor?{cursor}:{})},20000);if(!Array.isArray(page.data))throw new Error('Invalid Codex thread list');result.push(...page.data);const next=page.nextCursor||null;if(next&&seen.has(next))throw new Error('Codex thread pagination repeated a cursor');if(next)seen.add(next);cursor=next;if(!all)break;if(this.closed)throw new Error('Desktop collector closed');}while(cursor);
    return result;
  }
  async details(thread,archived,fleetTaskId){
    const rpc=await this.connection();
    // The inventory intentionally reads the state DB and therefore reports
    // notLoaded even for a conversation running in the desktop. Ask the shared
    // desktop server for its live state before publishing detailed observations.
    // This read neither resumes the thread nor acquires its write ownership.
    if(this.config.desktopSessionBridge){
      const response=await rpc.call('thread/read',{threadId:thread.id,includeTurns:false},15000);
      if(!response.thread||response.thread.id!==thread.id)throw new Error('Invalid desktop runtime observation');
      thread=response.thread;
    }
    const turns=await rpc.call('thread/turns/list',{threadId:thread.id,limit:2,sortDirection:'desc',itemsView:'summary'},15000);
    let entries=[],cursor=null,pages=0;do{if(this.closed)throw new Error('Desktop collector closed');const page=await rpc.call('thread/items/list',{threadId:thread.id,limit:50,sortDirection:'desc',...(cursor?{cursor}:{})},15000);entries.push(...(page.data||[]));cursor=page.nextCursor;pages++;}while(cursor&&pages<3&&entries.filter(e=>['userMessage','agentMessage'].includes(e.item?.type)&&!['analysis','reasoning'].includes(e.item?.phase)).length<6);
    // Summary turns supply public messages when a long tool sequence filled the
    // bounded item pages. No reasoning, command arguments or outputs are copied.
    const ids=new Set(entries.map(e=>e.item?.id));for(const turn of turns.data||[])for(const item of [...(turn.items||[])].reverse())if(['userMessage','agentMessage'].includes(item.type)&&!ids.has(item.id))entries.push({turnId:turn.id,item,startedAtMs:turn.startedAt?Number(turn.startedAt)*1000:null,completedAtMs:turn.completedAt?Number(turn.completedAt)*1000:null});
    return summarizeDesktopThread(thread,{archived,entries,turns:turns.data||[],config:this.config,previous:this.cached(thread.id),observedAt:new Date(this.clock()).toISOString(),fleetTaskId,details:true});
  }
  async collect(){
    if(this.closed)return;const at=this.clock(),full=!this.lastInventory||at-this.lastInventory>300000,seen=new Map(),fleetThreads=new Map(this.store.runs().filter(r=>r.thread).map(r=>[r.thread,r.task]));
    const active=await this.list(false,{all:full});for(const t of active)seen.set(t.id,{thread:t,archived:false});
    if(full){for(const t of await this.list(true))seen.set(t.id,{thread:t,archived:true});this.lastInventory=at;}
    for(const {thread,archived} of seen.values())this.save(summarizeDesktopThread(thread,{archived,config:this.config,previous:this.cached(thread.id),observedAt:new Date(at).toISOString(),fleetTaskId:fleetThreads.get(thread.id)}));
    const requested=this.store.get('desktopReadRequests')||[],prioritized=[...requested,...active.slice(0,12).map(t=>t.id)];
    const older=this.store.db.prepare('SELECT thread FROM desktop_threads ORDER BY detail_at ASC LIMIT 4').all().map(r=>r.thread);
    const selected=[...new Set([...prioritized,...older])].slice(0,20),errors=[];
    const read=async id=>{if(this.closed)return;try{let row=seen.get(id);if(!row){const cached=this.cached(id);if(!cached)return;const response=await (await this.connection()).call('thread/read',{threadId:id,includeTurns:false},15000);row={thread:response.thread,archived:cached.archived};}this.save(await this.details(row.thread,row.archived,fleetThreads.get(id)));}catch(e){errors.push({threadId:id,error:this.clean(String(e.message)).slice(0,300)});}};
    for(let start=0;start<selected.length&&!this.closed;start+=3)await Promise.all(selected.slice(start,start+3).map(read));
    const remaining=requested.filter(id=>!selected.includes(id)||errors.some(e=>e.threadId===id));this.store.put('desktopReadRequests',remaining);
    this.store.put('desktopInventory',{at:new Date(at).toISOString(),scannedAt:full?new Date(at).toISOString():this.store.get('desktopInventory')?.scannedAt,complete:!!this.lastInventory,count:this.store.db.prepare('SELECT COUNT(*) n FROM desktop_threads').get().n,detailErrors:errors,error:null});
  }
  async publish(api){
    const rows=[];let bytes=0;
    for(const row of this.store.db.prepare('SELECT thread,payload,fingerprint FROM desktop_threads WHERE dirty=1 ORDER BY detail_at DESC LIMIT 20').all()){
      const size=Buffer.byteLength(row.payload,'utf8');if(rows.length&&bytes+size>180000)break;rows.push(row);bytes+=size;
    }
    const response=await api('/v1/desktop/sync',{method:'POST',body:{threads:rows.map(r=>JSON.parse(r.payload)),inventory:this.store.get('desktopInventory')||{complete:false,count:0},snapshotAt:now()}});
    for(const row of rows)this.store.db.prepare('UPDATE desktop_threads SET dirty=0 WHERE thread=? AND fingerprint=?').run(row.thread,row.fingerprint);
    if(Array.isArray(response?.readRequests)){const ids=response.readRequests.filter(id=>typeof id==='string'&&this.cached(id)).slice(0,20);this.store.put('desktopReadRequests',[...new Set([...(this.store.get('desktopReadRequests')||[]),...ids])]);}
    this.store.put('desktopPublishedAt',now());return rows.length;
  }
  async tick(api){
    if(this.closed||this.clock()<this.retryAt)return;
    let failure=null;
    try{await this.collect();}catch(e){failure=e;this.store.put('desktopInventory',{...(this.store.get('desktopInventory')||{}),complete:false,count:this.store.db.prepare('SELECT COUNT(*) n FROM desktop_threads').get().n,error:this.clean(String(e.message)).slice(0,400),errorAt:now()});if(this.rpc){await this.rpc.close().catch(()=>{});this.rpc=null;}}
    // A local history-reader error must not withhold already persisted snapshots
    // or its own error report from a recovered cloud connection.
    try{if(!this.closed){for(let batch=0;batch<5;batch++){const sent=await this.publish(api);if(!sent||!this.summary().pending)break;}}}catch(e){failure=e;this.store.put('desktopInventory',{...(this.store.get('desktopInventory')||{}),error:this.clean(String(e.message)).slice(0,400),errorAt:now()});}
    if(failure){this.failureCount++;this.retryAt=this.clock()+Math.min(120000,5000*2**Math.min(this.failureCount,5));}else{this.failureCount=0;this.retryAt=this.clock()+10000;}
  }
  summary(){const inv=this.store.get('desktopInventory');return {enabled:true,...inv,publishedAt:this.store.get('desktopPublishedAt'),pending:this.store.db.prepare('SELECT COUNT(*) n FROM desktop_threads WHERE dirty=1').get().n};}
  async close(){this.closed=true;await this.rpc?.close();this.rpc=null;}
}
