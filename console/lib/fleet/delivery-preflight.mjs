import {parse,assert} from './util.mjs';

// This exception belongs to the user's publishing machine, not any device
// renamed PC-01 or a future replacement controller. Stamp new batches only.
export const SKILL_SOURCE_NODE='00000000-0000-4000-8000-000000000001';
export function sourcePolicy(controller,profile){
 return controller===SKILL_SOURCE_NODE&&['auto20','software'].includes(profile)
  ?{version:1,nodeId:controller,profile}:null;
}
export function isSkillSource(row,node){
 const spec=parse(row.declaration),policy=parse(row.loop_policy)?.skillSource;
 return node===SKILL_SOURCE_NODE&&row.controller===node&&policy?.version===1&&policy.nodeId===node&&policy.profile===spec.profile&&['auto20','software'].includes(spec.profile);
}
export function preflightNodes(row){return parse(row.declaration).nodes.filter(node=>!isSkillSource(row,node));}
export function preflightComplete(row,work){return preflightNodes(row).every(node=>work.some(j=>j.phase==='preflight'&&j.node===node&&parse(j.verified)?.passed===true));}
export function maintenanceCommit(row,repair){
 const baseline=parse(row.baseline);
 const commit=baseline?.source==='local-publisher'?repair?.baseCommit:baseline?.commit;
 assert(/^[a-f0-9]{40}$/.test(commit||''),'具体技能维护需提供真实发布提交 skillRepair.baseCommit；普通本机制作不做版本预检',409);
 return commit;
}
