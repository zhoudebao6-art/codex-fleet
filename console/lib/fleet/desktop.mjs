import {visibleItem,visibleDirectory,visibleDesktop,consoleView} from './console-cleanup.mjs';
import {assert,now,json,parse,validId,validProject,hash} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {can,writer} from './auth.mjs';
import {nodeScope,assertNodeAccess,readAccess} from './access.mjs';
import {workspaceAccess} from './workspaces.mjs';
import {directoryFilter,sqlDirectory} from './project-paths.mjs';
import {latestDesktopMessageSql} from './desktop-message.mjs';

const STATUSES=new Set(['unknown','running','waiting','failed','completed','interrupted','recent_activity']);
const STATUS_SOURCES=new Set(['stored_metadata','app_server_runtime','persisted_turn','recent_public_activity']);
const SOURCES=new Set(['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown']);
const MAX_BATCH_BYTES=1024*1024;
const scoped=n=>!n.admin&&(!n.browser||n.kind==='device');
const freshness=at=>!at?'unknown':Date.now()-Date.parse(at)<120000?'fresh':'stale';

function string(value,key,max,{empty=true,fallback=''}={}) {
  if(value===undefined||value===null)return fallback;
  assert(typeof value==='string'&&value.length<=max&&(empty||value.length>0),`Invalid desktop ${key}`);
  return value.replace(/\u0000/g,'');
}
function timestamp(value,key,{optional=false}={}) {
  if((value===undefined||value===null||value==='')&&optional)return null;
  assert(typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value)),`Invalid desktop ${key}`);
  return new Date(value).toISOString();
}
function optionalId(value,key) {
  if(value===undefined||value===null||value==='')return null;
  assert(validId(value),`Invalid desktop ${key}`);return value;
}
function activity(item) {
  assert(item&&typeof item==='object'&&!Array.isArray(item),'Invalid desktop activity');
  const type=item.type;assert(['user_message','assistant_message','tool_activity'].includes(type),'Unsupported desktop activity type');
  const result={id:string(item.id,'activity ID',200,{empty:false,fallback:null}),turnId:string(item.turnId,'turn ID',200,{fallback:null}),at:timestamp(item.at,'activity timestamp',{optional:true}),type};
  assert(result.id,'Desktop activity ID required');
  if(type==='tool_activity') {
    result.toolType=string(item.toolType,'tool type',80);
    result.tool=string(item.tool,'tool',160);
    result.status=string(item.status,'tool status',40);
    if(item.exitCode!==undefined&&item.exitCode!==null){assert(Number.isSafeInteger(item.exitCode),'Invalid desktop tool exit code');result.exitCode=item.exitCode;}
  } else result.text=string(item.text,'message text',4000);
  return result;
}
function normalizeThread(item,n,observedAt) {
  assert(item&&typeof item==='object'&&!Array.isArray(item)&&validId(item.threadId),'Invalid desktop thread ID');
  assert(validProject(item.project)&&can(n,item.project),'Project access denied',403);
  const status=item.status||'unknown',statusSource=item.statusSource||'stored_metadata',source=item.source||'unknown';
  assert(STATUSES.has(status)&&STATUS_SOURCES.has(statusSource)&&SOURCES.has(source),'Invalid desktop status or source');
  assert(item.archived===undefined||typeof item.archived==='boolean','Invalid desktop archived flag');
  assert(item.activeFlags===undefined||(Array.isArray(item.activeFlags)&&item.activeFlags.length<=20&&item.activeFlags.every(v=>typeof v==='string'&&v.length<=80)),'Invalid desktop active flags');
  const detailAt=timestamp(item.detailUpdatedAt,'detail timestamp',{optional:true});
  let details=null;
  if(detailAt) {
    assert(Array.isArray(item.activities||[])&&(item.activities||[]).length<=30,'Invalid desktop activities');
    const seen=new Set(),activities=(item.activities||[]).map(activity).filter(value=>{if(seen.has(value.id))return false;seen.add(value.id);return true;});
    details={latestUserMessage:string(item.latestUserMessage,'latest user message',4000),latestAssistantMessage:string(item.latestAssistantMessage,'latest assistant message',4000),activities};
    assert(json(details).length<=96000,'Desktop details too large',413);
  }
  const observed=timestamp(item.observedAt||observedAt,'observation timestamp');
  // Device clocks can drift. Prevent a bad clock from permanently winning the
  // monotonic upsert while tolerating ordinary clock skew.
  assert(Date.parse(observed)<=Date.now()+300000,'Desktop observation is in the future');
  if(detailAt)assert(Date.parse(detailAt)<=Date.now()+300000,'Desktop detail observation is in the future');
  return {
    threadId:item.threadId,project:item.project,title:string(item.title,'title',240,{fallback:'Untitled task'}),
    preview:string(item.preview,'preview',1000),cwd:string(item.cwd,'directory',2000),archived:item.archived?1:0,source,
    createdAt:timestamp(item.createdAt,'created timestamp',{optional:true}),updatedAt:timestamp(item.updatedAt,'updated timestamp'),observedAt:observed,
    status,statusSource,lastActivityAt:timestamp(item.lastActivityAt,'last activity timestamp',{optional:true}),activeFlags:json(item.activeFlags||[]),
    parentThreadId:optionalId(item.parentThreadId,'parent ID'),fleetTaskId:optionalId(item.fleetTaskId,'Fleet task ID'),details:details?json(details):'{}',detailUpdatedAt:detailAt,
  };
}
function normalizeInventory(item,ts) {
  if(item===undefined||item===null)return null;
  assert(typeof item==='object'&&!Array.isArray(item)&&typeof item.complete==='boolean'&&Number.isSafeInteger(item.count)&&item.count>=0&&item.count<=1000000,'Invalid desktop inventory');
  const errors=item.detailErrors||[];assert(Array.isArray(errors)&&errors.length<=100,'Invalid desktop detail errors');
  const scannedAt=timestamp(item.scannedAt||item.at||ts,'inventory scan timestamp');
  assert(Date.parse(scannedAt)<=Date.now()+300000,'Desktop inventory observation is in the future');
  return {scannedAt,complete:item.complete?1:0,count:item.count,error:string(item.error,'inventory error',1000,{fallback:null}),
    detailErrors:json(errors.map(x=>({threadId:optionalId(x?.threadId,'detail error thread'),error:string(x?.error,'detail error',600)})))};
}

