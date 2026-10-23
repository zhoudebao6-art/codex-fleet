import {all,first,batch} from './db.mjs';
import {admin} from './auth.mjs';
import {assert,now,json,parse,hash,canonical,validId} from './util.mjs';
import {directoryKey,sqlDirectory} from './project-paths.mjs';

// Presentation tombstones survive node inventory upserts. Execution, artifacts,
// credentials and original desktop archives are never changed by console cleanup.
const PREFIX='console_hidden:';
const recordKey=id=>'console_cleanup:'+id;
export const visibleItem=(kind,expression)=>`NOT EXISTS(SELECT 1 FROM settings ch WHERE ch.key='${PREFIX}${kind}:'||${expression})`;
export const visibleDirectory=(node,root)=>visibleItem('directory',`${node}||':'||${sqlDirectory(root)}`);
export const visibleDesktop=(alias='t')=>`(${visibleItem('desktop',`${alias}.node||':'||${alias}.thread_id`)} AND ${visibleDirectory(alias+'.node',alias+'.cwd')} AND NOT EXISTS(SELECT 1 FROM tasks cf JOIN settings ch ON ch.key='${PREFIX}task:'||cf.id WHERE cf.target=${alias}.node AND (cf.thread_id=${alias}.thread_id OR cf.id=${alias}.fleet_task_id)))`;
export const consoleView=n=>n.browser||n.admin;
const stoppedTask=`status IN('accepted','submitted','failed','blocked','cancelled') AND COALESCE(json_extract(result,'$.desktop.state'),'')<>'uncertain'`;
const stoppedDesktop=`NOT(status IN('running','waiting') AND status_source='app_server_runtime' AND julianday(observed_at)>julianday('now','-2 minutes'))`;

