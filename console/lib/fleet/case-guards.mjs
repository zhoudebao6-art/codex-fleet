import {assert,canonical,parse} from './util.mjs';
import {first} from './db.mjs';

export const CASE_CLAIM_GUARD=`AND (NOT EXISTS(SELECT 1 FROM case_jobs cj WHERE cj.task_id=t.id) OR EXISTS(
 SELECT 1 FROM case_jobs cj JOIN case_versions cv ON cv.id=cj.version_id JOIN case_dossiers cd ON cd.id=cv.case_id
 JOIN settings cfg ON cfg.key='delivery_controller' JOIN nodes owner_controller ON owner_controller.id=cd.controller AND owner_controller.revoked=0
 WHERE cj.task_id=t.id AND cd.creator=t.creator AND cd.project=t.project
 AND cd.status IN('running','pending_requirements') AND cv.status IN('producing','reviewing','collecting')
 AND json_extract(cfg.value,'$.controller')=cd.controller
 AND NOT EXISTS(SELECT 1 FROM json_each(cfg.value,'$.excludedNodes') excluded WHERE excluded.value=t.target)
 AND EXISTS(SELECT 1 FROM claim_actor_targets ca WHERE ca.creator=cd.creator AND ca.target=cd.controller)
 AND NOT EXISTS(SELECT 1 FROM json_each(cd.node_ids) node WHERE NOT EXISTS(SELECT 1 FROM claim_actor_targets ca WHERE ca.creator=cd.creator AND ca.target=node.value))))`;

export async function validateCaseDispatch(db,actor,spec){
 const row=await first(db,'SELECT cj.spec,cv.status AS version_status,cd.creator,cd.status,cd.controller FROM case_jobs cj JOIN case_versions cv ON cv.id=cj.version_id JOIN case_dossiers cd ON cd.id=cv.case_id WHERE cj.task_id=?',spec.id);
 if(!row)return;
 assert(actor.id===row.creator&&canonical(spec)===canonical(parse(row.spec)),'Case dispatch does not match its immutable prepared task',409);
 assert(['running','pending_requirements'].includes(row.status)&&['producing','reviewing','collecting'].includes(row.version_status),'Case dispatch is no longer active',409);
 const config=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 assert(config?.controller===row.controller&&!config.excludedNodes?.includes(spec.targetNode),'Case controller assignment or device eligibility changed',409);
}
