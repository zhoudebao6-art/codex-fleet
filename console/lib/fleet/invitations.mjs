import {assert,uid,secret,hash,equal,now,json,parse,validId,validProject} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {admin} from './auth.mjs';
import {readAccess,validateAccess} from './access.mjs';
import {validateDisplayGroup,validateDisplayName} from './device-management.mjs';
import {desktopLaunchIssue} from './runtime-readiness.mjs';

const STATES=['all','pending','enrolled','expired','revoked'];
const statusSql="CASE WHEN i.used_by IS NOT NULL THEN 'enrolled' WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.expires<=? THEN 'expired' ELSE 'pending' END";
const selectSql=`SELECT i.*,g.name AS group_name,n.id AS node_id,n.name AS node_name,n.display_name AS node_display_name,n.display_group_id AS node_group_id,ng.name AS node_group_name,n.last_seen AS node_last_seen,n.revoked AS node_revoked,n.capabilities AS node_capabilities FROM invites i LEFT JOIN device_groups g ON g.id=i.display_group_id LEFT JOIN nodes n ON n.id=i.used_by LEFT JOIN device_groups ng ON ng.id=n.display_group_id`;
function view(row,ts=now()) {
  const capabilities=row.node_capabilities?parse(row.node_capabilities):{};
  const desktopIssue=desktopLaunchIssue(capabilities);
  const codexReady=['ready','blocked','checking'].includes(capabilities.executorState)?capabilities.executorState==='ready':typeof capabilities.ready==='boolean'?capabilities.ready:null;
  return {id:row.id,name:row.name,displayName:row.display_name||row.name,groupId:row.display_group_id||null,groupName:row.group_name||null,projects:parse(row.projects),accountGroup:row.account_group,
    createdAt:row.created_at||null,expires:row.expires,usedAt:row.used_at||null,revokedAt:row.revoked_at||null,usedBy:row.used_by||null,
    status:row.used_by?'enrolled':row.revoked_at?'revoked':row.expires<=ts?'expired':'pending',consoleRole:row.console_role==='viewer'?'viewer':'operator',consoleAccess:readAccess(row.console_access),
    node:row.node_id?{id:row.node_id,name:row.node_name,code:row.node_name,displayName:row.node_display_name||row.node_name,groupId:row.node_group_id||null,groupName:row.node_group_name||null,online:!row.node_revoked&&!!row.node_last_seen&&Date.parse(ts)-Date.parse(row.node_last_seen)<60000,lastSeen:row.node_last_seen,revoked:!!row.node_revoked,version:typeof capabilities.version==='string'?capabilities.version:null,codexReady,desktopIssue,desktopLinked:capabilities.desktopSessionBridge===true&&capabilities.execution==='desktop-shared-app-server',workspaceState:capabilities.workspaceCatalog?.state||null,workspaceCount:Number.isSafeInteger(capabilities.workspaceCatalog?.count)?capabilities.workspaceCatalog.count:null}:null};
}

export async function invitationDetail(db,actor,id) {
  admin(actor);assert(validId(id),'Invalid invitation ID');const row=await first(db,selectSql+' WHERE i.id=?',id);assert(row,'Invitation not found',404);return view(row);
}

