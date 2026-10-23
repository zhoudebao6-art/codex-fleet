import {first} from './db.mjs';
import {parse} from './util.mjs';

// Reservations and observed native turns share one budget. A continuation into an
// existing thread reuses its slot; it must not deadlock behind its own running turn.
export const LOAD_CTE=`fleet_load AS (
 SELECT target AS node,COALESCE(thread_id,json_extract(spec,'$.desktopThreadId'),'task:'||id) AS unit FROM tasks WHERE status IN('claimed','running','cancel_requested','uncertain')
 UNION SELECT d.node,d.thread_id FROM desktop_threads d JOIN nodes dn ON dn.id=d.node
 WHERE d.archived=0 AND d.status IN('running','waiting') AND d.status_source='app_server_runtime'
 AND julianday(d.observed_at)>=julianday('now','-120 seconds') AND julianday(d.received_at)>=julianday('now','-120 seconds')
 AND julianday(d.observed_at)<=julianday('now','+300 seconds') AND julianday(dn.last_seen)>=julianday('now','-60 seconds')
)`;
export const NODE_LIMIT=`CASE WHEN json_extract(owner.capabilities,'$.parallelExecution')=1 THEN MIN(MAX(1,COALESCE(CAST((SELECT value FROM settings WHERE key='parallel_limit:'||owner.id) AS INTEGER),4)),MAX(1,COALESCE(json_extract(owner.capabilities,'$.maxRunning'),4))) ELSE owner.max_running END`;
export const ACCOUNT_LIMIT=`(SELECT min(MAX(1,COALESCE(json_extract((SELECT value FROM settings WHERE key='group_limits'),'$.'||json_quote(gn.account_group)),CAST((SELECT value FROM settings WHERE key='default_group_limit') AS INTEGER),CASE WHEN json_extract(owner.capabilities,'$.parallelExecution')=1 THEN 64 ELSE 2 END))) FROM nodes gn WHERE COALESCE(gn.fingerprint,gn.account_group)=COALESCE(owner.fingerprint,owner.account_group))`;
const reuse=`EXISTS(SELECT 1 FROM fleet_load fl WHERE fl.node=owner.id AND fl.unit=json_extract(t.spec,'$.desktopThreadId'))`;
export const CAPACITY_CLAIM_GUARD=`AND (${reuse} OR ((SELECT count(*) FROM fleet_load WHERE node=owner.id)<${NODE_LIMIT}
 AND (SELECT count(*) FROM fleet_load fl JOIN nodes fn ON fn.id=fl.node WHERE COALESCE(fn.fingerprint,fn.account_group)=COALESCE(owner.fingerprint,owner.account_group))<${ACCOUNT_LIMIT}))
 AND (json_extract(t.spec,'$.desktopThreadId') IS NULL OR NOT EXISTS(SELECT 1 FROM tasks cb WHERE cb.target=owner.id AND (cb.status IN('claimed','cancel_requested','uncertain') OR (cb.status='running' AND cb.thread_id IS NULL)) AND json_extract(cb.spec,'$.desktopThreadId')=json_extract(t.spec,'$.desktopThreadId')))`;
export async function capacityView(db,id,spec={}) {
 const row=await first(db,`WITH ${LOAD_CTE} SELECT ${NODE_LIMIT} AS nodeLimit,${ACCOUNT_LIMIT} AS accountLimit,
 (SELECT count(*) FROM fleet_load WHERE node=owner.id) AS nodeUsed,
 (SELECT count(*) FROM fleet_load fl JOIN nodes fn ON fn.id=fl.node WHERE COALESCE(fn.fingerprint,fn.account_group)=COALESCE(owner.fingerprint,owner.account_group)) AS accountUsed,
 EXISTS(SELECT 1 FROM fleet_load WHERE node=owner.id AND unit=?) AS reusesSlot,
 EXISTS(SELECT 1 FROM tasks cb WHERE cb.target=owner.id AND (cb.status IN('claimed','cancel_requested','uncertain') OR (cb.status='running' AND cb.thread_id IS NULL)) AND json_extract(cb.spec,'$.desktopThreadId')=?) AS sending
 FROM nodes owner WHERE owner.id=?`,spec.desktopThreadId||'',spec.desktopThreadId||'',id);
 if(!row)return null;
 const reason=row.sending?'等待同一会话的上一条消息完成发送':row.reusesSlot?null:row.nodeUsed>=row.nodeLimit?`设备执行容量已满（${row.nodeUsed}/${row.nodeLimit}）`:row.accountUsed>=row.accountLimit?`同账号执行容量已满（${row.accountUsed}/${row.accountLimit}）`:null;
 return {...row,reusesSlot:!!row.reusesSlot,reason};
}
