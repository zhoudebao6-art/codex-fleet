import {assert,validId,uid,now} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {admin} from './auth.mjs';
import {nodeScope,readAccess,validateAccess,browserRestricted,UNGROUPED} from './access.mjs';
import {listNodes} from './tasks.mjs';

function fields(body,allowed) {assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(key=>allowed.includes(key)),'Unsupported device management field');}
function label(value,max=120) {assert(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\x00-\x1f\x7f]/.test(value),'Invalid display name');return value.trim();}
export const validateDisplayName=value=>value===null||value===undefined?null:label(value);
function order(value) {assert(Number.isSafeInteger(value)&&value>=-100000&&value<=100000,'Invalid group order');return value;}
export async function validateDisplayGroup(db,id) {if(id===null||id===undefined)return null;assert(validId(id),'Invalid display group ID');assert(await first(db,'SELECT id FROM device_groups WHERE id=?',id),'Display group not found',404);return id;}
const view=row=>({id:row.id,name:row.name,sortOrder:row.sort_order,nodeCount:row.node_count||0,createdAt:row.created_at,updatedAt:row.updated_at});

export async function listDeviceGroups(db,actor) {
  const scoped=!actor.admin&&(!actor.browser||actor.kind==='device'),rows=await all(db,`SELECT g.*,count(n.id) AS node_count FROM device_groups g LEFT JOIN nodes n ON n.display_group_id=g.id AND n.revoked=0 AND ${nodeScope(actor,'n.id')} ${scoped?'AND EXISTS(SELECT 1 FROM json_each(n.projects) p WHERE p.value IN(SELECT value FROM json_each(?)))':''} GROUP BY g.id ${(scoped||browserRestricted(actor))?'HAVING count(n.id)>0':''} ORDER BY g.sort_order,g.name,g.id`,...(scoped?[actor.projects]:[]));
  return {groups:rows.map(view)};
}
export async function createDeviceGroup(db,actor,body) {
  admin(actor);fields(body,['id','name','sortOrder']);const id=body.id||uid(),name=label(body.name,80),sortOrder=order(body.sortOrder??0);assert(validId(id),'Invalid display group ID');
  const old=await first(db,'SELECT * FROM device_groups WHERE id=?',id);if(old){assert(old.name===name&&old.sort_order===sortOrder,'Display group ID already used',409);return view(old);}
  const ts=now();await run(db,'INSERT OR IGNORE INTO device_groups(id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)',id,name,sortOrder,ts,ts);const saved=await first(db,'SELECT * FROM device_groups WHERE id=?',id);assert(saved&&saved.name===name&&saved.sort_order===sortOrder,'Display group name or ID already exists',409);return view(saved);
}
export async function updateDeviceGroup(db,actor,id,body) {
  admin(actor);fields(body,['name','sortOrder']);assert(validId(id),'Invalid display group ID');const old=await first(db,'SELECT * FROM device_groups WHERE id=?',id);assert(old,'Display group not found',404);
  const name=body.name===undefined?old.name:label(body.name,80),sortOrder=body.sortOrder===undefined?old.sort_order:order(body.sortOrder);
  const r=await run(db,'UPDATE OR IGNORE device_groups SET name=?,sort_order=?,updated_at=? WHERE id=?',name,sortOrder,now(),id);assert(r.meta.changes===1,'Display group name already exists',409);
  return view(await first(db,'SELECT g.*,(SELECT count(*) FROM nodes n WHERE n.display_group_id=g.id AND n.revoked=0) AS node_count FROM device_groups g WHERE id=?',id));
}
export async function deleteDeviceGroup(db,actor,id) {
  // Remove stale regional ownership together with the group. Existing batches
  // retain frozen routes, while fresh claims still recheck current membership.
  const regionCleanup=["UPDATE settings SET value=json_set(value,'$.regionalControllers',json(COALESCE((SELECT json_group_array(json_set(r.value,'$.groupIds',json((SELECT json_group_array(g.value) FROM json_each(r.value,'$.groupIds') g WHERE g.value!=?)))) FROM json_each(settings.value,'$.regionalControllers') r WHERE EXISTS(SELECT 1 FROM json_each(r.value,'$.groupIds') g WHERE g.value!=?)),'[]'))) WHERE key='delivery_controller'",id,id];
  admin(actor);assert(validId(id),'Invalid display group ID');await batch(db,[regionCleanup,['UPDATE nodes SET display_group_id=NULL WHERE display_group_id=?',id],['UPDATE invites SET display_group_id=NULL WHERE display_group_id=?',id],["UPDATE members SET group_access=json_set(group_access,'$.groupIds',json(COALESCE((SELECT json_group_array(value) FROM json_each(members.group_access,'$.groupIds') WHERE value!=?), '[]'))) WHERE json_extract(group_access,'$.mode')='groups'",id],["UPDATE nodes SET console_access=json_set(console_access,'$.groupIds',json(COALESCE((SELECT json_group_array(value) FROM json_each(nodes.console_access,'$.groupIds') WHERE value!=?), '[]'))) WHERE json_extract(console_access,'$.mode')='groups'",id],["UPDATE invites SET console_access=json_set(console_access,'$.groupIds',json(COALESCE((SELECT json_group_array(value) FROM json_each(invites.console_access,'$.groupIds') WHERE value!=?), '[]'))) WHERE json_extract(console_access,'$.mode')='groups'",id],['DELETE FROM file_group_grants WHERE group_id=?',id],['DELETE FROM device_groups WHERE id=?',id]]);return {ok:true};
}
export async function updateDevice(db,actor,id,body) {
  admin(actor);fields(body,['displayName','groupId','consoleRole','consoleAccess','parallelLimit']);assert(body.parallelLimit===undefined||(Number.isInteger(body.parallelLimit)&&body.parallelLimit>=1&&body.parallelLimit<=16),'Parallel limit must be 1-16');assert(validId(id),'Invalid device ID');const old=await first(db,'SELECT * FROM nodes WHERE id=?',id);assert(old,'Device not found',404);
  const name=body.displayName===undefined?old.display_name:body.displayName===null?null:label(body.displayName),groupId=body.groupId===undefined?old.display_group_id:await validateDisplayGroup(db,body.groupId);
  const consoleRole=body.consoleRole??old.console_role;assert(['operator','viewer'].includes(consoleRole),'Invalid device console role');const consoleAccess=body.consoleAccess===undefined?readAccess(old.console_access):await validateAccess(db,body.consoleAccess);
  const result=await run(db,'UPDATE nodes SET display_name=?,display_group_id=?,console_role=?,console_access=? WHERE id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM device_groups WHERE id=?))',name,groupId,consoleRole,JSON.stringify(consoleAccess),id,groupId,groupId);assert(result.meta.changes===1,'Display group was removed before the device update',409);
  if(body.parallelLimit!==undefined)await run(db,"INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",'parallel_limit:'+id,String(body.parallelLimit));
  return (await listNodes(db,actor)).find(node=>node.id===id);
}