function resolve(records,item){
  assert(item&&['task','workspace','desktop','directory','file','automation'].includes(item.kind),'Invalid cleanup item');
  const kind=item.kind;let row,key,label,guard,args=[];
  if(kind==='directory'){
    assert(validId(item.nodeId)&&typeof item.root==='string'&&item.root.length<=2000,'Invalid directory');
    const root=directoryKey(item.root);assert(root.length>3,'Invalid directory');
    row=records.directory?.find(r=>r.node===item.nodeId&&directoryKey(r.cwd)===root);assert(row,'Observed directory not found',404);
    key=PREFIX+kind+':'+item.nodeId+':'+root;label=row.cwd;
    guard=`NOT EXISTS(SELECT 1 FROM desktop_threads WHERE node=? AND ${sqlDirectory('cwd')}=? AND NOT(${stoppedDesktop})) AND NOT EXISTS(SELECT 1 FROM project_workspaces w JOIN tasks t ON json_extract(t.spec,'$.workspaceId')=w.id WHERE w.node=? AND w.root_key=? AND t.status NOT IN('accepted','submitted','failed','blocked','cancelled'))`;args=[item.nodeId,root,item.nodeId,root];
  }else{
    assert(validId(item.id),'Invalid cleanup ID');
    if(kind==='task'){row=records.task?.find(r=>r.id===item.id);label=row?parse(row.spec).prompt?.slice(0,160):'';guard=`EXISTS(SELECT 1 FROM tasks WHERE id=? AND ${stoppedTask})`;args=[item.id];}
    if(kind==='workspace'){row=records.workspace?.find(r=>r.id===item.id);label=row?.name;guard="NOT EXISTS(SELECT 1 FROM tasks WHERE json_extract(spec,'$.workspaceId')=? AND status NOT IN('accepted','submitted','failed','blocked','cancelled')) AND NOT EXISTS(SELECT 1 FROM desktop_threads WHERE node=? AND "+sqlDirectory('cwd')+`=? AND NOT(${stoppedDesktop}))`;args=[item.id,row?.node||'',row?.root_key||''];}
    if(kind==='desktop'){assert(validId(item.nodeId),'Invalid node ID');row=records.desktop?.find(r=>r.node===item.nodeId&&r.thread_id===item.id);label=row?.title;guard=`EXISTS(SELECT 1 FROM desktop_threads WHERE node=? AND thread_id=? AND ${stoppedDesktop})`;args=[item.nodeId,item.id];}
    if(kind==='file'){row=records.file?.find(r=>r.id===item.id);label=row?.name;guard="NOT EXISTS(SELECT 1 FROM tasks t, json_each(t.spec,'$.inputs') i WHERE t.project=? AND json_extract(i.value,'$.sha')=? AND t.status NOT IN('accepted','submitted','failed','blocked','cancelled'))";args=[row?.project||'',row?.sha||''];}
    if(kind==='automation'){row=records.automation?.find(r=>r.id===item.id);label=row?.name;guard="EXISTS(SELECT 1 FROM automation_flows WHERE id=? AND status IN('completed','cancelled'))";args=[item.id];}
    assert(row,'Cleanup item not found',404);key=PREFIX+kind+':'+(kind==='desktop'?item.nodeId+':':'')+item.id;
  }
  guard="("+guard+") AND NOT EXISTS(SELECT 1 FROM settings WHERE key=?)";args.push(key);
  return {key,label,kind,guard,args,item};
}
export async function cleanupConsole(db,n,b){
  admin(n);assert(validId(b.id)&&typeof b.label==='string'&&b.label.trim().length>0&&b.label.length<=120,'Cleanup ID and label required');
  assert(Array.isArray(b.items)&&b.items.length>0&&b.items.length<=200,'Choose 1-200 cleanup items');
  const digest=hash(canonical({label:b.label,items:b.items})),old=await first(db,'SELECT value FROM settings WHERE key=?',recordKey(b.id));
  if(old){const r=parse(old.value);assert(r.digest===digest,'Cleanup ID conflict',409);return r;}
  // At most six metadata reads, regardless of item count. Per-item database
  // calls can exceed the hosted Worker's subrequest budget on larger cleanups.
  const records={};
  const sources={task:'tasks',workspace:'project_workspaces',file:'files',automation:'automation_flows'};
  for(const kind of new Set(b.items.map(i=>i?.kind))){
    assert(['task','workspace','desktop','directory','file','automation'].includes(kind),'Invalid cleanup item');
    const selected=b.items.filter(i=>i.kind===kind);
    if(kind==='directory')records[kind]=await all(db,`SELECT DISTINCT t.node,t.thread_id,t.cwd,t.title FROM desktop_threads t JOIN json_each(?) i ON t.node=json_extract(i.value,'$.nodeId') AND ${sqlDirectory('t.cwd')}=json_extract(i.value,'$.root')`,json(selected.map(i=>({nodeId:i.nodeId,root:directoryKey(typeof i.root==='string'?i.root:'')}))));
    else if(kind==='desktop')records[kind]=await all(db,"SELECT t.node,t.thread_id,t.title FROM desktop_threads t JOIN json_each(?) i ON t.node=json_extract(i.value,'$.nodeId') AND t.thread_id=json_extract(i.value,'$.id')",json(selected));
    else records[kind]=await all(db,`SELECT * FROM ${sources[kind]} WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,json(selected));
  }
  const items=b.items.map(item=>resolve(records,item));assert(new Set(items.map(i=>i.key)).size===items.length,'Duplicate cleanup item');
  const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
  const conditions=items.map(i=>{let index=0;return '('+i.guard.replace(/\?/g,()=>quote(i.args[index++]))+')';});
  // Production D1 limits expression depth to 100. A linear AND chain grows
  // with the batch; a balanced tree keeps the same atomic guards at log2 depth.
  const combine=parts=>parts.length===1?parts[0]:'('+combine(parts.slice(0,Math.floor(parts.length/2)))+' AND '+combine(parts.slice(Math.floor(parts.length/2)))+')';
  const guards=combine(conditions);
  const record={id:b.id,label:b.label,createdAt:now(),createdBy:n.id,status:'cleaned',digest,items:items.map(({key,label,kind,item})=>({key,label,kind,item}))};
  const commands=[['INSERT OR IGNORE INTO settings(key,value) SELECT ?,? WHERE '+guards,recordKey(b.id),json(record)]];
  commands.push(['INSERT OR IGNORE INTO settings(key,value) SELECT json_extract(i.value,\'$.key\'),? FROM json_each(?) i WHERE EXISTS(SELECT 1 FROM settings WHERE key=? AND json_extract(value,\'$.digest\')=? AND json_extract(value,\'$.status\')=\'cleaned\')',json({batchId:b.id,createdAt:record.createdAt}),json(items.map(i=>({key:i.key}))),recordKey(b.id),digest]);
  await batch(db,commands);const saved=await first(db,'SELECT value FROM settings WHERE key=?',recordKey(b.id));assert(saved,'状态已变化，未清理任何记录。请刷新重试。',409);assert(parse(saved.value).digest===digest,'Cleanup ID conflict',409);return parse(saved.value);
}
export async function cleanupHistory(db,n){admin(n);const rows=await all(db,"SELECT value FROM settings WHERE key LIKE 'console_cleanup:%' ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 100");return {records:rows.map(r=>{const v=parse(r.value);return {...v,items:v.items.map(({key,...i})=>i),digest:undefined};})};}
export async function restoreCleanup(db,n,id){admin(n);assert(validId(id),'Invalid cleanup ID');const r=await first(db,'SELECT value FROM settings WHERE key=?',recordKey(id));assert(r,'Cleanup record not found',404);const record=parse(r.value);if(record.status==='restored')return {ok:true};await batch(db,[["DELETE FROM settings WHERE key IN(SELECT json_extract(i.value,'$.key') FROM json_each(?) i) AND json_extract(value,'$.batchId')=?",json(record.items.map(i=>({key:i.key}))),id],["UPDATE settings SET value=json_set(value,'$.status','restored','$.restoredAt',?) WHERE key=?",now(),recordKey(id)]]);return {ok:true};}
