import {visibleItem,visibleDirectory,visibleDesktop,consoleView} from './console-cleanup.mjs';
import {assert,now,json,parse,hash,canonical,validId,uid,validProject} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {can,writer} from './auth.mjs';
import {nodeScope,assertNodeAccess} from './access.mjs';

const scoped=n=>!n.admin&&(!n.browser||n.kind==='device');
const rootKey=root=>root.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
function text(value,key,max,{required=false}={}) {
  if(value===undefined||value===null){assert(!required,`${key} required`);return null;}
  assert(typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0)&&!value.includes('\u0000'),`Invalid workspace ${key}`);return value.trim();
}
function rootPath(value) {
  const root=text(value,'path',2000,{required:true});assert(/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(root)&&!root.split(/[\\/]/).includes('..'),'Workspace path must be absolute');return root;
}
function view(row) {
  return {id:row.id,nodeId:row.node,nodeName:row.node_name||row.node,project:row.project,name:row.name,root:row.root,path:row.root,
    source:row.source,sourceThreadId:row.source_thread_id,sourceProjectId:row.source_project_id,autoImported:!!row.auto_imported,controllerThreadId:row.controller_thread_id,automationNote:row.automation_note,
    status:row.status,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function workspaceAccess(db,n,id) {
  assert(validId(id),'Invalid workspace ID');const row=await first(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE w.id=? AND n.revoked=0',id);
  assert(row,'Workspace not found',404);assert(can(n,row.project),'Project access denied',403);await assertNodeAccess(db,n,row.node);return row;
}
export async function validateTaskWorkspace(db,n,spec) {
  if(!spec.workspaceId)return null;const w=await workspaceAccess(db,n,spec.workspaceId);
  assert(w.node===spec.targetNode&&w.project===spec.project,'Workspace belongs to another target or project',403);
  assert(w.status==='ready'&&w.root,'Workspace is not ready on the target computer',409,'WORKSPACE_NOT_READY');
  return w;
}
export async function listWorkspaces(db,n,url) {
  const nodeId=url.searchParams.get('nodeId')||url.searchParams.get('node');if(nodeId)assert(validId(nodeId),'Invalid node ID');
  const filters=['n.revoked=0',nodeScope(n,'w.node')],args=[];if(consoleView(n))filters.push(visibleItem('workspace','w.id'),visibleDirectory('w.node','w.root'));
  if(scoped(n)){filters.push('w.project IN (SELECT value FROM json_each(?))');args.push(n.projects);}
  if(nodeId){filters.push('w.node=?');args.push(nodeId);}
  const rows=await all(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE '+filters.join(' AND ')+' ORDER BY n.name,w.name,w.id',...args);
  const where=['n.revoked=0',nodeScope(n,'t.node'),"length(t.cwd)>0"],values=[];if(consoleView(n))where.push(visibleDesktop('t'));
  if(scoped(n)){where.push('t.project IN (SELECT value FROM json_each(?))');values.push(n.projects);}
  if(nodeId){where.push('t.node=?');values.push(nodeId);}
  const discovered=await all(db,`SELECT * FROM (SELECT t.node AS nodeId,n.name AS nodeName,t.project,t.cwd AS root,t.thread_id AS sourceThreadId,t.updated_at AS updatedAt,
    COUNT(*) OVER(PARTITION BY t.node,t.project,lower(rtrim(replace(t.cwd,char(92),'/'),'/'))) AS threadCount,
    ROW_NUMBER() OVER(PARTITION BY t.node,t.project,lower(rtrim(replace(t.cwd,char(92),'/'),'/')) ORDER BY t.updated_at DESC,t.thread_id) AS rank
    FROM desktop_threads t JOIN nodes n ON n.id=t.node WHERE ${where.join(' AND ')}) WHERE rank=1 ORDER BY nodeName,updatedAt DESC LIMIT 1001`,...values);
  const existing=new Set(rows.filter(r=>r.root).map(r=>r.node+':'+r.root_key));
  return {workspaces:rows.map(view),discovered:discovered.slice(0,1000).filter(r=>!existing.has(r.nodeId+':'+rootKey(r.root))).map(({rank,...r})=>({...r,path:r.root,name:r.root.replace(/[\\/]$/,'').split(/[\\/]/).at(-1)||r.root})),discoveredHasMore:discovered.length>1000,serverTime:now()};
}
export async function createWorkspace(db,n,b) {
  writer(n);await assertNodeAccess(db,n,b.nodeId);
  assert(validId(b.nodeId),'Invalid node ID');assert(b.root===undefined&&b.path===undefined,'Choose an observed project or let the device create its own directory');
  const target=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',b.nodeId);assert(target,'Unknown target node',404);
  const name=text(b.name,'name',160,{required:true}),automationNote=text(b.automationNote,'automation note',8000)||'',id=b.id||uid();assert(validId(id),'Invalid workspace ID');
  let project=b.project||'workspace',root=null,source='created',sourceThreadId=null;
  if(b.sourceThreadId) {
    assert(validId(b.sourceThreadId),'Invalid source thread ID');const sourceThread=await first(db,'SELECT * FROM desktop_threads WHERE node=? AND thread_id=?',b.nodeId,b.sourceThreadId);
    assert(sourceThread,'Source desktop task not found',404);project=sourceThread.project;assert(can(n,project),'Project access denied',403);root=rootPath(sourceThread.cwd);source='discovered';sourceThreadId=b.sourceThreadId;
  }
  assert(validProject(project)&&can(n,project)&&parse(target.projects).includes(project),'Project access denied',403);
  const fingerprint=hash(canonical({nodeId:b.nodeId,project,name,sourceThreadId,automationNote})),old=await first(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE w.id=?',id);
  if(old){assert(old.creator===n.id&&old.create_hash===fingerprint,'Workspace ID already used with a different request',409);return view(old);}
  if(root){const duplicate=await first(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE w.node=? AND w.root_key=?',b.nodeId,rootKey(root));if(duplicate){assert(can(n,duplicate.project),'Project access denied',403);return view(duplicate);}}
  const ts=now();await run(db,"INSERT OR IGNORE INTO project_workspaces(id,node,project,name,root,root_key,source,source_thread_id,controller_thread_id,automation_note,status,creator,create_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",id,b.nodeId,project,name,root,root?rootKey(root):null,source,sourceThreadId,sourceThreadId,automationNote,n.id,fingerprint,ts,ts);
  let saved=await first(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE w.id=?',id);
  if(!saved&&root)saved=await first(db,'SELECT w.*,COALESCE(n.display_name,n.name) AS node_name FROM project_workspaces w JOIN nodes n ON n.id=w.node WHERE w.node=? AND w.root_key=?',b.nodeId,rootKey(root));
  assert(saved&&can(n,saved.project),'Workspace was created concurrently with a conflicting request',409);assert(saved.id!==id||(saved.creator===n.id&&saved.create_hash===fingerprint),'Workspace ID conflict',409);return view(saved);
}
// Device credentials may attest only their own local catalog. Browser roles,
// even administrators, cannot introduce arbitrary paths through this endpoint.
export async function syncWorkspaceCatalog(db,n,b) {
  assert(!n.browser&&!n.admin&&n.role==='node','Execution node identity required',403);
  assert(b.nodeId===undefined&&Array.isArray(b.workspaces)&&b.workspaces.length<=40,'Invalid workspace catalog');
  const entries=b.workspaces.map(item=>{
    assert(validId(item.id)&&validProject(item.project)&&can(n,item.project),'Invalid workspace or project access',403);
    assert(['registered','configured','discovered'].includes(item.source),'Invalid workspace source');
    const root=rootPath(item.root),name=text(item.name,'name',160,{required:true});
    const sourceProjectId=item.source==='registered'?text(item.sourceProjectId,'Codex project ID',300,{required:true}):null;
    const sourceThreadId=item.source==='discovered'?item.sourceThreadId:null;if(item.source==='discovered')assert(validId(sourceThreadId),'Invalid source thread ID');
    return {id:item.id,project:item.project,source:item.source,root,rootKey:rootKey(root),name,sourceProjectId,sourceThreadId,createHash:hash(canonical({node:n.id,root:rootKey(root),project:item.project}))};
  });
  assert(new Set(entries.map(x=>x.id)).size===entries.length&&new Set(entries.map(x=>x.rootKey)).size===entries.length,'Duplicate catalog entries');
  if(!entries.length)return {workspaces:[],serverTime:now()};
  const data=json(entries),old=await all(db,"SELECT * FROM project_workspaces WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) OR (node=? AND root_key IN(SELECT json_extract(value,'$.rootKey') FROM json_each(?)))",data,n.id,data);
  for(const item of entries)for(const row of old.filter(r=>r.id===item.id||(r.node===n.id&&r.root_key===item.rootKey)))assert(row.node===n.id&&row.root_key===item.rootKey&&row.project===item.project&&can(n,row.project),'Workspace identity or project conflict',409);
  const ts=now();
  // A bounded number of D1 calls even on a computer with hundreds of projects.
  await batch(db,[
    ["INSERT OR IGNORE INTO project_workspaces(id,node,project,name,root,root_key,source,source_thread_id,source_project_id,auto_imported,controller_thread_id,automation_note,status,creator,create_hash,created_at,updated_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.project'),json_extract(value,'$.name'),json_extract(value,'$.root'),json_extract(value,'$.rootKey'),json_extract(value,'$.source'),json_extract(value,'$.sourceThreadId'),json_extract(value,'$.sourceProjectId'),1,NULL,'','ready',?,json_extract(value,'$.createHash'),?,? FROM json_each(?)",n.id,n.id,ts,ts,data],
    ["UPDATE project_workspaces AS w SET source=j.source,source_thread_id=j.thread,source_project_id=j.codexProject,status='ready',error=NULL,updated_at=? FROM (SELECT json_extract(value,'$.rootKey') AS rootKey,json_extract(value,'$.project') AS project,json_extract(value,'$.source') AS source,json_extract(value,'$.sourceThreadId') AS thread,json_extract(value,'$.sourceProjectId') AS codexProject FROM json_each(?)) j WHERE w.node=? AND w.root_key=j.rootKey AND w.project=j.project AND w.auto_imported=1 AND (w.source IS NOT j.source OR w.source_thread_id IS NOT j.thread OR w.source_project_id IS NOT j.codexProject OR w.status!='ready')",ts,data,n.id]
  ]);
  const saved=await all(db,"SELECT * FROM project_workspaces WHERE node=? AND root_key IN(SELECT json_extract(value,'$.rootKey') FROM json_each(?))",n.id,data);
  assert(saved.length===entries.length,'Workspace catalog ID conflict',409);const byRoot=new Map(saved.map(r=>[r.root_key,r]));return {workspaces:entries.map(item=>view(byRoot.get(item.rootKey))),serverTime:ts};
}
export async function workspaceThreads(db,n,id) {
  const w=await workspaceAccess(db,n,id);if(!w.root)return {threads:[],controllerThreadId:w.controller_thread_id};
  const rows=await all(db,`SELECT node AS nodeId,thread_id AS threadId,title,preview,cwd,project,archived,status,status_source AS statusSource,updated_at AS updatedAt,observed_at AS observedAt FROM desktop_threads WHERE node=? AND project=? AND lower(rtrim(replace(cwd,char(92),'/'),'/'))=? ORDER BY updated_at DESC,thread_id LIMIT 100`,w.node,w.project,w.root_key);
  return {threads:rows.map(r=>({...r,archived:!!r.archived,nodeName:w.node_name})),controllerThreadId:w.controller_thread_id};
}
export async function updateWorkspace(db,n,id,b) {
  writer(n);const w=await workspaceAccess(db,n,id);assert(n.browser||n.admin,'Use the website or an authorized controller to edit a project',403);
  assert(b.root===undefined&&b.path===undefined&&b.nodeId===undefined&&b.project===undefined,'Workspace identity and directory are immutable');
  const name=b.name===undefined?w.name:text(b.name,'name',160,{required:true}),note=b.automationNote===undefined?w.automation_note:text(b.automationNote,'automation note',8000)||'';
  let controller=w.controller_thread_id;
  if(b.controllerThreadId!==undefined) {
    controller=b.controllerThreadId;if(controller!==null){assert(validId(controller),'Invalid controller thread ID');const row=await first(db,'SELECT project,cwd FROM desktop_threads WHERE node=? AND thread_id=?',w.node,controller);assert(row&&row.project===w.project&&w.root&&rootKey(row.cwd)===w.root_key,'Controller must be an observed thread in this project on this computer',403);}
  }
  await run(db,'UPDATE project_workspaces SET name=?,automation_note=?,controller_thread_id=?,updated_at=? WHERE id=?',name,note,controller,now(),id);return view(await workspaceAccess(db,n,id));
}
export async function acknowledgeWorkspace(db,n,id,b) {
  const w=await workspaceAccess(db,n,id);assert(!n.browser&&!n.admin&&n.id===w.node,'Workspace execution node required',403);
  assert(['ready','error'].includes(b.status),'Invalid workspace state');
  if(b.status==='error'){const error=text(b.error,'error',2000,{required:true});await run(db,"UPDATE project_workspaces SET status='error',error=?,updated_at=? WHERE id=?",error,now(),id);return view(await workspaceAccess(db,n,id));}
  const root=rootPath(b.root);if(w.root)assert(rootKey(root)===w.root_key,'Workspace directory cannot be changed',409);
  const duplicate=await first(db,'SELECT id FROM project_workspaces WHERE node=? AND root_key=? AND id!=?',n.id,rootKey(root),id);assert(!duplicate,'This device directory is already registered',409);
  await run(db,"UPDATE project_workspaces SET root=?,root_key=?,status='ready',error=NULL,updated_at=? WHERE id=?",root,rootKey(root),now(),id);return view(await workspaceAccess(db,n,id));
}