export async function desktopSync(db,n,b) {
  assert(!n.admin&&!n.browser,'Node token required',403);
  assert(b&&typeof b==='object'&&Array.isArray(b.threads)&&b.threads.length<=20,'Desktop sync accepts at most 20 threads');
  assert(Buffer.byteLength(json(b),'utf8')<=MAX_BATCH_BYTES,'Desktop batch too large',413);
  // Caller identity always comes from the credential; a body cannot write a
  // second computer's inventory, even if the two share a Codex login.
  assert(b.nodeId===undefined||b.nodeId===n.id,'Desktop identity mismatch',403);
  const ts=now(),observedAt=timestamp(b.snapshotAt||ts,'snapshot timestamp'),threads=b.threads.map(item=>normalizeThread(item,n,observedAt));
  assert(new Set(threads.map(x=>x.threadId)).size===threads.length,'Duplicate desktop thread ID in batch');
  const inventory=normalizeInventory(b.inventory,ts);
  for(const item of threads) {
    if(item.fleetTaskId) {
      const linked=await first(db,'SELECT project,target,thread_id FROM tasks WHERE id=?',item.fleetTaskId);
      assert(linked&&linked.project===item.project&&linked.target===n.id&&(!linked.thread_id||linked.thread_id===item.threadId),'Invalid Fleet task link',403);
    }
  }
  const commands=threads.map(item=>[
    `INSERT INTO desktop_threads(node,thread_id,project,title,preview,cwd,archived,source,created_at,updated_at,observed_at,status,status_source,last_activity_at,active_flags,parent_thread_id,fleet_task_id,details,detail_updated_at,detail_received_at,received_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(node,thread_id) DO UPDATE SET
       project=excluded.project,title=excluded.title,preview=excluded.preview,cwd=excluded.cwd,archived=excluded.archived,source=excluded.source,
       created_at=COALESCE(excluded.created_at,desktop_threads.created_at),updated_at=excluded.updated_at,observed_at=excluded.observed_at,
       status=excluded.status,status_source=excluded.status_source,last_activity_at=excluded.last_activity_at,active_flags=excluded.active_flags,
       parent_thread_id=excluded.parent_thread_id,fleet_task_id=excluded.fleet_task_id,
       details=CASE WHEN desktop_threads.project<>excluded.project OR (excluded.detail_updated_at IS NOT NULL AND (desktop_threads.detail_updated_at IS NULL OR excluded.detail_updated_at>=desktop_threads.detail_updated_at)) THEN excluded.details ELSE desktop_threads.details END,
       detail_updated_at=CASE WHEN desktop_threads.project<>excluded.project OR (excluded.detail_updated_at IS NOT NULL AND (desktop_threads.detail_updated_at IS NULL OR excluded.detail_updated_at>=desktop_threads.detail_updated_at)) THEN excluded.detail_updated_at ELSE desktop_threads.detail_updated_at END,
       detail_received_at=CASE WHEN desktop_threads.project<>excluded.project OR (excluded.detail_updated_at IS NOT NULL AND (desktop_threads.detail_updated_at IS NULL OR excluded.detail_updated_at>desktop_threads.detail_updated_at)) THEN excluded.detail_received_at ELSE desktop_threads.detail_received_at END,
       received_at=excluded.received_at WHERE excluded.observed_at>=desktop_threads.observed_at`,
    n.id,item.threadId,item.project,item.title,item.preview,item.cwd,item.archived,item.source,item.createdAt,item.updatedAt,item.observedAt,item.status,item.statusSource,item.lastActivityAt,item.activeFlags,item.parentThreadId,item.fleetTaskId,item.details,item.detailUpdatedAt,item.detailUpdatedAt?ts:null,ts,
  ]);
  if(inventory)commands.push([
    `INSERT INTO desktop_inventories(node,scanned_at,received_at,complete,count,error,detail_errors) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(node) DO UPDATE SET scanned_at=excluded.scanned_at,received_at=excluded.received_at,complete=excluded.complete,count=excluded.count,error=excluded.error,detail_errors=excluded.detail_errors
     WHERE excluded.scanned_at>=desktop_inventories.scanned_at`,
    n.id,inventory.scannedAt,ts,inventory.complete,inventory.count,inventory.error,inventory.detailErrors,
  ]);
  commands.push(['DELETE FROM desktop_read_requests WHERE node=? AND EXISTS(SELECT 1 FROM desktop_threads t WHERE t.node=desktop_read_requests.node AND t.thread_id=desktop_read_requests.thread_id AND t.detail_received_at>=desktop_read_requests.created)',n.id]);
  // Validation precedes this atomic batch. Retries are idempotent; no partial
  // batch is acknowledged, and missing rows are never interpreted as deletion.
  await batch(db,commands);
  const requests=await all(db,'SELECT r.thread_id FROM desktop_read_requests r JOIN desktop_threads t ON t.node=r.node AND t.thread_id=r.thread_id WHERE r.node=? AND t.project IN (SELECT value FROM json_each(?)) ORDER BY r.created,r.thread_id LIMIT 20',n.id,n.projects);
  return {ok:true,ack:threads.map(x=>x.threadId),readRequests:requests.map(x=>x.thread_id),serverTime:ts};
}

