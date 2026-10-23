import {visibleItem,visibleDirectory,visibleDesktop,consoleView} from './console-cleanup.mjs';
import {nodeScope} from './access.mjs';
import {all} from './db.mjs';
import {hash,parse} from './util.mjs';
import {directoryKey} from './project-paths.mjs';
import {latestDesktopMessageSql} from './desktop-message.mjs';

const fresh=(value,ms)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.now()-Date.parse(value)<ms;
const small=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
const phaseLabel={preparing:'准备任务',running:'执行任务',uploading:'上传结果',waiting:'等待交互答复',cancel_requested:'正在停止'};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};

function activity(row,phase) {
  if(row.eventKind==='tool_activity')return [small(row.eventTool,160)||small(row.eventToolType,80)||'工具操作',small(row.eventStatus,40)].filter(Boolean).join(' · ');
  if(row.eventKind==='input_transfer')return '接收输入文件'+(row.eventStage?' · '+small(row.eventStage,40):'');
  if(row.eventKind==='output_transfer')return '上传结果文件'+(row.eventStage?' · '+small(row.eventStage,40):'');
  if(['assistant_message','attention','interaction_requested','interaction_resolved'].includes(row.eventKind)&&row.eventMessage)return small(row.eventMessage);
  return phaseLabel[phase]||'执行任务';
}