export async function listInvitations(db,actor,url) {
  admin(actor);const status=url.searchParams.get('status')||'all',limit=Number(url.searchParams.get('limit')||50),ts=now();
  assert(STATES.includes(status),'Invalid invitation status');assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Invalid invitation page size');
  const where=[],args=[];if(status!=='all'){where.push(statusSql+'=?');args.push(ts,status);}
  const countWhere=where.length?' WHERE '+where.join(' AND '):'',countArgs=[...args],raw=url.searchParams.get('cursor');
  if(raw){let cursor;assert(raw.length<=1000,'Invalid invitation cursor');try{cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{assert(false,'Invalid invitation cursor');}
    assert(cursor&&cursor.status===status&&validId(cursor.id)&&typeof cursor.createdAt==='string'&&(cursor.createdAt===''||Number.isFinite(Date.parse(cursor.createdAt))),'Invalid invitation cursor');
    where.push("(COALESCE(i.created_at,'')<? OR (COALESCE(i.created_at,'')=? AND i.id<?))");args.push(cursor.createdAt,cursor.createdAt,cursor.id);
  }
  const rows=await all(db,selectSql+(where.length?' WHERE '+where.join(' AND '):'')+" ORDER BY COALESCE(i.created_at,'') DESC,i.id DESC LIMIT ?",...args,limit+1);
  const hasMore=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1),count=await first(db,'SELECT count(*) AS total FROM invites i'+countWhere,...countArgs);
  const reserved=await all(db,'SELECT name FROM nodes UNION SELECT name FROM invites WHERE used_by IS NULL AND revoked_at IS NULL AND expires>?',ts),codes=new Set(reserved.map(r=>r.name.toUpperCase()));
  let number=1;while(codes.has('PC-'+String(number).padStart(2,'0')))number++;
  return {invites:page.map(r=>view(r,ts)),nextCursor:hasMore?Buffer.from(json({status,createdAt:last.created_at||'',id:last.id})).toString('base64url'):null,total:count.total,suggestedCode:'PC-'+String(number).padStart(2,'0')};
}

export async function createInvitation(db,actor,b,origin) {
  admin(actor);assert(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).every(k=>['name','displayName','projects','accountGroup','groupId','hours','consoleRole','consoleAccess'].includes(k)),'Unsupported invitation field');
  assert(typeof b.name==='string'&&/^[\w-]{1,60}$/.test(b.name)&&Array.isArray(b.projects)&&b.projects.length>0&&b.projects.length<=50&&b.projects.every(validProject),'Invalid node name or projects');
  assert(!b.accountGroup||(typeof b.accountGroup==='string'&&/^[\w-]{1,80}$/.test(b.accountGroup)),'Invalid account group');
  const displayName=validateDisplayName(b.displayName),groupId=await validateDisplayGroup(db,b.groupId),hours=b.hours??24,consoleRole=b.consoleRole??'operator',consoleAccess=await validateAccess(db,b.consoleAccess);
  assert(['operator','viewer'].includes(consoleRole),'Invalid device console role');assert(Number.isFinite(hours)&&hours>0&&hours<=168,'Invitation duration must be 0-168 hours');
  const id=uid(),token=secret(),ts=now(),expires=new Date(Date.parse(ts)+hours*3600000).toISOString(),projects=[...new Set(b.projects)],accountGroup=b.accountGroup||'shared-default';
  // Validation and uniqueness also live in the write. Two requests that passed
  // the same earlier validation cannot create two active invitations or retain
  // a group deleted before this statement commits.
  const saved=await run(db,`INSERT INTO invites(id,token_hash,name,projects,account_group,expires,display_group_id,display_name,created_at,console_role,console_access)
    SELECT ?,?,?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE name=? COLLATE NOCASE)
      AND NOT EXISTS(SELECT 1 FROM invites WHERE name=? COLLATE NOCASE AND used_by IS NULL AND revoked_at IS NULL AND expires>?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM device_groups WHERE id=?))
      AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.groupIds') a WHERE a.value!='__ungrouped__' AND NOT EXISTS(SELECT 1 FROM device_groups g WHERE g.id=a.value))`,id,hash(token),b.name,json(projects),accountGroup,expires,groupId,displayName,ts,consoleRole,json(consoleAccess),b.name,b.name,ts,groupId,groupId,json(consoleAccess));
  if(saved.meta.changes!==1){
    assert(!await first(db,'SELECT id FROM nodes WHERE name=? COLLATE NOCASE',b.name),'Node name already exists',409,'NODE_NAME_EXISTS');
    assert(!await first(db,'SELECT id FROM invites WHERE name=? COLLATE NOCASE AND used_by IS NULL AND revoked_at IS NULL AND expires>?',b.name,ts),'A pending invitation already uses this device code',409,'INVITATION_PENDING_EXISTS');
    assert(false,'A selected group changed before the invitation was created',409,'INVITATION_GROUP_CHANGED');
  }
  return {id,token,hubUrl:origin,name:b.name,displayName:displayName||b.name,projects,accountGroup,groupId,expires,createdAt:ts,consoleRole,consoleAccess};
}

