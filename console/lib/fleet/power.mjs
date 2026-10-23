import {assert,validId,uid,now,parse,json,hash} from './util.mjs';
import {first,all,run} from './db.mjs';
import {admin,writer,can} from './auth.mjs';
import {assertNodeAccess,CLAIM_ACTOR_TARGETS_SQL,browserRestricted} from './access.mjs';
const ACTIVE="'queued','sent','online'";
const online=n=>!n.revoked&&Date.parse(n.last_seen)>Date.now()-60000;
const fresh=p=>p&&Date.parse(p.reported_at)>Date.now()-60000;
const cleanText=(s,max=600)=>typeof s==='string'?s.slice(0,max):'';
const isMac=s=>typeof s==='string'&&/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s)&&!(parseInt(s.slice(0,2),16)&1)&&s!=='00:00:00:00:00:00';
const ipv4=s=>typeof s==='string'&&/^\d{1,3}(\.\d{1,3}){3}$/.test(s)&&s.split('.').every(x=>+x<=255);
function fields(body,allowed){assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>allowed.includes(k)),'Unsupported power field');}
function nodeOnly(n){assert(!n.browser&&!n.admin,'Node identity required',403);}
async function authorizedNode(db,n,id){assert(validId(id),'Invalid node ID');await assertNodeAccess(db,n,id);const row=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',id);assert(row&&parse(row.projects).some(p=>can(n,p)),'Device unavailable or outside your projects',403);return row;}
const policy=p=>({mode:['available','working','off'].includes(p?.mode)?p.mode:'available'});
function normalizeReport(b){
 fields(b,['version','inventory','networks','guard']);assert(b.version==='0.1.0','Unsupported power protocol');
 assert(Array.isArray(b.networks)&&b.networks.length<=16,'Too many physical networks');
 const networks=b.networks.map(n=>{assert(/^[a-f0-9]{64}$/.test(n.networkId)&&ipv4(n.address)&&ipv4(n.subnet)&&ipv4(n.broadcast)&&Number.isInteger(n.prefix)&&n.prefix>=8&&n.prefix<=30&&isMac(n.mac),'Invalid physical network');return {networkId:n.networkId,address:n.address,prefix:n.prefix,subnet:n.subnet,broadcast:n.broadcast,mac:n.mac,name:cleanText(n.name,100),wakeOnMagicPacket:cleanText(n.wakeOnMagicPacket,50),wakeArmed:n.wakeArmed===true};});
 const inv=b.inventory||{},sleep=inv.sleep||{};
 const guardAt=Number.isFinite(b.guard?.ageMs)&&b.guard.ageMs>=0&&b.guard.ageMs<=120000?new Date(Date.now()-b.guard.ageMs).toISOString():cleanText(b.guard?.at,60);
 return {version:b.version,networks,inventory:{at:cleanText(inv.at,60),sleep:{s1:!!sleep.s1,s2:!!sleep.s2,s3:!!sleep.s3,s4:!!sleep.s4,hibernateEnabled:!!sleep.hibernateEnabled,summary:cleanText(sleep.summary,2500)},adapters:(Array.isArray(inv.adapters)?inv.adapters:[]).slice(0,16).map(a=>({name:cleanText(a.name,100),description:cleanText(a.description,200),wakeOnMagicPacket:cleanText(a.wakeOnMagicPacket,50),wakeArmed:a.wakeArmed===true,configuration:cleanText(a.configuration,100),error:cleanText(a.error)})),errors:(Array.isArray(inv.errors)?inv.errors:[]).slice(0,8).map(e=>cleanText(e))},guard:{active:b.guard?.active===true,apiOk:b.guard?.apiOk===true,at:guardAt,reason:cleanText(b.guard?.reason,100),acLineStatus:b.guard?.acLineStatus??255}};
}
async function candidates(db,target,report){
 const rows=await all(db,'SELECT p.*,n.name,n.last_seen,n.projects,n.revoked FROM power_nodes p JOIN nodes n ON n.id=p.node WHERE p.node<>? AND n.revoked=0',target.id);
 const eligible=(report?.networks||[]).filter(t=>t.wakeOnMagicPacket==='Enabled'&&t.wakeArmed);
 return rows.filter(p=>fresh(p)&&online(p)&&parse(p.projects).some(x=>parse(target.projects).includes(x))).map(p=>{
  const local=parse(p.report).networks||[];const targets=eligible.filter(t=>local.some(a=>a.networkId===t.networkId&&a.broadcast===t.broadcast)).map(t=>({networkId:t.networkId,broadcast:t.broadcast,mac:t.mac}));
  return {nodeId:p.node,name:p.name,targets};
 }).filter(p=>p.targets.length).slice(0,3);
}
async function reconcile(db,target){
 const actions=await all(db,`SELECT * FROM wake_actions WHERE node=? AND status IN(${ACTIVE})`,target.id);
 for(const a of actions){
  const receipts=await all(db,'SELECT status FROM wake_receipts WHERE action=?',a.id);
  const sent=receipts.some(r=>r.status==='sent'),allFailed=receipts.length===parse(a.relays).length&&!sent;
  let status=a.status,detail=a.detail;
  if(Date.parse(a.expires_at)<Date.now()){status='timeout';detail=online(target)?'请求已超时；目标目前在线，本次唤醒未能在窗口内确认。':'等待上线超时；检查电源、网线、BIOS 和网卡唤醒设置。';}
  else if(a.probe&&sent){status='packet_sent';detail='中转已发送唤醒包；目标本来在线，未验证睡眠恢复。';}
  else if(!a.probe&&online(target)&&Date.parse(target.last_seen)>Date.parse(a.created_at)){
   status=parse(target.capabilities)?.ready===true?'ready':'online';detail=status==='ready'?'目标已重新上线，Codex 执行器就绪。':'目标节点已上线，等待 Codex 执行器就绪。';
  }else if(allFailed){status='failed';detail='中转未能发送，请查看设备网络与检测结果。';}
  else if(sent){status='sent';detail='唤醒包已发送，等待目标重新连接。';}
  if(status!==a.status)await run(db,`UPDATE wake_actions SET status=?,detail=?,updated_at=? WHERE id=? AND status IN(${ACTIVE})`,status,detail,now(),a.id);
 }
}
// Relay identities are infrastructure details. Restricted members may operate
// their target without learning the names of computers outside their groups.
const relayView=(n,relays)=>browserRestricted(n)?(relays.length?[{nodeId:'',name:'同局域网中转'}]:[]):relays.map(r=>({nodeId:r.nodeId,name:r.name}));
const actionView=(a,n)=>({id:a.id,status:a.status,probe:!!a.probe,detail:a.detail,createdAt:a.created_at,updatedAt:a.updated_at,expiresAt:a.expires_at,relays:relayView(n,parse(a.relays))});
export async function powerView(db,n,id){
 const target=await authorizedNode(db,n,id);await reconcile(db,target);
 const p=await first(db,'SELECT * FROM power_nodes WHERE node=?',id),report=p?parse(p.report):null,relays=await candidates(db,target,report);
 const actions=await all(db,'SELECT * FROM wake_actions WHERE node=? ORDER BY created_at DESC LIMIT 8',id);
 const inventory=report?.inventory;const reason=!p?'待安装电源组件':!report.networks.length?'未识别到可中转的物理局域网':!report.networks.some(a=>a.wakeOnMagicPacket==='Enabled'&&a.wakeArmed)?'网卡唤醒未就绪':!relays.length?'目标局域网内没有在线中转设备':null;
 return {nodeId:id,agentOnline:fresh(p),guardFresh:!!(fresh(p)&&Date.parse(report?.guard?.at)>Date.now()-45000),reportedAt:p?.reported_at,policy:policy(p),guard:report?.guard,inventory,relayCount:relays.length,relays:relayView(n,relays),wakeAvailable:!reason,reason,actions:actions.map(a=>actionView(a,n))};
}
export async function setPowerPolicy(db,n,id,b){
 admin(n);fields(b,['mode']);assert(['available','working','off'].includes(b.mode),'Invalid power mode');await authorizedNode(db,n,id);
 assert(await first(db,'SELECT node FROM power_nodes WHERE node=?',id),'Power agent has not connected',409);
 await run(db,'UPDATE power_nodes SET mode=? WHERE node=?',b.mode,id);return powerView(db,n,id);
}
export async function requestWake(db,n,id,b){
 writer(n);fields(b,['id','probe']);assert(b.probe===undefined||typeof b.probe==='boolean','Invalid probe flag');
 const target=await authorizedNode(db,n,id),actionId=b.id||uid();assert(validId(actionId),'Invalid request ID');
 const prior=await first(db,'SELECT * FROM wake_actions WHERE id=?',actionId);if(prior){assert(prior.node===id&&prior.probe===Number(!!b.probe),'Wake request ID reused',409);return actionView(prior,n);}
 await reconcile(db,target);const active=await first(db,`SELECT * FROM wake_actions WHERE node=? AND status IN(${ACTIVE})`,id);if(active)return actionView(active,n);
 assert(!online(target)||b.probe===true,'设备已在线，无需唤醒；可以检测唤醒链路。',409);
 const recent=await first(db,'SELECT created_at FROM wake_actions WHERE node=? ORDER BY created_at DESC LIMIT 1',id);assert(!recent||Date.parse(recent.created_at)<Date.now()-30000,'请等待 30 秒后再试。',429);
 const p=await first(db,'SELECT * FROM power_nodes WHERE node=?',id),relays=await candidates(db,target,p?parse(p.report):null);
 assert(relays.length,'没有可用的同局域网唤醒中转；目标需要已启用唤醒的网卡和在线邻居。',409);
 await run(db,`INSERT OR IGNORE INTO wake_actions(id,node,creator,probe,relays,status,detail,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,'queued','等待中转发送唤醒包。',?,?,? WHERE NOT EXISTS(SELECT 1 FROM wake_actions WHERE node=? AND status IN(${ACTIVE}))`,actionId,id,n.id,Number(!!b.probe),json(relays),now(),now(),new Date(Date.now()+180000).toISOString(),id);
 const saved=await first(db,'SELECT * FROM wake_actions WHERE id=?',actionId);assert(saved,'设备已有唤醒请求，请刷新。',409);return actionView(saved,n);
}
export async function powerPoll(db,n,b){
 nodeOnly(n);const report=normalizeReport(b);
 await run(db,"INSERT INTO power_nodes(node,report,reported_at,mode) VALUES(?,?,?,'available') ON CONFLICT(node) DO UPDATE SET report=excluded.report,reported_at=excluded.reported_at",n.id,json(report),now());
 const p=await first(db,'SELECT * FROM power_nodes WHERE node=?',n.id);
 const busy=!!await first(db,"SELECT id FROM tasks WHERE target=? AND status IN('claimed','running','cancel_requested','uncertain') LIMIT 1",n.id)||!!await first(db,"SELECT thread_id FROM desktop_threads WHERE node=? AND status='running' AND status_source='app_server_runtime' AND observed_at>? LIMIT 1",n.id,new Date(Date.now()-120000).toISOString())||(parse(n.capabilities)?.transfers||[]).length>0;
 const rows=await all(db,`SELECT * FROM wake_actions a WHERE a.status IN(${ACTIVE}) AND a.expires_at>? AND EXISTS(SELECT 1 FROM json_each(a.relays) r WHERE json_extract(r.value,'$.nodeId')=?) AND NOT EXISTS(SELECT 1 FROM wake_receipts r WHERE r.action=a.id AND r.node=?) ORDER BY created_at LIMIT 4`,now(),n.id,n.id);
 const actions=[];
 for(const a of rows){const permitted=await first(db,`WITH ${CLAIM_ACTOR_TARGETS_SQL} SELECT 1 FROM claim_actor_targets WHERE creator=? AND target=?`,a.creator,a.node);
  const target=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',a.node);if(!permitted||!target||!parse(target.projects).some(x=>parse(n.projects).includes(x)))continue;
  const relay=parse(a.relays).find(r=>r.nodeId===n.id);actions.push({id:a.id,kind:'wake',targets:relay.targets,expiresAt:a.expires_at,expiresInMs:Math.max(0,Math.min(180000,Date.parse(a.expires_at)-Date.now()))});}
 return {policy:policy(p),busy,actions};
}
export async function wakeAck(db,n,id,b){
 nodeOnly(n);fields(b,['id','status','detail','evidence']);assert(id===b.id&&validId(id)&&['sent','failed','uncertain'].includes(b.status),'Invalid wake receipt');
 const action=await first(db,'SELECT * FROM wake_actions WHERE id=?',id);assert(action&&parse(action.relays).some(r=>r.nodeId===n.id),'Wake receipt not assigned to this node',403);
 assert(Array.isArray(b.evidence)&&b.evidence.length<=8,'Invalid packet evidence');
 const receipt={status:b.status,detail:cleanText(b.detail),evidence:b.evidence.map(e=>({networkId:cleanText(e.networkId,64),bytes:e.bytes,packets:e.packets}))};
 if(b.status==='sent')assert(receipt.evidence.length>0&&receipt.evidence.every(e=>e.bytes===102&&e.packets===3&&parse(action.relays).find(r=>r.nodeId===n.id).targets.some(t=>t.networkId===e.networkId)),'Invalid packet receipt');
 const digest=hash(json(receipt)),old=await first(db,'SELECT digest FROM wake_receipts WHERE action=? AND node=?',id,n.id);assert(!old||old.digest===digest,'Wake receipt changed',409);
 await run(db,'INSERT OR IGNORE INTO wake_receipts(action,node,status,receipt,digest,created_at) VALUES(?,?,?,?,?,?)',id,n.id,b.status,json(receipt),digest,now());
 const target=await first(db,'SELECT * FROM nodes WHERE id=?',action.node);await reconcile(db,target);return {ok:true};
}
