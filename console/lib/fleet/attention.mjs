import {now} from './util.mjs';

const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
export function taskActions(n,t) {
  const write=n.admin||n.role!=='viewer';
  const owner=n.admin||t.creator===n.id;
  const cancel=owner||t.target===n.id||n.nodeId===t.target;
  return {
    cancel:!!(write&&cancel&&['queued','claimed','running','uncertain','blocked'].includes(t.status)),
    accept:!!(write&&owner&&t.status==='submitted'),
    resolve:!!(n.admin&&(['uncertain','cancel_requested'].includes(t.status)||t.result?.desktop?.state==='uncertain')),
  };
}

// A device's action inbox belongs to that device, even when its read access spans
// other groups. Human accounts retain their existing group and action permissions.
export function attentionWhere(n,category,alias='t') {
  if(n.role==='viewer')return '0=1';
  const col=k=>`${alias}.${k}`,owner=n.admin?'1=1':`${col('creator')}=${literal(n.id)}`;
  const local=n.kind==='device'?`${col('target')}=${literal(n.nodeId||'')}`:'1=1';
  const cancel=n.admin?'1=1':`(${owner} OR ${col('target')}=${literal(n.nodeId||n.id)})`;
  if(category==='confirm')return `(${local} AND ${col('status')}='submitted' AND json_extract(${col('spec')},'$.desktopThreadId') IS NULL AND COALESCE(json_extract(${col('spec')},'$.intent'),'collaboration')!='conversation' AND (${owner}))`;
  const interaction=n.browser&&['admin','operator'].includes(n.role)?`EXISTS(SELECT 1 FROM task_interactions ai WHERE ai.task=${col('id')} AND ai.attempt=${col('attempt')} AND ai.status='pending' AND ai.expires_at>${literal(now())})`:'0=1';
  return `(${local} AND ((${col('status')} IN('blocked','uncertain') AND ${cancel}) OR (${col('status')} IN('claimed','running') AND ${interaction})))`;
}