const selectColumns=`t.node AS nodeId,COALESCE(n.display_name,n.name) AS nodeName,t.thread_id AS threadId,t.project,t.title,t.preview,t.cwd,t.archived,t.source,
  t.created_at AS createdAt,t.updated_at AS updatedAt,t.observed_at AS observedAt,t.status,t.status_source AS statusSource,
  t.last_activity_at AS lastActivityAt,t.active_flags AS activeFlags,t.parent_thread_id AS parentThreadId,t.fleet_task_id AS fleetTaskId,
  t.detail_updated_at AS detailUpdatedAt,t.detail_received_at AS detailReceivedAt,t.received_at AS receivedAt,t.pinned,t.pinned_by AS pinnedBy,t.pinned_at AS pinnedAt,
  i.received_at AS inventoryReceivedAt,n.last_seen AS nodeLastSeen,${latestDesktopMessageSql('t')} AS latestMessage`;
const joins=' FROM desktop_threads t JOIN nodes n ON n.id=t.node LEFT JOIN desktop_inventories i ON i.node=t.node';
function view(row,{details=false}={}) {
  const result={...row,archived:!!row.archived,pinned:!!row.pinned,activeFlags:parse(row.activeFlags),workspace:row.cwd,recentActivityAt:row.lastActivityAt,
    freshness:freshness(row.inventoryReceivedAt||row.receivedAt),statusFreshness:freshness(row.observedAt),nodeOnline:!!row.nodeLastSeen&&Date.now()-Date.parse(row.nodeLastSeen)<60000};
  result.latestMessage=parse(row.latestMessage)||null;
  result.messageState=!row.detailUpdatedAt?'pending':row.detailUpdatedAt<row.updatedAt?'syncing':result.latestMessage?'ready':'empty';
  delete result.inventoryReceivedAt;delete result.nodeLastSeen;
  if(details) {
    const value=parse(row.details)||{};delete result.details;
    result.latestUserMessage=value.latestUserMessage||'';result.latestAssistantMessage=value.latestAssistantMessage||'';result.activities=value.activities||[];
    result.messages=result.activities.filter(x=>x.type==='user_message'||x.type==='assistant_message').map(x=>({id:x.id,role:x.type==='user_message'?'user':'assistant',text:x.text,at:x.at}));
    if(!result.messages.length) {
      if(result.latestUserMessage)result.messages.push({id:'latest-user',role:'user',text:result.latestUserMessage,at:result.lastActivityAt});
      if(result.latestAssistantMessage)result.messages.push({id:'latest-assistant',role:'assistant',text:result.latestAssistantMessage,at:result.lastActivityAt});
    }
  }
  return result;
}
async function requestVisibleMessages(db,rows) {
  // Only request the displayed, already-authorized page. Existing requests keep
  // their original age across polling; offline devices and unchanged completed
  // histories do not cause repeated reads of the whole conversation catalog.
  const selected=rows.filter(row=>row.nodeLastSeen&&Date.now()-Date.parse(row.nodeLastSeen)<60000&&
    (!row.detailUpdatedAt||row.detailUpdatedAt<row.updatedAt)).slice(0,20);
  if(selected.length)await run(db,`INSERT OR IGNORE INTO desktop_read_requests(node,thread_id,created)
    SELECT json_extract(value,'$.nodeId'),json_extract(value,'$.threadId'),? FROM json_each(?)`,
    now(),json(selected.map(({nodeId,threadId})=>({nodeId,threadId}))));
}
async function filters(db,n,url) {
  const clauses=['n.revoked=0',nodeScope(n,'t.node')],args=[];if(consoleView(n))clauses.push(visibleDesktop('t'));
  const source=url.searchParams.get('source')||'all';assert(['all','conversations'].includes(source),'Invalid conversation source');
  if(source==='conversations')clauses.push("NOT EXISTS(SELECT 1 FROM tasks ft WHERE ft.target=t.node AND ft.thread_id=t.thread_id AND json_extract(ft.spec,'$.desktopThreadId') IS NULL AND COALESCE(json_extract(ft.spec,'$.intent'),'collaboration')!='conversation')");
  if(scoped(n)){clauses.push('t.project IN (SELECT value FROM json_each(?))');args.push(n.projects);}
  let nodeId=url.searchParams.get('nodeId')||url.searchParams.get('node');const q=url.searchParams.get('q')||url.searchParams.get('search')||'',archived=url.searchParams.get('archived')||'all',pinned=url.searchParams.get('pinned'),workspaceId=url.searchParams.get('workspaceId')||null,cwd=directoryFilter(url.searchParams.get('cwd')||url.searchParams.get('root')),project=url.searchParams.get('project')||null,phase=url.searchParams.get('phase')||'all';
  assert(['all','active','completed'].includes(phase),'Invalid desktop phase');assert(!project||validProject(project),'Invalid desktop project');assert(!cwd||nodeId,'Directory filter requires a computer');
  if(project){assert(can(n,project),'Project access denied',403);clauses.push('t.project=?');args.push(project);}
  if(workspaceId){const w=await workspaceAccess(db,n,workspaceId);assert(!nodeId||nodeId===w.node,'Workspace belongs to another computer');assert(!project||project===w.project,'Workspace belongs to another project');nodeId=w.node;clauses.push("t.project=? AND (EXISTS(SELECT 1 FROM tasks ft WHERE ft.target=t.node AND ft.project=t.project AND (ft.thread_id=t.thread_id OR ft.id=t.fleet_task_id) AND json_extract(ft.spec,'$.workspaceId')=?)"+(w.root?` OR ${sqlDirectory('t.cwd')}=?`:'')+')');args.push(w.project,w.id,...(w.root?[directoryFilter(w.root)]:[]));}
  if(nodeId){assert(validId(nodeId),'Invalid desktop node ID');clauses.push('t.node=?');args.push(nodeId);}
  if(cwd){clauses.push(sqlDirectory('t.cwd')+'=?');args.push(cwd);}
  if(phase==='completed')clauses.push("t.status='completed'");
  if(phase==='active'){clauses.push("t.status IN('running','waiting') AND t.status_source='app_server_runtime' AND t.observed_at>=? AND t.received_at>=? AND n.last_seen>=?");args.push(new Date(Date.now()-120000).toISOString(),new Date(Date.now()-120000).toISOString(),new Date(Date.now()-60000).toISOString());}
  assert(q.length<=300&&['all','true','false'].includes(archived)&&(pinned===null||['true','false'].includes(pinned)),'Invalid desktop filters');
  if(archived!=='all'){clauses.push('t.archived=?');args.push(archived==='true'?1:0);}
  if(pinned!==null){clauses.push('t.pinned=?');args.push(pinned==='true'?1:0);}
  if(q){clauses.push("(t.title LIKE ? ESCAPE '\\' OR t.preview LIKE ? ESCAPE '\\' OR t.cwd LIKE ? ESCAPE '\\')");const search='%'+q.replace(/[\\%_]/g,'\\$&')+'%';args.push(search,search,search);}
  return {clauses,args,nodeId,signature:hash(json({source,nodeId,q,archived,pinned,workspaceId,cwd,project,phase,access:n.browser?readAccess(n.access):null,scope:scoped(n)?n.projects:null}))};
}
function decodeCursor(raw,signature) {
  if(!raw)return null;
  assert(raw.length<=1000,'Invalid desktop cursor');let value;try{value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{assert(false,'Invalid desktop cursor');}
  assert(value&&value.signature===signature&&[0,1].includes(value.pinned)&&validId(value.nodeId)&&validId(value.threadId),'Invalid desktop cursor');
  timestamp(value.updatedAt,'cursor timestamp');return value;
}
export async function desktopInventories(db,n,nodeId=null) {
  const args=[],where=['n.revoked=0',nodeScope(n,'n.id')];
  if(scoped(n)){where.push('EXISTS(SELECT 1 FROM json_each(n.projects) p WHERE p.value IN (SELECT value FROM json_each(?)))');args.push(n.projects);}
  if(nodeId){where.push('n.id=?');args.push(nodeId);}
  const rows=await all(db,`SELECT n.id AS nodeId,COALESCE(n.display_name,n.name) AS nodeName,n.projects,n.last_seen AS nodeLastSeen,i.scanned_at AS scannedAt,i.received_at AS receivedAt,i.complete,i.count,i.error,i.detail_errors AS detailErrors FROM nodes n LEFT JOIN desktop_inventories i ON i.node=n.id WHERE ${where.join(' AND ')} ORDER BY n.name,n.id`,...args);
  const countArgs=[],countWhere=['n.revoked=0',nodeScope(n,'t.node')];
  if(scoped(n)){countWhere.push('t.project IN (SELECT value FROM json_each(?))');countArgs.push(n.projects);}
  if(nodeId){countWhere.push('t.node=?');countArgs.push(nodeId);}
  const counts=await all(db,`SELECT t.node,count(*) AS count FROM desktop_threads t JOIN nodes n ON n.id=t.node WHERE ${countWhere.join(' AND ')} GROUP BY t.node`,...countArgs),byNode=new Map(counts.map(x=>[x.node,x.count]));
  return rows.map(row=>{
    const allProjects=JSON.parse(row.projects).every(p=>can(n,p)),value={nodeId:row.nodeId,nodeName:row.nodeName,scannedAt:row.scannedAt,receivedAt:row.receivedAt,complete:!!row.complete,count:allProjects?(row.count??0):(byNode.get(row.nodeId)||0),storedCount:byNode.get(row.nodeId)||0,countScope:allProjects?'node':'permitted_projects',error:allProjects?row.error:null,detailErrors:allProjects?(parse(row.detailErrors)||[]):[],freshness:freshness(row.receivedAt),online:!!row.nodeLastSeen&&Date.now()-Date.parse(row.nodeLastSeen)<60000};
    return value;
  });
}
export async function desktopThreads(db,n,url) {
  const f=await filters(db,n,url),limit=Number(url.searchParams.get('limit')||30);assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Invalid desktop page size');
  const cursor=decodeCursor(url.searchParams.get('cursor'),f.signature),where=[...f.clauses],args=[...f.args];
  if(cursor){where.push('(t.pinned<? OR (t.pinned=? AND (t.updated_at<? OR (t.updated_at=? AND (t.node>? OR (t.node=? AND t.thread_id>?))))))');args.push(cursor.pinned,cursor.pinned,cursor.updatedAt,cursor.updatedAt,cursor.nodeId,cursor.nodeId,cursor.threadId);}
  const [rows,count,inventories]=await Promise.all([
    all(db,`SELECT ${selectColumns}${joins} WHERE ${where.join(' AND ')} ORDER BY t.pinned DESC,t.updated_at DESC,t.node ASC,t.thread_id ASC LIMIT ?`,...args,limit+1),
    first(db,`SELECT count(*) AS total${joins} WHERE ${f.clauses.join(' AND ')}`,...f.args),desktopInventories(db,n,f.nodeId),
  ]);
  const hasMore=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1);
  await requestVisibleMessages(db,page);
  return {threads:page.map(x=>view(x)),nextCursor:hasMore?Buffer.from(json({signature:f.signature,pinned:last.pinned,updatedAt:last.updatedAt,nodeId:last.nodeId,threadId:last.threadId})).toString('base64url'):null,total:count.total,inventories,serverTime:now()};
}
export async function desktopAccess(db,n,nodeId,threadId) {
  assert(validId(nodeId)&&validId(threadId),'Invalid desktop identity');
  const row=await first(db,`SELECT ${selectColumns},t.details${joins} WHERE t.node=? AND t.thread_id=? AND n.revoked=0`,nodeId,threadId);
  assert(row,'Desktop task not found',404);await assertNodeAccess(db,n,nodeId);assert(can(n,row.project),'Project access denied',403);return row;
}
export async function desktopDetail(db,n,nodeId,threadId,{refresh=false}={}) {
  const row=await desktopAccess(db,n,nodeId,threadId);
  const needsDetail=refresh||!row.detailUpdatedAt||row.detailUpdatedAt<row.updatedAt||!row.detailReceivedAt||Date.now()-Date.parse(row.detailReceivedAt)>120000;
  if(needsDetail)await run(db,'INSERT OR IGNORE INTO desktop_read_requests(node,thread_id,created) VALUES(?,?,?)',nodeId,threadId,now());
  const request=await first(db,'SELECT created FROM desktop_read_requests WHERE node=? AND thread_id=?',nodeId,threadId);
  const linked=await first(db,"SELECT id,status,spec FROM tasks WHERE target=? AND project=? AND (thread_id=? OR json_extract(spec,'$.desktopThreadId')=?) ORDER BY CASE WHEN status IN('queued','claimed','running','uncertain','cancel_requested') OR json_extract(result,'$.desktop.state')='uncertain' THEN 0 ELSE 1 END,updated DESC,id DESC LIMIT 1",nodeId,row.project,threadId,threadId);
  return {...view(row,{details:true}),fleetTaskId:linked?.id||null,fleetTaskStatus:linked?.status||null,fleetTaskNative:!!linked&&parse(linked.spec)?.desktopThreadId===threadId,detailPending:!!request,refreshRequested:request?.created||null,detailState:request?'pending':row.detailUpdatedAt?'ready':'unavailable',inventory:(await desktopInventories(db,n,nodeId))[0]||null};
}
export async function desktopPin(db,n,nodeId,threadId,b) {
  writer(n);await desktopAccess(db,n,nodeId,threadId);assert(b&&typeof b.pinned==='boolean','Pinned flag required');
  await run(db,'UPDATE desktop_threads SET pinned=?,pinned_by=?,pinned_at=? WHERE node=? AND thread_id=?',b.pinned?1:0,n.id,now(),nodeId,threadId);
  return {ok:true,nodeId,threadId,pinned:b.pinned};
}
export async function desktopSummary(db,n) {
  const inventories=await desktopInventories(db,n),args=[],where=['n.revoked=0',nodeScope(n,'t.node')];if(consoleView(n))where.push(visibleDesktop('t'));
  if(scoped(n)){where.push('t.project IN (SELECT value FROM json_each(?))');args.push(n.projects);}
  // Bound each device's result in SQL; do not load an entire historical desktop
  // directory into a Worker isolate merely to render the overview.
  const rows=await all(db,`SELECT * FROM (SELECT ${selectColumns},ROW_NUMBER() OVER(PARTITION BY t.node ORDER BY t.pinned DESC,t.updated_at DESC,t.thread_id ASC) AS rank,ROW_NUMBER() OVER(PARTITION BY t.node ORDER BY t.updated_at DESC,t.thread_id ASC) AS recentRank${joins} WHERE ${where.join(' AND ')}) WHERE rank<=3 OR recentRank=1 ORDER BY nodeName,rank`,...args);
  await requestVisibleMessages(db,rows);
  const publicRow=({rank,recentRank,...row})=>view(row);
  return {nodes:inventories.map(inventory=>{const local=rows.filter(row=>row.nodeId===inventory.nodeId);return {nodeId:inventory.nodeId,nodeName:inventory.nodeName,inventory,threads:local.filter(row=>row.rank<=3).map(publicRow),latestThread:local.find(row=>row.recentRank===1)?publicRow(local.find(row=>row.recentRank===1)):null};}),serverTime:now()};
}