export async function runningProjects(db,actor) {
  const scoped=!actor.admin&&(!actor.browser||actor.kind==='device'),scope=scoped?actor.projects:null,nodeCutoff=new Date(Date.now()-60000).toISOString(),activityCutoff=new Date(Date.now()-120000).toISOString();
  const [nodes,workspaces,fleet,desktop]=await Promise.all([
    all(db,'SELECT id,COALESCE(display_name,name) AS name,last_seen,capabilities FROM nodes WHERE '+nodeScope(actor,'id')+' AND revoked=0 AND last_seen>=?'+(scoped?' AND EXISTS(SELECT 1 FROM json_each(nodes.projects) p WHERE p.value IN(SELECT value FROM json_each(?)))':''),nodeCutoff,...(scoped?[scope]:[])),
    all(db,'SELECT id,node,project,name,root FROM project_workspaces WHERE '+nodeScope(actor,'node')+' AND root IS NOT NULL'+(scoped?' AND project IN(SELECT value FROM json_each(?))':''),...(scoped?[scope]:[])),
    all(db,`SELECT t.id,t.target,t.project,t.status,t.attempt,COALESCE(t.thread_id,json_extract(t.spec,'$.desktopThreadId')) AS thread_id,t.updated,json_extract(t.spec,'$.workspaceId') AS workspaceId,substr(json_extract(t.spec,'$.prompt'),1,240) AS title,d.cwd,
      e.created AS eventAt,substr(json_extract(e.payload,'$.kind'),1,80) AS eventKind,substr(json_extract(e.payload,'$.message'),1,300) AS eventMessage,
      substr(json_extract(e.payload,'$.tool'),1,160) AS eventTool,substr(json_extract(e.payload,'$.toolType'),1,80) AS eventToolType,
      substr(json_extract(e.payload,'$.status'),1,40) AS eventStatus,substr(json_extract(e.payload,'$.stage'),1,40) AS eventStage
      FROM tasks t JOIN nodes n ON n.id=t.target
      LEFT JOIN desktop_threads d ON d.node=t.target AND d.thread_id=COALESCE(t.thread_id,json_extract(t.spec,'$.desktopThreadId')) AND d.project=t.project
      LEFT JOIN events e ON e.seq=(SELECT MAX(x.seq) FROM events x WHERE x.task=t.id AND x.node=t.target AND x.type IN('started','progress') AND json_extract(x.payload,'$.attemptId')=t.attempt)
      WHERE ${nodeScope(actor,'t.target')} AND ${consoleView(actor)?visibleItem('task','t.id'):'1'} AND t.status IN('claimed','running','cancel_requested') AND n.revoked=0 AND n.last_seen>=?${scoped?' AND t.project IN(SELECT value FROM json_each(?))':''}`,nodeCutoff,...(scoped?[scope]:[])),
    all(db,`SELECT d.node,d.thread_id,d.project,d.title,d.cwd,d.updated_at,d.observed_at,d.last_activity_at,d.fleet_task_id,
      ${latestDesktopMessageSql('d')} AS latestMessage
      FROM desktop_threads d JOIN nodes n ON n.id=d.node WHERE ${nodeScope(actor,'d.node')} AND ${consoleView(actor)?visibleDesktop('d'):'1'} AND n.revoked=0 AND n.last_seen>=? AND d.archived=0 AND d.status='running' AND d.status_source='app_server_runtime' AND d.observed_at>=? AND d.received_at>=?${scoped?' AND d.project IN(SELECT value FROM json_each(?))':''}`,nodeCutoff,activityCutoff,activityCutoff,...(scoped?[scope]:[])),
  ]);
  const nodeMap=new Map(nodes.map(n=>[n.id,{...n,caps:plain(parse(n.capabilities))}])),workspaceMap=new Map(workspaces.map(w=>[w.id,w])),rootMap=new Map(workspaces.map(w=>[[w.node,w.project,directoryKey(w.root)].join('\n'),w])),groups=new Map(),fleetThreads=new Set(),fleetIds=new Set();
  function add(node,project,workspaceId,cwd,ref,latestActivity,at) {
    let w=workspaceMap.get(workspaceId);if(w&&(w.node!==node.id||w.project!==project))w=null;
    w=w||rootMap.get([node.id,project,directoryKey(cwd)].join('\n'));const root=w?.root||small(cwd,2000)||null,key=[node.id,project,directoryKey(root)||'unregistered'].join('\n');
    let group=groups.get(key);if(!group){group={id:'project-'+hash(key).slice(0,32),nodeId:node.id,nodeName:node.name,project,name:w?.name||(root?root.replace(/\\/g,'/').replace(/\/+$/,'').split('/').at(-1):project==='workspace'?'默认工作目录':project),workspaceId:w?.id||null,root,total:0,fleetCount:0,desktopCount:0,currentTasks:[],latestActivity:'',latestActivityAt:null};groups.set(key,group);}
    group.total++;group[ref.kind==='fleet'?'fleetCount':'desktopCount']++;ref.workspaceId=w?.id||null;group.currentTasks.push(ref);group.currentTasks.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||a.id.localeCompare(b.id));if(group.currentTasks.length>8)group.currentTasks.length=8;
    if(!group.latestActivityAt||(at&&at>=group.latestActivityAt)){group.latestActivity=latestActivity;group.latestActivityAt=at||null;}
  }
  for(const row of fleet) {
    const node=nodeMap.get(row.target);if(!node)continue;
    const runtime=Array.isArray(node.caps.taskRuntime)?node.caps.taskRuntime.find(x=>x&&x.taskId===row.id&&x.attemptId===row.attempt&&['preparing','running','uploading'].includes(x.phase)):null;
    const active=Array.isArray(node.caps.activeTasks)&&node.caps.activeTasks.includes(row.id);let phase=runtime?.phase,evidence=runtime?'node_runtime':null;
    if(!phase&&active){phase=row.thread_id?'running':'preparing';evidence='active_task';}
    // Older adapters do not report upload runtime. Only a fresh actual transfer
    // event can confirm that phase; a historical running row alone cannot.
    if(!phase&&row.eventKind==='output_transfer'&&fresh(row.eventAt,120000)){phase='uploading';evidence='fresh_output_transfer';}
    if(!phase)continue;
    if(Array.isArray(node.caps.waitingInteractions)&&node.caps.waitingInteractions.some(x=>x?.taskId===row.id))phase='waiting';if(row.status==='cancel_requested')phase='cancel_requested';
    const cwd=small(runtime?.cwd,2000)||row.cwd||null,at=row.eventAt||row.updated;
    add(node,row.project,row.workspaceId,cwd,{kind:'fleet',id:row.id,taskId:row.id,nodeId:node.id,threadId:row.thread_id||null,title:row.title,status:row.status,phase,evidence,updatedAt:at,cwd},activity(row,phase),at);
    fleetIds.add(node.id+'\n'+row.id);if(row.thread_id)fleetThreads.add(node.id+'\n'+row.thread_id);
  }
  for(const row of desktop) {
    const node=nodeMap.get(row.node);if(!node||fleetThreads.has(row.node+'\n'+row.thread_id)||(row.fleet_task_id&&fleetIds.has(row.node+'\n'+row.fleet_task_id)))continue;
    const at=row.last_activity_at||row.updated_at,message=parse(row.latestMessage);add(node,row.project,null,row.cwd,{kind:'desktop',id:row.thread_id,threadId:row.thread_id,nodeId:node.id,title:row.title,status:'running',phase:'running',evidence:'app_server_runtime',updatedAt:at,cwd:row.cwd},message?.text?`${message.role==='user'?'用户':'Codex'}：${message.text}`:'最新对话待同步',message?.at||null);
  }
  return [...groups.values()].sort((a,b)=>a.nodeName.localeCompare(b.nodeName,undefined,{numeric:true})||(b.latestActivityAt||'').localeCompare(a.latestActivityAt||'')||a.id.localeCompare(b.id));
}
