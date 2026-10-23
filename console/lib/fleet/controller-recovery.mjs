import {assert,parse,json,hash,uid,now,validId} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {admin} from './auth.mjs';
import {nodeRuntime} from './runtime-readiness.mjs';
import {validateLocalControllers} from './delivery-routing.mjs';

const configRow=db=>first(db,"SELECT value FROM settings WHERE key='delivery_controller'");
const LOCK='delivery_controller_lock';
const LIVE="'claimed','running','uncertain','cancel_requested'";
export async function controllerRecovery(db,n){
 admin(n);const raw=await configRow(db),config=parse(raw?.value);if(!config)return {configured:false,name:'尚未配置总控',runtime:{label:'待配置'},canTransfer:false,candidates:[],batches:[],blockers:['请先在交付配置中设置总控设备']};
 const node=await first(db,'SELECT n.*,m.expires_at AS maintenance_expires FROM nodes n LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.id=?',config.controller);
 const health=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller_health'"))?.value);
 const lock=parse((await first(db,'SELECT value FROM settings WHERE key=?',LOCK))?.value);
 const busy=await all(db,`SELECT id,target,status,spec FROM tasks t WHERE status IN(${LIVE}) AND (creator=? OR target=? OR id IN(
 SELECT task_id FROM delivery_jobs j JOIN delivery_batches b ON b.id=j.batch_id WHERE b.controller=?
 UNION SELECT task_id FROM delivery_handoffs h JOIN delivery_batches b ON b.id=h.batch_id WHERE b.controller=?
 UNION SELECT task_id FROM delivery_recovery r JOIN delivery_batches b ON b.id=r.batch_id WHERE b.controller=?
 UNION SELECT task_id FROM delivery_relays r JOIN delivery_batches b ON b.id=r.batch_id WHERE b.controller=?))`,...Array(6).fill(config.controller));
 const cycles=await all(db,"SELECT id,state FROM skill_cycles WHERE controller=? AND state NOT IN('completed','cancelled')",config.controller);
 const maintenance=await all(db,"SELECT id,state FROM skill_maintenance_requests WHERE controller=? AND state NOT IN('completed','cancelled','no_maintenance')",config.controller);
 const native=await all(db,"SELECT thread_id,title FROM desktop_threads WHERE node=? AND status IN('running','waiting') AND status_source='app_server_runtime' AND archived=0 AND julianday(observed_at)>=julianday('now','-120 seconds') AND julianday(received_at)>=julianday('now','-120 seconds')",config.controller);
 const batches=await all(db,"SELECT id,status,declaration FROM delivery_batches WHERE controller=? AND status NOT IN('completed','cancelled','superseded')",config.controller);
 const nodes=await all(db,'SELECT n.*,m.expires_at AS maintenance_expires FROM nodes n LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.revoked=0 ORDER BY n.name');
 const candidates=[];for(const peer of nodes){
  if(peer.id===config.controller||config.excludedNodes?.includes(peer.id))continue;
  const runtime=nodeRuntime(peer),bindings=(config.localControllers||[]).filter(b=>b.nodeId===peer.id);
  const needed=[...new Set(batches.map(b=>parse(b.declaration)?.profile).filter(Boolean))];
  const reason=runtime.reason||(!parse(peer.capabilities)?.deliveryControl?'节点未报告总控能力':null)||(config.dispatchMode==='local-controller'&&needed.some(p=>!bindings.some(b=>b.profile===p))?'缺少待恢复业务的总控会话绑定':null);
  candidates.push({id:peer.id,name:peer.display_name||peer.name,ready:!reason,reason,profiles:bindings.map(b=>b.profile)});
 }
 const blockers=[...(nodeRuntime(node).online?['原总控仍在线；连接恢复后将按原记录继续']:[]),...(lock&&lock.expiresAt>now()?['总控正在推进流程，请稍后重新检查']:[]),...busy.map(t=>`任务 ${t.id}：${t.status}`),...native.map(t=>`总控原会话仍在运行：${t.title||t.thread_id}`),...cycles.map(c=>`技能流程 ${c.id}：${c.state}`),...maintenance.map(m=>`维护需求 ${m.id}：${m.state}`)];
 return {configured:true,controller:config.controller,name:node?.display_name||node?.name,runtime:nodeRuntime(node),revision:hash(raw.value),health:health?.controller===config.controller?health:null,
  blockers,candidates,batches:batches.map(b=>({id:b.id,name:parse(b.declaration)?.name||b.id,status:b.status})),canTransfer:blockers.length===0};
}