export async function revokeInvitation(db,actor,id) {
  admin(actor);assert(validId(id),'Invalid invitation ID');
  await run(db,'UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND used_by IS NULL',now(),id);
  const item=await invitationDetail(db,actor,id);assert(!item.usedBy,'An enrolled invitation cannot be revoked; manage the device instead',409,'INVITATION_ALREADY_USED');return item;
}

async function groupSalt(db){await run(db,'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)','group_salt',secret());return (await first(db,'SELECT value FROM settings WHERE key=?','group_salt')).value;}
async function enrolledView(db,node){return {nodeId:node.id,name:node.name,projects:parse(node.projects),accountGroup:node.account_group,groupSalt:await groupSalt(db)};}

export async function enrollInvitation(db,b) {
  assert(b&&typeof b.token==='string'&&b.token.length>=40&&b.token.length<=200&&typeof b.nodeToken==='string'&&b.nodeToken.length>=40&&b.nodeToken.length<=200&&typeof b.nodeId==='string'&&/^[\w-]{20,80}$/.test(b.nodeId),'Invalid enrollment');
  const inv=await first(db,'SELECT * FROM invites WHERE token_hash=?',hash(b.token));assert(inv,'Invalid invitation',403);const tokenHash=hash(b.nodeToken);
  if(inv.used_by){assert(inv.used_by===b.nodeId,'Invitation already used',409,'INVITATION_ALREADY_USED');const node=await first(db,'SELECT * FROM nodes WHERE id=?',b.nodeId);assert(node&&!node.revoked&&equal(node.token_hash,tokenHash),'Enrollment identity mismatch',403);return enrolledView(db,node);}
  const ts=now();assert(!inv.revoked_at,'Invitation revoked',403,'INVITATION_REVOKED');assert(inv.expires>ts,'Invitation expired',403,'INVITATION_EXPIRED');
  // D1 batch is transactional. Reserve only an unused, live invitation whose
  // device identity is also unused; changes() binds the INSERT to that exact
  // successful reservation. A concurrent revoke wins before reservation or
  // sees an enrolled invitation afterward. Never adopt or overwrite a node.
  await batch(db,[
    [`UPDATE invites SET used_by=?,used_at=? WHERE id=? AND used_by IS NULL AND revoked_at IS NULL AND expires>?
      AND NOT EXISTS(SELECT 1 FROM nodes WHERE id=? OR token_hash=? OR name=invites.name COLLATE NOCASE)`,b.nodeId,ts,inv.id,ts,b.nodeId,tokenHash],
    [`INSERT INTO nodes(id,name,token_hash,projects,account_group,display_name,display_group_id,console_role,console_access)
      SELECT ?,name,?,projects,account_group,display_name,CASE WHEN EXISTS(SELECT 1 FROM device_groups g WHERE g.id=invites.display_group_id) THEN display_group_id ELSE NULL END,console_role,console_access
      FROM invites WHERE id=? AND used_by=? AND used_at=? AND changes()=1`,b.nodeId,tokenHash,inv.id,b.nodeId,ts]
  ]);
  const committed=await first(db,'SELECT * FROM invites WHERE id=?',inv.id),node=await first(db,'SELECT * FROM nodes WHERE id=?',b.nodeId);
  assert(!committed.revoked_at,'Invitation revoked',403,'INVITATION_REVOKED');assert(committed.used_by===b.nodeId&&node&&!node.revoked&&equal(node.token_hash,tokenHash),'Invitation or device identity already used',409,'INVITATION_IDENTITY_CONFLICT');
  return enrolledView(db,node);
}
