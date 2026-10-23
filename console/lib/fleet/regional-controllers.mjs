import {assert,parse,validId} from './util.mjs';
import {first} from './db.mjs';
import {assertNodeAccess} from './access.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';

// A regional controller receives frozen child declarations, not global admin
// credentials. The main controller remains the only publisher/collector.
export async function validateRegionalControllers(db,actor,entries,controller){
 assert(Array.isArray(entries)&&entries.length<=50,'Invalid regional controllers');
 const owners=new Set(),nodes=new Set(),out=[];
 for(const entry of entries){
  assert(entry&&validId(entry.nodeId)&&entry.nodeId!==controller&&!nodes.has(entry.nodeId),'Choose one regional role per computer, separate from the main controller');nodes.add(entry.nodeId);
  await assertNodeAccess(db,actor,entry.nodeId);
  assert(await first(db,'SELECT id FROM nodes WHERE id=? AND revoked=0',entry.nodeId),'Regional computer unavailable');
  assert(Array.isArray(entry.groupIds)&&entry.groupIds.length>0&&entry.groupIds.length<=50&&entry.groupIds.every(validId)&&new Set(entry.groupIds).size===entry.groupIds.length,'Choose regional device groups');
  assert(Array.isArray(entry.profiles)&&entry.profiles.length>0&&entry.profiles.every(p=>['auto20','software'].includes(p))&&new Set(entry.profiles).size===entry.profiles.length,'Choose regional automations');
  for(const group of entry.groupIds){
   assert(await first(db,'SELECT id FROM device_groups WHERE id=?',group),'Regional group no longer exists');
   for(const profile of entry.profiles){const key=group+':'+profile;assert(!owners.has(key),'Each group and automation can have only one regional controller');owners.add(key);}
  }
  out.push({nodeId:entry.nodeId,groupIds:[...entry.groupIds].sort(),profiles:[...entry.profiles].sort()});
 }
 return out;
}
export function regionalOwner(config,node,profile){
 if(node.id===config.controller)return null;
 return (config.regionalControllers||[]).find(r=>r.profiles.includes(profile)&&r.groupIds.includes(node.display_group_id||node.groupId))||null;
}
export async function regionalDispatcher(db,actor,config,node,profile){
 const region=regionalOwner(config,node,profile);if(!region||region.nodeId===node.id)return null;
 if(config.excludedNodes?.includes(region.nodeId))return null;
 const binding=config.localControllers?.find(b=>b.nodeId===region.nodeId&&b.profile===profile);
 const peer=await first(db,'SELECT * FROM nodes WHERE id=?',region.nodeId);
 if(!binding||runtimeIssue(peer,{parallel:true}))return null;
 await assertNodeAccess(db,actor,region.nodeId);
 return {...binding,groupId:node.display_group_id};
}
export async function regionalDispatchAllowed(db,config,row,dispatcher){
 if(!dispatcher||config.excludedNodes?.includes(dispatcher.nodeId))return false;
 const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',row.node);
 const peer=await first(db,'SELECT id FROM nodes WHERE id=? AND revoked=0',dispatcher.nodeId);
 return !!(node&&peer&&regionalOwner(config,node,parse(row.declaration).profile)?.nodeId===dispatcher.nodeId);
}

// Recheck delegated authority at claim time as well as submit time. Changing
// groups or roles prevents new claims but never terminates existing work.
export const REGIONAL_CLAIM_GUARD=`AND NOT EXISTS(
 SELECT 1 FROM delivery_jobs rj JOIN delivery_batches rb ON rb.id=rj.batch_id
 WHERE rj.task_id=t.id AND t.creator!=rb.controller AND t.creator!=rj.node
 AND NOT EXISTS(SELECT 1 FROM settings rc JOIN nodes rn ON rn.id=rj.node
 JOIN json_each(rc.value,'$.regionalControllers') rr
 WHERE rc.key='delivery_controller' AND json_extract(rr.value,'$.nodeId')=t.creator
 AND json_extract(rc.value,'$.controller')=rb.controller
 AND NOT EXISTS(SELECT 1 FROM json_each(rc.value,'$.excludedNodes') ex WHERE ex.value IN(t.creator,rj.node))
 AND EXISTS(SELECT 1 FROM json_each(rr.value,'$.groupIds') rg WHERE rg.value=rn.display_group_id)
 AND EXISTS(SELECT 1 FROM json_each(rr.value,'$.profiles') rp WHERE rp.value=json_extract(rb.declaration,'$.profile'))))`;