// Serialize scheduler requests, and fence every write against the same lease.
// Expired handlers cannot make late writes after another handler or recovery wins.
export async function withControllerTick(db,n,fn,{rejectBusy=false}={}){
 assert(!n.admin&&!n.browser,'Node credentials required',403);
 const config=parse((await configRow(db))?.value);if(config?.controller!==n.id){assert(!rejectBusy,'总控归属已变化，保留原操作记录',403);return {enabled:false,operations:[]};}
 const token=uid(),lease={token,controller:n.id,expiresAt:new Date(Date.now()+120000).toISOString()};
 const r=await run(db,`INSERT INTO settings(key,value) SELECT ?,? WHERE json_extract((SELECT value FROM settings WHERE key='delivery_controller'),'$.controller')=?
 ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(settings.value,'$.expiresAt')<?`,LOCK,json(lease),n.id,now());
 if(r.meta.changes!==1){assert(!rejectBusy,'总控正在推进另一项操作，请稍后重试',409);return {enabled:true,operations:[],busy:true};}
 const fence=()=>db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND json_extract(value,'$.token')=? AND json_extract(value,'$.expiresAt')>?) AND json_extract((SELECT value FROM settings WHERE key='delivery_controller'),'$.controller')=? THEN 'true' ELSE 'stale-controller-lease' END)`).bind(LOCK,token,now(),n.id);
 const guarded={prepare(sql){let raw=db.prepare(sql);return {sql,args:[],bind(...args){this.args=args;raw=raw.bind(...args);return this;},first(){return raw.first();},all(){return raw.all();},async run(){return (await db.batch([fence(),raw]))[1];},get raw(){return raw;}};},batch(items){return db.batch([fence(),...items.map(s=>s.raw)]).then(r=>r.slice(1));}};
 try{const result=await fn(guarded);await run(guarded,"INSERT INTO settings(key,value) VALUES('delivery_controller_health',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",json({controller:n.id,at:now(),operations:result.operations?.length||0}));return result;}
 finally{await run(db,"DELETE FROM settings WHERE key=? AND json_extract(value,'$.token')=?",LOCK,token);}
}

export async function transferController(db,n,b){
 admin(n);assert(validId(b.id)&&validId(b.target)&&typeof b.revision==='string'&&typeof b.reason==='string'&&b.reason.trim().length>=6&&b.reason.length<=2000,'填写接管设备与原因');
 const requestKey='controller_recovery:'+b.id,digest=hash(json(b)),old=await first(db,'SELECT value FROM settings WHERE key=?',requestKey);
 if(old){const receipt=parse(old.value);assert(receipt.digest===digest,'同一恢复编号的请求内容不能变更',409);return receipt;}
 const view=await controllerRecovery(db,n),raw=await configRow(db),config=parse(raw?.value);
 assert(view.revision===b.revision,'总控配置已变化，请重新检查',409);
 assert(view.canTransfer,'仍有运行中或待核实工作，保留当前总控归属',409);
 assert(view.candidates.some(c=>c.id===b.target&&c.ready),'目标总控尚未就绪',409);
 if(config.dispatchMode==='local-controller')await validateLocalControllers(db,n,(config.localControllers||[]).filter(x=>x.nodeId===b.target));
 const token=uid(),lease={token,controller:config.controller,recovery:true,expiresAt:new Date(Date.now()+120000).toISOString()};
 const lock=await run(db,`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(settings.value,'$.expiresAt')<?`,LOCK,json(lease),now());
 assert(lock.meta.changes===1,'总控正在推进流程，请稍后重新检查',409);
 try{
  // Re-read after acquiring the lock; no scheduler request can advance in between.
  const fresh=await controllerRecovery(db,n);assert(fresh.revision===b.revision&&fresh.blockers.filter(x=>!x.startsWith('总控正在推进流程')).length===0,'执行状态已变化，请重新检查',409);
  const target=await first(db,'SELECT n.*,m.expires_at AS maintenance_expires FROM nodes n LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.id=?',b.target);assert(!nodeRuntime(target).reason,'目标连接状态已变化',409);
  const next={...config,controller:b.target,regionalControllers:(config.regionalControllers||[]).filter(r=>r.nodeId!==b.target)};
  const receipt={id:b.id,digest,from:config.controller,to:b.target,at:now(),reason:b.reason.trim(),batches:fresh.batches.length,paused:true};
  const statements=[['UPDATE settings SET value=? WHERE key=\'delivery_controller\' AND value=?',json(next),raw.value],
   ["UPDATE delivery_batches SET controller=?,error=CASE WHEN status IN('baseline','preflight','producing','collecting') THEN json_object('resume',status,'recoveryId',?) ELSE error END,status=CASE WHEN status IN('baseline','preflight','producing','collecting') THEN 'paused' ELSE status END,updated_at=? WHERE controller=? AND status NOT IN('completed','cancelled','superseded')",b.target,b.id,receipt.at,config.controller],
   ['INSERT INTO settings(key,value) VALUES(?,?)',requestKey,json(receipt)],
   ["INSERT INTO events(id,node,type,payload,created) VALUES(?,?,'controller_recovered',?,?)",'controller-recovery:'+b.id,n.id,json(receipt),receipt.at]];
  // D1 checks both config and pending execution again inside the atomic write.
  const guard=[`SELECT json(CASE WHEN (SELECT value FROM settings WHERE key='delivery_controller')=? AND json_extract((SELECT value FROM settings WHERE key=?),'$.token')=? AND NOT EXISTS(SELECT 1 FROM tasks WHERE status IN(${LIVE}) AND (creator=? OR target=?)) THEN 'true' ELSE 'controller-recovery-conflict' END)`,raw.value,LOCK,token,config.controller,config.controller];
  await batch(db,[guard,...statements]);return receipt;
 }finally{await run(db,"DELETE FROM settings WHERE key=? AND json_extract(value,'$.token')=?",LOCK,token);}
}
