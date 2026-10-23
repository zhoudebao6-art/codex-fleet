import {assert,parse,json,validId} from './util.mjs';
import {first,all} from './db.mjs';

export const UNGROUPED='__ungrouped__';
export const noAccess=()=>({mode:'groups',groupIds:[]});
export function readAccess(value){
  try{const a=typeof value==='string'?JSON.parse(value):value;
    if(a?.mode==='all'&&Array.isArray(a.groupIds)&&a.groupIds.length===0)return {mode:'all',groupIds:[]};
    if(a?.mode==='groups'&&Array.isArray(a.groupIds)&&a.groupIds.length<=200&&a.groupIds.every(validId))return {mode:'groups',groupIds:[...new Set(a.groupIds)].sort()};
  }catch{}return noAccess();
}
export async function validateAccess(db,value,{defaultAll=false}={}){
  if(value===undefined)return defaultAll?{mode:'all',groupIds:[]}:noAccess();
  assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['mode','groupIds'].includes(k))&&['all','groups'].includes(value.mode)&&Array.isArray(value.groupIds)&&value.groupIds.length<=200&&value.groupIds.every(validId)&&new Set(value.groupIds).size===value.groupIds.length,'Invalid group access');
  assert(value.mode!=='all'||value.groupIds.length===0,'All-group access must not contain group IDs');
  const ids=value.groupIds.filter(id=>id!==UNGROUPED),known=ids.length?await all(db,'SELECT id FROM device_groups WHERE id IN(SELECT value FROM json_each(?))',json(ids)):[];
  assert(known.length===ids.length,'One or more access groups do not exist',400);return readAccess(value);
}
export function withAccess(actor,value){return {...actor,access:actor.admin?{mode:'all',groupIds:[]}:readAccess(value)};}
export const browserRestricted=n=>n.browser&&!n.admin&&readAccess(n.access).mode!=='all';
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
// Only internal column expressions enter these helpers. JSON values are SQL quoted.
export function nodeScope(n,column){if(!browserRestricted(n))return '1=1';return `${column} IN(SELECT acln.id FROM nodes acln WHERE COALESCE(acln.display_group_id,'${UNGROUPED}') IN(SELECT value FROM json_each(${literal(json(readAccess(n.access).groupIds))})))`;}
export async function assertNodeAccess(db,n,id){if(browserRestricted(n))assert(await first(db,'SELECT id FROM nodes WHERE id=? AND '+nodeScope(n,'id'),id),'Device group access denied',403,'GROUP_ACCESS_DENIED');}
export function fileScope(n,alias='files'){
  if(!browserRestricted(n))return '1=1';
  return `(${alias}.owner IN(SELECT acln.id FROM nodes acln WHERE ${nodeScope(n,'acln.id')}) OR EXISTS(SELECT 1 FROM artifact_refs aclr JOIN tasks aclt ON aclt.id=aclr.task WHERE aclr.sha=${alias}.sha AND aclt.project=${alias}.project AND ${nodeScope(n,'aclt.target')}) OR EXISTS(SELECT 1 FROM file_group_grants aclg WHERE aclg.project=${alias}.project AND aclg.sha=${alias}.sha AND aclg.group_id IN(SELECT value FROM json_each(${literal(json(readAccess(n.access).groupIds))}))))`;
}
export const flowScope=(n,alias='automation_flows')=>!browserRestricted(n)?'1=1':`NOT EXISTS(SELECT 1 FROM json_each(${alias}.declaration,'$.steps') acls WHERE NOT(${nodeScope(n,"json_extract(acls.value,'$.targetNode')")}))`;
export const GROUP_SCOPE_SQL=(column,target)=>{const value=`CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;return `(json_type(${value},'$.groupIds')='array' AND ((json_extract(${value},'$.mode')='all' AND json_array_length(${value},'$.groupIds')=0) OR (json_extract(${value},'$.mode')='groups' AND EXISTS(SELECT 1 FROM nodes agn WHERE agn.id=${target} AND COALESCE(agn.display_group_id,'${UNGROUPED}') IN(SELECT value FROM json_each(${value},'$.groupIds'))))))`;};
// D1 limits expression depth to 100. Build the current authorization relation
// once, within the claim statement, instead of nesting it inside every flow
// step predicate. It remains atomic with the UPDATE and cannot use stale grants.
export const CLAIM_ACTOR_TARGETS_SQL=`claim_actor_targets(creator,target) AS (
  SELECT 'admin',an.id FROM nodes an
  UNION ALL SELECT cn.id,an.id FROM nodes cn CROSS JOIN nodes an WHERE cn.revoked=0
  UNION ALL SELECT 'member:'||cm.id,an.id FROM members cm CROSS JOIN nodes an LEFT JOIN local_accounts ca ON ca.member_id=cm.id
    WHERE cm.role IN('admin','operator') AND (ca.id IS NULL OR ca.active=1) AND (cm.role='admin' OR ${GROUP_SCOPE_SQL('cm.group_access','an.id')})
  UNION ALL SELECT 'device:'||cd.id,an.id FROM nodes cd CROSS JOIN nodes an
    WHERE cd.revoked=0 AND cd.console_role='operator' AND ${GROUP_SCOPE_SQL('cd.console_access','an.id')}
)`;
export const TASK_CREATOR_CLAIM_GUARD=`AND EXISTS(SELECT 1 FROM claim_actor_targets cat WHERE cat.creator=t.creator AND cat.target=t.target)`;
