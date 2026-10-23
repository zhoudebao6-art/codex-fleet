import {assert,validId,validProject,uid,now,parse,json,hash,canonical} from './util.mjs';
import {first,all,run} from './db.mjs';
import {admin} from './auth.mjs';

const ACTIVE="'queued','downloading','waiting','installing'";
const rank={queued:0,downloading:1,waiting:2,installing:3,completed:4,failed:4};
function fields(body,allowed){assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>allowed.includes(k)),'Unsupported upgrade field');}
function nodeOnly(actor){assert(!actor.browser&&!actor.admin,'Node token required',403);}
function view(row){const installer=parse(row.installer);return {id:row.id,nodeId:row.node,action:'upgrade',status:row.status,installer,downloadPath:'/v1/files/'+installer.sha256+'?project='+encodeURIComponent(installer.project),bytes:row.bytes,detail:row.detail,version:row.reported_version,packageSha256:row.package_sha256,createdAt:row.created_at,updatedAt:row.updated_at};}

export async function createUpgrade(db,actor,nodeId,body) {
  admin(actor);fields(body,['id']);assert(validId(nodeId),'Invalid device ID');const id=body.id||uid();assert(validId(id),'Invalid upgrade action ID');
  const existing=await first(db,'SELECT * FROM node_actions WHERE id=?',id);if(existing){assert(existing.node===nodeId,'Upgrade action ID belongs to another computer',409);return view(existing);}
  const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',nodeId);assert(node,'Device not found',404);assert(parse(node.capabilities)?.selfUpgrade===true,'This adapter needs its first local upgrade before website upgrades are available',409,'NODE_UPGRADE_BOOTSTRAP_REQUIRED');
  const setting=await first(db,"SELECT value FROM settings WHERE key='installer'");assert(setting,'No installer is registered',409);const candidate=parse(setting.value);
  assert(candidate&&validProject(candidate.project)&&parse(node.projects).includes(candidate.project),'Installer project is not authorized on the target device',403);
  assert(/^[a-f0-9]{64}$/.test(candidate.sha256)&&typeof candidate.version==='string'&&/^\d+\.\d+\.\d+$/.test(candidate.version)&&typeof candidate.name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.zip$/.test(candidate.name)&&Number.isSafeInteger(candidate.size)&&candidate.size>0&&candidate.size<=1024*1024*1024,'Registered installer is not supported by the automatic updater',409);
  const file=await first(db,"SELECT name,size FROM files WHERE project=? AND sha=? AND status='complete'",candidate.project,candidate.sha256);assert(file&&file.size===candidate.size&&file.name.split(/[\\/]/).pop()===candidate.name,'Registered installer is unavailable or does not match its verified file',409);
  const installer={sha256:candidate.sha256,size:candidate.size,version:candidate.version,name:candidate.name,project:candidate.project},ts=now();
  await run(db,`INSERT OR IGNORE INTO node_actions(id,node,action,installer,status,creator,created_at,updated_at) SELECT ?,?,'upgrade',?,'queued',?,?,? WHERE NOT EXISTS(SELECT 1 FROM node_actions WHERE node=? AND status IN(${ACTIVE}))`,id,nodeId,json(installer),actor.id,ts,ts,nodeId);
  const saved=await first(db,'SELECT * FROM node_actions WHERE id=?',id);assert(saved&&saved.node===nodeId,'This computer already has an active upgrade action',409,'NODE_UPGRADE_IN_PROGRESS');return view(saved);
}
export async function listNodeActions(db,actor,nodeId=null) {
  if(nodeId){admin(actor);assert(validId(nodeId),'Invalid device ID');assert(await first(db,'SELECT id FROM nodes WHERE id=?',nodeId),'Device not found',404);}
  else {nodeOnly(actor);nodeId=actor.id;}
  const rows=await all(db,'SELECT * FROM node_actions WHERE node=?'+(actor.admin?'':` AND status IN(${ACTIVE})`)+' ORDER BY created_at DESC,id DESC LIMIT ?',nodeId,actor.admin?20:10);return {actions:rows.map(view),serverTime:now()};
}
export async function acknowledgeNodeAction(db,actor,id,body) {
  nodeOnly(actor);fields(body,['status','bytes','detail','version','packageSha256']);assert(validId(id),'Invalid action ID');const old=await first(db,'SELECT * FROM node_actions WHERE id=?',id);assert(old&&old.node===actor.id,'Upgrade action not found',404);
  assert(['downloading','waiting','installing','completed','failed'].includes(body.status),'Invalid upgrade status');const installer=parse(old.installer),bytes=body.bytes??old.bytes;
  assert(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=installer.size,'Invalid upgrade progress');assert(body.detail===undefined||body.detail===null||(typeof body.detail==='string'&&body.detail.length<=2000),'Invalid upgrade detail');
  assert(body.version===undefined||(typeof body.version==='string'&&/^[\w.-]{1,80}$/.test(body.version)),'Invalid reported version');assert(body.packageSha256===undefined||body.packageSha256===installer.sha256,'Upgrade package checksum mismatch',409);
  if(['waiting','installing','completed'].includes(body.status))assert(body.packageSha256===installer.sha256,'Verified package checksum is required',409);
  if(body.status==='completed')assert(body.version===installer.version,'Installed version does not match the selected release',409);
  const normalized={status:body.status,bytes,detail:body.detail??null,version:body.version??null,packageSha256:body.packageSha256??null},digest=hash(canonical(normalized));
  if(['completed','failed'].includes(old.status)){assert(old.status===body.status&&old.ack_hash===digest,'Upgrade action is already terminal',409);return view(old);}
  if(rank[body.status]<rank[old.status]&&bytes<=old.bytes)return view(old);
  assert(bytes>=old.bytes,'Upgrade progress cannot move backwards',409);
  const result=await run(db,`UPDATE node_actions SET status=?,bytes=?,detail=?,reported_version=COALESCE(?,reported_version),package_sha256=COALESCE(?,package_sha256),ack_hash=?,updated_at=? WHERE id=? AND node=? AND status=? AND bytes=?`,body.status,bytes,normalized.detail,normalized.version,normalized.packageSha256,digest,now(),id,actor.id,old.status,old.bytes);
  if(result.meta.changes!==1){const saved=await first(db,'SELECT * FROM node_actions WHERE id=?',id);assert(saved?.ack_hash===digest,'Upgrade action changed; refresh before acknowledging',409);return view(saved);}
  return view(await first(db,'SELECT * FROM node_actions WHERE id=?',id));
}
