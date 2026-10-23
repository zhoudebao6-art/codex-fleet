import {assert,parse,json,hash,now,validId} from './util.mjs';
import {first,all,run} from './db.mjs';
import {nodeScope,assertNodeAccess} from './access.mjs';
import {can} from './auth.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {validateLocalControllers} from './delivery-routing.mjs';
import {runtimeIssue} from './runtime-readiness.mjs';
import {regionalOwner} from './regional-controllers.mjs';

const profileSkills={auto20:['software-case-batch-pro','software-case-batch'],software:['software-system-delivery']};
export async function deliveryIntegrations(db,actor){
 const config=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value)||{};
 const nodes=await all(db,`SELECT n.*,m.expires_at AS maintenance_expires FROM nodes n LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.revoked=0 AND ${nodeScope(actor,'n.id')} ORDER BY n.name,n.id`);
 const result=[];
 for(const n of nodes){
  const caps=parse(n.capabilities)||{},skills=[...new Set((caps.skills||[]).flatMap(s=>typeof s==='string'?[s]:s.names||[]))].sort();
  const rows=await all(db,"SELECT w.id,w.name,w.project,w.root,w.controller_thread_id,t.title AS controller_title FROM project_workspaces w LEFT JOIN desktop_threads t ON t.node=w.node AND t.thread_id=w.controller_thread_id WHERE w.node=? AND w.status='ready' AND (w.controller_thread_id IS NOT NULL OR w.name LIKE '%自动化%' OR w.name LIKE '%研发%' OR w.name LIKE '%图表%') ORDER BY w.name LIMIT 20",n.id);
  const bindings=(config.localControllers||[]).filter(b=>b.nodeId===n.id);
  const report=await first(db,"SELECT value FROM settings WHERE key=?",'delivery_integration:'+n.id),assessment=parse(report?.value);
  const task=assessment?await first(db,'SELECT status,result,thread_id FROM tasks WHERE id=?',assessment.taskId):null;
  const profiles=Object.entries(profileSkills).filter(([,names])=>names.some(s=>skills.includes(s))).map(([id])=>id);
  const region=config.regionalControllers?.find(r=>r.nodeId===n.id),expected=region?.profiles||profiles;
  const profileStates=Object.keys(profileSkills).map(profile=>({profile,installed:profiles.includes(profile),bound:bindings.some(b=>b.profile===profile),coordinator:regionalOwner(config,n,profile)?.nodeId||config.controller}));
  const gaps=[runtimeIssue(n,{parallel:true}),...expected.filter(p=>!profiles.includes(p)).map(p=>'缺少技能：'+p),...expected.filter(p=>!bindings.some(b=>b.profile===p)).map(p=>'待绑定原总控：'+p)].filter(Boolean);
  const active=task&&['queued','claimed','running','uncertain','cancel_requested'].includes(task.status);
  const configured=expected.length>0&&expected.every(p=>profiles.includes(p)&&bindings.some(b=>b.profile===p));
  result.push({nodeId:n.id,name:n.display_name||n.name,online:!!n.last_seen&&Date.now()-Date.parse(n.last_seen)<60000,ready:!runtimeIssue(n,{parallel:true}),
   skills,profiles,profileStates,gaps,role:n.id===config.controller?'master':region?'regional':'worker',region:region||null,
   managedDevices:region?nodes.filter(peer=>peer.id!==config.controller&&region.groupIds.includes(peer.display_group_id)).map(peer=>({nodeId:peer.id,name:peer.display_name||peer.name,excluded:config.excludedNodes?.includes(peer.id)||false})):[],
   candidates:rows.filter(w=>can(actor,w.project)),bindings,excluded:(config.excludedNodes||[]).includes(n.id),
   state:(config.excludedNodes||[]).includes(n.id)?'excluded':configured?'configured':active?'assessing':bindings.length?'partial':!profiles.length?'preparing':'unassigned',
   fingerprint:hash(json({version:caps.version,bridge:caps.desktopSessionBridge===true,profiles,bindings:bindings.map(b=>[b.profile,b.threadId]),region})),
   assessment:assessment?{taskId:assessment.taskId,status:task?.status||'pending',error:assessment.error||null,summary:parse(task?.result)?.summary?.slice(0,1200)||null}:null});
 }
 return {devices:result,autoDiscover:config.autoDiscover===true};
}
export async function bindLocalIntegration(db,actor,b){
 assert(!actor.browser&&!actor.admin,'Master node identity required',403);
 const config=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 assert(config?.controller===actor.id,'Only the configured master may arrange a local controller',403);
 assert(b&&validId(b.probeTaskId),'Provide a real original-conversation readiness receipt');
 const binding=(await validateLocalControllers(db,actor,[b]))[0];
 assert(!config.excludedNodes.includes(binding.nodeId),'This computer is excluded',409);
 const proof=await first(db,'SELECT * FROM tasks WHERE id=?',b.probeTaskId),p=parse(proof?.spec),r=parse(proof?.result);
 assert(proof?.creator===actor.id&&proof.target===binding.nodeId&&['submitted','accepted'].includes(proof.status)&&p?.desktopThreadId===binding.threadId&&proof.thread_id===binding.threadId&&r?.desktop?.sameThread===true&&r.desktop.state==='continued'&&!r.deliveryOnly,'Confirm a completed reply from this exact original conversation first',409);
 const localControllers=[...(config.localControllers||[]).filter(x=>x.nodeId!==binding.nodeId||x.profile!==binding.profile),{...binding,readinessTaskId:b.probeTaskId}];
 // Compare-and-swap avoids losing another operator's settings or bindings.
 const old=json(config),next=json({...config,localControllers});
 await run(db,"UPDATE settings SET value=? WHERE key='delivery_controller' AND value=?",next,old);
 assert((parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value)?.localControllers||[]).some(x=>x.nodeId===binding.nodeId&&x.profile===binding.profile&&x.threadId===binding.threadId),'Configuration changed; reread and retry',409);
 return {ok:true,binding};
}
export async function assessNewDeliveryDevices(db,actor){
 const config=parse((await first(db,"SELECT value FROM settings WHERE key='delivery_controller'"))?.value);
 if(config?.controller!==actor.id||!config.autoDiscover)return;
 const master=(config.localControllers||[]).find(b=>b.nodeId===actor.id);
 if(!master)return;
 const clock='delivery_discovery_tick:'+actor.id,last=await first(db,'SELECT value FROM settings WHERE key=?',clock);
 if(last&&Date.now()-Number(last.value)<60000)return;
 await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',clock,String(Date.now()));
 const {devices}=await deliveryIntegrations(db,actor);
 for(const d of devices){
  if(d.nodeId===actor.id||d.excluded||d.state==='configured'||!d.online||!d.ready||!d.profiles.length)continue;
  await assertNodeAccess(db,actor,d.nodeId);
  const key='delivery_integration:'+d.nodeId,existing=parse((await first(db,'SELECT value FROM settings WHERE key=?',key))?.value);
  const prior=existing&&await first(db,'SELECT status FROM tasks WHERE id=?',existing.taskId);
  if(prior&&(existing.fingerprint===d.fingerprint||['queued','claimed','running','uncertain','blocked','cancel_requested'].includes(prior.status)))continue;
  const taskId='integration-'+hash(actor.id+':'+d.nodeId+':'+d.fingerprint).slice(0,40);
  const prompt=`设备协同评估：${d.name}，角色 ${d.role}。只处理新增或变化的能力，不重跑维护测试。PC-01 保持全局派发、技能发布与最终汇总；区域协调节点只协调其配置的分组及自动化，不擅自接管其他设备。核实当地已有项目、技能和原总控，优先复用。保留正在运行的工作、账号和未发布修改，不复制其他电脑配置，不启动案件制作。\n先用 fleet_projects、fleet_desktop_tasks/read 查明原对话。每个缺失的自动化绑定分别用 fleet_desktop_message 固定编号 ${taskId}-<profile>-probe 做有限只读接单核验；真实完成后用本机 D:\\CodexFleet\\app\\scripts\\Configure-LocalController.mjs --node <设备ID> --profile <auto20或software> --workspace <已核实ID> --thread <原总控ID> --proof <探测任务ID> 登记。没有原总控或联动不可用就报告具体缺项，不猜测。技能以主控本机已发布 GitHub 的固定提交为准，未发布本机变化不能被远端覆盖。\n资料仅供核实：${json({nodeId:d.nodeId,profiles:d.profiles,profileStates:d.profileStates,gaps:d.gaps,region:d.region,candidates:d.candidates})}`;
  const record={taskId,prompt,fingerprint:d.fingerprint,createdAt:now()};
  await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,json(record));
  try{await continueDesktop(db,actor,actor.id,master.threadId,{id:taskId,prompt});}catch(e){
   await run(db,'UPDATE settings SET value=? WHERE key=?',json({...record,error:String(e.message).slice(0,500)}),key);
  }
  break;
 }
}
