"use client";
import {useCallback, useEffect, useRef, useState} from "react";
import {ArrowRight, Check, Download, FileUp, FolderOpen, Monitor, PackageCheck, Pause, Play, Plus, RefreshCw, Settings2, X} from "lucide-react";
import {api, mutation, uploadFile, uid, errorText, time, bytes} from "./api";
import {Modal, Notice, Empty} from "./ui";
import type {FleetNode, InputFile, User} from "./types";
import ControllerRecovery from "./ControllerRecovery";
import {RuntimeBadge} from "./RuntimeStatus";
import DetailTabs from "./DetailTabs";
import CaseCenter from "./CaseCenter";
import SkillMaintenance, {type MaintenanceRequest,type MaintenancePolicy} from "./SkillMaintenance";
import {runtimeIssue} from "../../lib/fleet/runtime-readiness.mjs";

type Profile={id:string;name:string;description:string;deliverables:string[]};
type LocalController={nodeId:string;profile:string;workspaceId:string;threadId:string;title?:string;workspaceName?:string};
type Region={nodeId:string;groupIds:string[];profiles:string[]};
type Settings={controller:string;excludedNodes:string[];dispatchMode?:"direct"|"local-controller";allowControllerWork?:boolean;autoDiscover?:boolean;localControllers?:LocalController[];regionalControllers?:Region[]};
type Integration={nodeId:string;name:string;state:string;profiles:string[];bindings:LocalController[];ready:boolean;role?:string;gaps?:string[];managedDevices?:{nodeId:string;name:string;excluded:boolean}[];assessment?:{taskId:string;status:string;summary?:string}|null};
type ControllerState=LocalController&{assigned:number;total:number;state:string;messages:{taskId:string;status:string;error?:string}[]};
type Job={id:string;phase:string;itemIndex:number;node:string;attempt:number;taskId:string;status:string;error?:string};
type Resolution={id:string;note:string;at:string};
type DeliveryProgress={message:string;at:string;node:string;taskId:string|null};
type LoopIssue={id:string;jobId:string;kind:string;state:string;detail:string;taskId?:string;at:string;report?:{note:string;learning:string}};
type Batch={dispatchPolicy?:string;skillSourceNodes?:string[];project?:string;supplemental?:{text:string;attachments:InputFile[]};supplementSource?:{batchId:string;batchName:string;itemIndex:number;taskId:string;input:InputFile;frozenAt:string};id:string;name:string;profile:string;mode:string;nodes:string[];status:string;controller:string;controllerOnline:boolean;controllerReady:boolean;controllers?:ControllerState[];loop?:{perDevice:number;issues:LoopIssue[]}|null;inputs:InputFile[];notes:string;requirements?:string[];jobs:Job[];resolutions?:Resolution[];latestProgress?:DeliveryProgress|null;error?:string;updatedAt:string;createdAt:string;baseline?:{commit:string};collected?:{relativeDirectory:string};files:(InputFile&{taskId:string;itemIndex:number})[]};
const labels:Record<string,string>={superseded:"已接续新版本",baseline:"核对版本",preflight:"准备设备",producing:"制作中",received:"总控已接收",collecting:"回传主控",completed:"已交付",needs_attention:"需要处理",paused:"已暂停",cancelling:"正在停止",cancelled:"已停止",planned:"等待本机派发",queued:"待发送",claimed:"已接收",running:"正在执行",submitted:"正在核验",verified:"核验通过",failed:"执行失败",blocked:"需要处理",uncertain:"待核实",accepted:"核验通过",continued:"已接续"};
type SkillCycle={id:string;profile:string;mode:string;state:string;error?:string;attempt:number;result?:{commit:string};steps:{id:string;phase:string;node:string;status:string;attempt:number}[]};
const skillPhases=["repair","review","publish","canary","sync"];
const skillLabels:Record<string,string>={repair:"候选修复",review:"独立审核",publish:"发布",canary:"分控试用",sync:"主控同步",completed:"已完成",paused:"已暂停",cancelled:"已停止",needs_attention:"需核实"};
const stages=["baseline","preflight","producing","collecting","completed"];
function BatchNote({busy,onSend}:{busy:boolean;onSend:(body:{id:string;prompt:string})=>Promise<void>}){
 const [text,setText]=useState("");const request=useRef(uid());
 return <form className="delivery-form" onSubmit={async e=>{e.preventDefault();if(!text.trim()||busy)return;try{await onSend({id:request.current,prompt:text.trim()});setText("");request.current=uid();}catch{}}}>
  <label>追加要求<textarea aria-label="给原总控追加要求" placeholder="直接发给本批各机原总控，接着当前工作处理" value={text} disabled={busy} maxLength={6000} onChange={e=>{setText(e.target.value);request.current=uid();}}/></label>
  <button className="button secondary" disabled={busy||!text.trim()}>发送给原总控</button>
 </form>;
}
const device=(nodes:FleetNode[],id:string)=>{const n=nodes.find(n=>n.id===id);return n?.displayName||n?.code||n?.name||"未连接设备";};
const sourceJobs=(batch:Batch)=>batch.jobs.filter(j=>j.phase==="produce"&&j.status==="verified"&&batch.files.some(f=>f.taskId===j.taskId));
const makers=(batch:Batch)=>[...new Set(batch.jobs.filter(j=>j.phase==="produce").map(j=>j.node))];
export default function DeliveryCenter({nodes,user,onTask}:{nodes:FleetNode[];user:User;onTask:(id:string)=>void}){
 const [batches,setBatches]=useState<Batch[]>([]),[profiles,setProfiles]=useState<Profile[]>([]),[settings,setSettings]=useState<Settings|null>(null);
 const [error,setError]=useState(""),[composer,setComposer]=useState<string|null>(null),[selected,setSelected]=useState<Batch|null>(null),[config,setConfig]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [cursor,setCursor]=useState<number|null>(null),loaded=useRef(30),inflight=useRef(false);
 const [supplementBatch,setSupplementBatch]=useState<Batch|null>(null);
 const [recoveryOpen,setRecoveryOpen]=useState(false);
 const [cycles,setCycles]=useState<SkillCycle[]>([]);
 const [maintenance,setMaintenance]=useState<MaintenanceRequest[]>([]);
 const [maintenancePolicies,setMaintenancePolicies]=useState<MaintenancePolicy[]>([]);
 const [view,setView]=useState("cases"),[query,setQuery]=useState(""),[stateFilter,setStateFilter]=useState("all"),[modeFilter,setModeFilter]=useState("production");
 const lastConfig=useRef(0),visibleView=useRef(view);visibleView.current=view;
 const [batchTab,setBatchTab]=useState("progress"),[confirmStop,setConfirmStop]=useState(false);
 const openBatch=(batch:Batch)=>{setSelected(batch);setBatchTab(batch.status==="completed"?"files":"progress");setConfirmStop(false);};
 const openCaseBatch=async(id:string)=>{const existing=batches.find(b=>b.id===id);if(existing){openBatch(existing);return;}try{openBatch(await api<Batch>(`/v1/deliveries/${encodeURIComponent(id)}`));}catch(e){setError(errorText(e));}};
 const openTask=(id:string)=>{setSelected(null);onTask(id);};
 const [integrations,setIntegrations]=useState<Integration[]>([]);
 useEffect(()=>{let alive=true;const read=()=>api<{devices:Integration[]}>("/v1/delivery/integration").then(r=>{if(alive)setIntegrations(r.devices);}).catch(()=>{});void read();const timer=setInterval(()=>{if(document.visibilityState==="visible")void read();},30000);return()=>{alive=false;clearInterval(timer);};},[]);
 const refresh=useCallback(async()=>{
  if(inflight.current)return;inflight.current=true;
  try{
   const results=await Promise.allSettled([api<{batches:Batch[];nextCursor:number|null}>(`/v1/deliveries?limit=${loaded.current}`),Date.now()-lastConfig.current>60000?api<{profiles:Profile[];settings:Settings|null}>("/v1/delivery/settings"):Promise.resolve(null),visibleView.current==="maintenance"?api<{cycles:SkillCycle[]}>("/v1/skill-cycles"):Promise.resolve(null),visibleView.current==="maintenance"?api<{requests:MaintenanceRequest[];policies:MaintenancePolicy[]}>("/v1/skill-maintenance"):Promise.resolve(null)]);
   const [list,setup,skillList,maintenanceList]=results;
   if(list.status==="fulfilled"){setBatches(list.value.batches);setCursor(list.value.nextCursor);setSelected(old=>old?list.value.batches.find(b=>b.id===old.id)||old:null);}
   if(setup.status==="fulfilled"&&setup.value){lastConfig.current=Date.now();setProfiles(setup.value.profiles);setSettings(setup.value.settings);}
   if(skillList.status==="fulfilled"&&skillList.value)setCycles(skillList.value.cycles);
   if(maintenanceList.status==="fulfilled"&&maintenanceList.value){setMaintenancePolicies(maintenanceList.value.policies||[]);setMaintenance(maintenanceList.value.requests);}
   setError(results.flatMap((r,i)=>r.status==="rejected"?[`${["交付记录","主控设置","维护流程","维护需求"][i]}同步失败：${errorText(r.reason)}`]:[]).join("；"));
  }catch(e){setError(errorText(e));}finally{inflight.current=false;setLoading(false);}
 },[]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},10000);return()=>clearInterval(timer);},[refresh]);
 useEffect(()=>{void refresh();},[view,refresh]);
 const control=async(b:Batch,action:string,body:unknown={})=>{setBusy(true);try{await mutation(`/v1/deliveries/${b.id}/${action}`,body);await refresh();}catch(e){setError(errorText(e));if(action==="retry"||action==="message")throw e;}finally{setBusy(false);}};
 const active=batches.filter(b=>!["completed","cancelled","superseded"].includes(b.status)).length;
 const pendingMaintenance=maintenance.filter(r=>!["completed","cancelled","no_maintenance"].includes(r.state)).length;
 const filteredBatches=batches.filter(b=>{
  const q=query.trim().toLocaleLowerCase();
  const matchesState=stateFilter==="all"||(stateFilter==="active"?!["completed","cancelled","superseded"].includes(b.status):b.status===stateFilter);
  return matchesState&&(modeFilter==="all"||(modeFilter==="probe"?b.mode==="probe":b.mode!=="probe"))&&(!q||`${b.name} ${b.inputs.map(f=>f.name).join(" ")}`.toLocaleLowerCase().includes(q));
 });
 return <div className="delivery-center">
  <div className="delivery-commandbar"><div className="delivery-control-status"><Monitor size={16}/><span>{settings?`主控 ${device(nodes,settings.controller)}`:"未设置主控"}</span>{view!=="cases"&&<span>{active} 个交付批次进行中</span>}{settings&&<RuntimeBadge node={nodes.find(n=>n.id===settings.controller)}/>}</div><div className="delivery-actions"><button className="button secondary" aria-label="刷新交付" onClick={()=>void refresh()}><RefreshCw size={16}/>刷新</button>{user.role==="admin"&&<button className="button secondary" onClick={()=>setRecoveryOpen(true)}>总控恢复</button>}{user.role==="admin"&&<button className="button secondary" onClick={()=>setConfig(true)}><Settings2 size={16}/>主控设置</button>}</div></div>
  {error&&<Notice>{error}</Notice>}
  {view==="batches"&&<div className="delivery-create-actions">{profiles.map(p=><button key={p.id} className="button primary" disabled={user.role==="viewer"||!settings} onClick={()=>setComposer(p.id)}><Plus size={16}/>{p.name}</button>)}</div>}
  <DetailTabs label="自动交付分区" value={view} onChange={setView} items={[{id:"cases",label:"案件档案"},{id:"batches",label:"交付批次",count:batches.length},{id:"devices",label:"设备协同",count:integrations.length},{id:"maintenance",label:"技能改进",count:pendingMaintenance}]} />
  {view==="cases"&&<CaseCenter nodes={nodes} user={user} batches={batches} onBatch={id=>void openCaseBatch(id)} onTask={onTask} onChanged={refresh}/>}
  <div className="delivery-view" hidden={view!=="devices"}>
  {!!integrations.length&&<details className="delivery-integration" open><summary>协同节点 <small>{integrations.filter(d=>d.state==="configured"&&d.ready).length} 台已准备</small></summary><div>{integrations.map(d=><div className="delivery-controller-row" key={d.nodeId}><Monitor size={17}/><div><strong>{device(nodes,d.nodeId)} · {d.role==="master"?"全局主控":d.role==="regional"?"区域协调":"执行节点"}</strong><small>{d.state==="excluded"?"已暂停评估和派发":d.gaps?.length?d.gaps.join(" · ").replaceAll("auto20","自动化 2.0").replaceAll("software","研发交付"):d.bindings.map(b=>`${profiles.find(p=>p.id===b.profile)?.name||b.profile} → ${b.title||"原对话"}`).join("；")}</small>{d.role==="regional"&&<small>区域设备：{d.managedDevices?.length?d.managedDevices.map(n=>`${device(nodes,n.nodeId)}${n.excluded?"（暂停）":""}`).join("、"):"等待新设备加入管理分组"}</small>}</div><span>{({configured:d.ready?"已准备":"等待连接",excluded:"暂不参与",preparing:"接入准备",partial:"部分就绪",discovering:"读取环境",assessing:"主控评估",unassigned:"待编组"} as Record<string,string>)[d.state]||d.state}</span>{d.assessment&&<button className="button secondary" onClick={()=>onTask(d.assessment!.taskId)}>评估记录</button>}</div>)}</div></details>}
  </div>
  <div className="delivery-view" hidden={view!=="maintenance"}>
  <SkillMaintenance requests={maintenance} policies={maintenancePolicies} cycles={cycles} profiles={profiles} batches={batches} nodes={nodes} user={user} enabled={!!settings} onTask={onTask} refresh={refresh}/>
  </div>
  <div className="delivery-view" hidden={view!=="batches"}>
  <div className="delivery-filterbar"><input type="search" aria-label="搜索交付批次" placeholder="搜索批次或材料" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="交付状态" value={stateFilter} onChange={e=>setStateFilter(e.target.value)}><option value="all">全部状态</option><option value="active">进行中</option><option value="needs_attention">需要处理</option><option value="completed">已交付</option><option value="paused">已暂停</option><option value="cancelled">已停止</option><option value="superseded">已接续</option></select><select aria-label="交付类型" value={modeFilter} onChange={e=>setModeFilter(e.target.value)}><option value="production">正式交付</option><option value="probe">短流程验证</option><option value="all">全部类型</option></select></div>
  <div className="delivery-result-count"><span>显示 {filteredBatches.length} / 已载入 {batches.length} 项</span>{(query||stateFilter!=="all"||modeFilter!=="all")&&<button className="text-button" onClick={()=>{setQuery("");setStateFilter("all");setModeFilter("all");}}>显示全部</button>}</div>
  {!filteredBatches.length?<Empty icon={<FolderOpen/>} title={loading?"正在读取交付记录":batches.length?"没有匹配的批次":"暂无交付批次"}/>:<div className="delivery-batch-list">{filteredBatches.map(b=><button key={b.id} className="delivery-batch-row" onClick={()=>openBatch(b)}>
   <div className="batch-row-main"><h3>{b.name}{b.supplementSource&&<small className="delivery-supplement-tag">补充交付</small>}</h3><span>{profiles.find(p=>p.id===b.profile)?.name} · {b.inputs.length} 件材料{b.mode==="probe"?" · 短流程验证":""}</span>{b.latestProgress&&<p>{b.latestProgress.message}</p>}{b.error&&<p className="delivery-warning">{b.error}</p>}</div>
   <div className="batch-row-status"><span className={`delivery-state state-${b.status}`}><i/>{labels[b.status]||b.status}</span><small>{time(b.updatedAt||b.createdAt)}</small></div>
   <div className="batch-row-files"><strong>{b.files.filter(f=>f.name.endsWith(".zip")).length}</strong><small>交付包</small></div><ArrowRight size={17}/>
  </button>)}</div>}
  {cursor!==null&&loaded.current<100&&<button className="button secondary" onClick={()=>{loaded.current=Math.min(100,loaded.current+30);void refresh();}}>加载更多</button>}
  </div>
  {composer&&settings&&<DeliveryComposer profile={profiles.find(p=>p.id===composer)!} settings={settings} nodes={nodes} user={user} onClose={()=>setComposer(null)} onCreated={b=>{setComposer(null);openBatch(b);void refresh();}}/>}
  {supplementBatch&&settings&&profiles.find(p=>p.id===supplementBatch.profile)&&<DeliveryComposer source={supplementBatch} profile={profiles.find(p=>p.id===supplementBatch.profile)!} settings={settings} nodes={nodes} user={user} onClose={()=>{openBatch(supplementBatch);setSupplementBatch(null);}} onCreated={b=>{setSupplementBatch(null);openBatch(b);void refresh();}}/>}
  {recoveryOpen&&<ControllerRecovery onClose={()=>setRecoveryOpen(false)} onChanged={()=>{lastConfig.current=0;void refresh();}}/>}
  {config&&<ControllerSettings nodes={nodes} profiles={profiles} value={settings} onClose={()=>setConfig(false)} onSave={async value=>{await mutation("/v1/delivery/settings",value);setConfig(false);lastConfig.current=0;await refresh();}}/>}
  {selected&&<Modal title={selected.name} onClose={()=>setSelected(null)} wide busy={busy}><div className="delivery-detail">
   <div className="delivery-detail-top"><span className={`delivery-state state-${selected.status}`}><i/>{labels[selected.status]||selected.status}</span><span>{selected.supplementSource?"补充交付":selected.mode==="probe"?"仅短流程验证":"完整交付"} · {selected.inputs.length} 件</span></div>
   {error&&<Notice>{error}</Notice>}
   {selected.supplementSource&&<div className="delivery-supplement-source"><strong>补充交付 · 原版本保留</strong><span>{selected.supplementSource.batchName} · {selected.supplementSource.input.name}</span><small>来源版本：{selected.supplementSource.taskId} · {time(selected.supplementSource.frozenAt)}</small></div>}
   {user.role!=="viewer"&&settings&&sourceJobs(selected).length>0&&<div className="delivery-actions"><button className="button secondary" onClick={()=>{setSupplementBatch(selected);setSelected(null);}}><Plus size={16}/>补充需求</button></div>}
   <div className="batch-next-step"><strong>{selected.status==="completed"?"交付已归集":selected.status==="paused"?"等待核对后继续":selected.status==="needs_attention"?"先处理下方异常":!selected.controllerOnline?"等待总控恢复连接":selected.status==="collecting"?"等待总控校验并保存文件":selected.status==="producing"?(selected.dispatchPolicy==="batch-controller-v1"?"原总控安排制作，完成后回传":"等待制作与验收结果"):"正在核对版本与设备"}</strong><span>负责总控：{device(nodes,selected.controller)}</span></div>
   {selected.error&&<Notice>{selected.error}</Notice>}
   {selected.status==="needs_attention"&&selected.dispatchPolicy!=="batch-controller-v1"&&user.role!=="viewer"&&<DeliveryResolution batch={selected} busy={busy} onRetry={body=>control(selected,"retry",body)}/>}
   {selected.status==="needs_attention"&&user.role!=="viewer"&&selected.jobs.some(j=>j.phase==="produce"&&j.status==="submitted")&&<button className="button secondary" disabled={busy} onClick={()=>void control(selected,"recheck")}><RefreshCw size={16}/>重新核验已提交文件</button>}
   <DetailTabs label="批次详情分区" value={batchTab} onChange={setBatchTab} items={[{id:"progress",label:"执行进度"},{id:"files",label:"交付文件",count:selected.files.filter(f=>f.name.endsWith(".zip")).length},{id:"materials",label:"材料与要求",count:selected.inputs.length},{id:"receipts",label:"版本与收据"}]} />
   <div className="detail-tab-panel" hidden={batchTab!=="progress"}>
   <p>主控 {device(nodes,selected.controller)} · 制作 {makers(selected).length?makers(selected).map(id=>device(nodes,id)).join("、"):"等待分工"}</p>
   {!!selected.controllers?.length&&<div className="delivery-controller-chain"><h3>各机技能总控</h3>{selected.controllers.map(c=><div key={c.nodeId} className="delivery-controller-row"><Monitor size={18}/><div><strong>{device(nodes,c.nodeId)} · {c.title}</strong><small>{c.workspaceName} · {c.assigned}/{c.total} 项已交接</small></div><span>{c.state==="delegated"?(selected.dispatchPolicy==="batch-controller-v1"?"批次已交接":"子任务已派发"):c.state==="message_received"?"已接单，等待派发":c.state==="needs_attention"?"接单需核实":"等待接单"}</span>{c.messages.at(-1)&&<button className="button secondary" onClick={()=>openTask(c.messages.at(-1)!.taskId)}>查看接单</button>}</div>)}</div>}
   {selected.loop&&<div className="delivery-loop-panel"><h3>协同闭环</h3><p className="muted">按可用容量分派 · 每台同类任务最多 {selected.loop.perDevice} 件并行 · 主控校验汇总</p>{!selected.loop.issues.length?<p className="muted">当前没有待恢复事项。</p>:selected.loop.issues.map(i=><details key={i.id}><summary><span>{({diagnosing:"主控诊断中",observing:"跟踪原任务",needs_input:"需要补充",resolved:"已恢复",repairing:"技能修复中"} as Record<string,string>)[i.state]||i.state}</span> · {selected.jobs.find(j=>j.id===i.jobId)?.phase==="preflight"?"环境核对":selected.inputs[selected.jobs.find(j=>j.id===i.jobId)?.itemIndex??0]?.name}</summary><p>{i.report?.note||i.detail}</p>{i.report?.learning&&<p className="delivery-notes">修复记录：{i.report.learning}</p>}{i.taskId&&<button className="button secondary" onClick={()=>openTask(i.taskId!)}>查看主控排障</button>}</details>)}</div>}
   {selected.latestProgress&&<div className="delivery-latest delivery-latest-detail"><small>当前进度 · {time(selected.latestProgress.at)}</small><p>{selected.latestProgress.message}</p></div>}
   {!!selected.skillSourceNodes?.length&&<p className="muted">{selected.skillSourceNodes.map(id=>device(nodes,id)).join("、")} · 发布源直接制作</p>}<h3>执行记录</h3>{selected.dispatchPolicy==="batch-controller-v1"&&user.role!=="viewer"&&["producing","needs_attention"].includes(selected.status)&&<BatchNote key={selected.id} busy={busy} onSend={body=>control(selected,"message",body)}/>}{!selected.jobs.length?<p className="muted">{selected.dispatchPolicy==="batch-controller-v1"?"等待交接给所选设备的原总控。":selected.baseline?.commit==="local-source"?"等待本机总控派发制作。":"主控正在读取本轮 GitHub 版本。"}</p>:selected.jobs.slice().sort((a,b)=>Number(b.phase==="produce")-Number(a.phase==="produce")||b.attempt-a.attempt).map(j=><button key={j.id} className="delivery-job" onClick={()=>openTask(j.taskId)}><span><strong>{j.phase==="preflight"?"技能与环境核对":selected.inputs[j.itemIndex]?.name||"制作"}{j.attempt>0?` · 第 ${j.attempt} 次返修`:""}</strong><small>{device(nodes,j.node)}{j.error?` · ${j.error}`:""}</small></span><span>{labels[j.status]||j.status}<ArrowRight size={14}/></span></button>)}
   </div><div className="detail-tab-panel" hidden={batchTab!=="files"}>
   <h3>交付文件</h3>{selected.files.filter(f=>f.name.endsWith(".zip")).length?selected.files.filter(f=>f.name.endsWith(".zip")).map(f=><a className="delivery-file" key={f.taskId+f.itemIndex+f.sha} href={`/v1/artifacts/${f.sha}?task=${encodeURIComponent(f.taskId)}`} download><PackageCheck size={18}/><span>{selected.inputs[f.itemIndex]?.name.replace(/\.[^.]+$/,"")} · 交付包<small>{bytes(f.size)}</small></span><Download size={18}/></a>):<p className="muted">文件回传完成后显示在这里。</p>}
   {selected.collected&&<Notice tone="success">已汇总到 {device(nodes,selected.controller)}：{selected.collected.relativeDirectory}</Notice>}
   </div><div className="detail-tab-panel" hidden={batchTab!=="materials"}>
   <h3>材料与要求</h3>{selected.inputs.map(f=><div className="delivery-input-row" key={f.sha}><FileUp size={16}/><span>{f.name}</span><small>{bytes(f.size)}</small></div>)}
   {selected.requirements?.length? <p>附加交付：{selected.requirements.map(x=>x==="model"?"模型图":"仿真图").join("、")}</p>:null}
   {selected.resolutions?.map(r=><details key={r.id}><summary>补充要求 · {time(r.at)}</summary><p className="delivery-notes">{r.note}</p></details>)}
   {selected.supplemental&&(selected.supplemental.text||selected.supplemental.attachments.length>0)&&<section className="delivery-supplement-source"><strong>补充需求与反馈</strong>{selected.supplemental.text&&<p className="delivery-notes">{selected.supplemental.text}</p>}{selected.supplemental.attachments.map(f=><div className="delivery-input-row" key={f.sha}><FileUp size={16}/><span>{f.name}</span><small>{bytes(f.size)}</small></div>)}</section>}
   {selected.notes&&<details><summary>原始要求</summary><p className="delivery-notes">{selected.notes}</p></details>}
   </div><div className="detail-tab-panel" hidden={batchTab!=="receipts"}>
   <details open><summary>版本与收据</summary><p>{selected.dispatchPolicy==="batch-controller-v1"?"按批次交接 · 原总控安排制作 · 主控汇总文件":selected.baseline?.commit==="local-source"?"技能来源：本机发布源":"固定提交："+(selected.baseline?.commit||"正在核对")}</p>{selected.files.filter(f=>f.name.endsWith(".json")).map(f=><a key={f.sha} href={`/v1/artifacts/${f.sha}?task=${encodeURIComponent(f.taskId)}`}>材料 {f.itemIndex+1} · 交付收据</a>)}</details>
   </div>
   {user.role!=="viewer"&&!["completed","cancelled","superseded"].includes(selected.status)&&<div className="delivery-actions">{(selected.status==="paused"||(selected.dispatchPolicy==="batch-controller-v1"&&selected.status==="needs_attention"))?<button className="button secondary" disabled={busy} onClick={()=>void control(selected,"resume")}><Play size={16}/>继续</button>:stages.includes(selected.status)&&<button className="button secondary" disabled={busy} onClick={()=>void control(selected,"pause")}><Pause size={16}/>暂停后续派发</button>}<button className="button secondary" disabled={busy||selected.status==="cancelling"} onClick={()=>setConfirmStop(true)}><X size={16}/>停止本批</button></div>}
   {confirmStop&&<div className="batch-stop-confirm" role="alert"><strong>停止后不再派发本批后续任务，已有文件与记录保留。</strong><div className="delivery-actions"><button className="button secondary" disabled={busy} onClick={()=>setConfirmStop(false)}>返回</button><button className="button danger" disabled={busy} onClick={()=>void control(selected,"cancel").then(()=>setConfirmStop(false))}>确认停止本批</button></div></div>}
  </div></Modal>}
 </div>;
}
function DeliveryResolution({batch,busy,onRetry}:{batch:Batch;busy:boolean;onRetry:(body:unknown)=>Promise<void>}){
 const candidates=batch.jobs.filter(j=>j.phase==="produce"&&["submitted","failed"].includes(j.status)&&!batch.jobs.some(k=>k.phase==="produce"&&k.itemIndex===j.itemIndex&&k.attempt>j.attempt));
 const [taskId,setTaskId]=useState(candidates[0]?.taskId||""),[note,setNote]=useState(""),[error,setError]=useState("");
 const request=useRef(uid());
 if(!candidates.length)return null;
 return <details className="delivery-resolution"><summary>问题处理后继续</summary><form className="delivery-form" onSubmit={async e=>{e.preventDefault();setError("");try{await onRetry({id:request.current,taskId,note});}catch(e){setError(errorText(e));}}}>
  <p className="muted">保留原项目和成果，按剩余返修次数接续。</p>{error&&<Notice>{error}</Notice>}
  <label>继续的材料<select value={taskId} disabled={busy} onChange={e=>{setTaskId(e.target.value);request.current=uid();}}>{candidates.map(j=><option value={j.taskId} key={j.taskId}>{batch.inputs[j.itemIndex]?.name}</option>)}</select></label>
  <label>已解决的问题<textarea required minLength={10} maxLength={6000} disabled={busy} value={note} onChange={e=>{setNote(e.target.value);request.current=uid();}} placeholder="说明已补充的信息或已完成的修复，后续任务会读取这段说明。"/></label>
  <button className="button primary" disabled={busy||note.trim().length<10}>继续本批</button>
 </form></details>;
}
function DeliveryComposer({profile,settings,nodes,user,source,onClose,onCreated}:{source?:Batch;profile:Profile;settings:Settings;nodes:FleetNode[];user:User;onClose:()=>void;onCreated:(b:Batch)=>void}){
 const [name,setName]=useState(source?`${source.name} · 补充交付`.slice(0,120):""),[notes,setNotes]=useState(""),[files,setFiles]=useState<File[]>([]);
 const versions=source?sourceJobs(source).sort((a,b)=>b.attempt-a.attempt):[];
 const [sourceTaskId,setSourceTaskId]=useState(versions[0]?.taskId||"");
 const [sourceItemIndex,setSourceItemIndex]=useState(versions[0]?.itemIndex??0);
 const sourceJob=versions.find(j=>j.taskId===sourceTaskId&&j.itemIndex===sourceItemIndex);
 const [supplementalText,setSupplementalText]=useState(""),[attachments,setAttachments]=useState<File[]>([]);
 const project=source?.project||source?.inputs[0]?.project||"workspace";
 const [selection,setSelection]=useState<string[]>([]),[automatic,setAutomatic]=useState(true),[busy,setBusy]=useState(false),[progress,setProgress]=useState(""),[error,setError]=useState("");
 const [groupId,setGroupId]=useState(user.access?.mode==="groups"?user.access.groupIds[0]||"":"");
 const request=useRef<{id:string;body?:unknown}>({id:uid()});
 const workers=nodes.filter(n=>(settings.allowControllerWork||n.id!==settings.controller)&&!settings.excludedNodes.includes(n.id)&&n.projects.includes(project));
 const binding=(id:string)=>settings.localControllers?.find(b=>b.nodeId===id&&b.profile===profile.id);
 const workerIssue=(n:FleetNode)=>runtimeIssue(n,{parallel:true})||(!binding(n.id)?"尚未绑定本地总控":null);
 const ready=workers.filter(n=>!workerIssue(n)),targets=automatic?ready.map(n=>n.id).slice(0,8):selection.filter(id=>ready.some(n=>n.id===id));
 const valid=!!name.trim()&&targets.length>0&&(!attachments.length||!!(source?notes:supplementalText).trim())&&(source?!!sourceJob&&notes.trim().length>=10:files.length>0);
 const submit=async()=>{
  if(!valid)return;setBusy(true);setError("");
  try{
   let body=request.current.body;
   if(!body){
    const inputs:InputFile[]=[],feedback:InputFile[]=[];
    for(const file of files)inputs.push(await uploadFile(file,project,p=>setProgress(`${file.name} · ${p.text} ${p.percent}%`),groupId||undefined));
    for(const file of attachments)feedback.push(await uploadFile(file,project,p=>setProgress(`${file.name} · ${p.text} ${p.percent}%`),groupId||undefined));
    body=source?{dispatchPolicy:"batch-controller-v1",id:request.current.id,name:name.trim(),itemIndex:sourceJob!.itemIndex,sourceTaskId:sourceJob!.taskId,nodes:targets,notes:notes.trim(),attachments:feedback,maxRepairs:2}:
     {dispatchPolicy:"batch-controller-v1",id:request.current.id,name:name.trim(),profile:profile.id,mode:"production",project,nodes:targets,inputs,notes,requirements:[],...(profile.id==="software"?{requirementsMode:"source-led-v1"}:{}),...(supplementalText.trim()||feedback.length?{supplemental:{text:supplementalText.trim(),attachments:feedback}}:{}),maxRepairs:2};
    request.current.body=body;
   }
   setProgress("正在提交");onCreated(await mutation<Batch>(source?`/v1/deliveries/${encodeURIComponent(source.id)}/supplements`:"/v1/deliveries",body));
  }catch(e){setError(errorText(e));}finally{setBusy(false);}
 };
 const edit=()=>{request.current={id:uid()};};
 return <Modal title={source?"补充需求":`新建 · ${profile.name}`} busy={busy} onClose={onClose}><form className="delivery-form" onSubmit={e=>{e.preventDefault();void submit();}}>
  {error&&<Notice>{error}</Notice>}
  <label>批次名称<input value={name} maxLength={120} required disabled={busy} placeholder="例如：示例批次 · 本次交付" onChange={e=>{edit();setName(e.target.value);}}/></label>
  {source&&<div className="delivery-supplement-source"><strong>{source.name}</strong><span>沿用原材料与选定交付，独立生成新版本。</span><label>原材料案件<select aria-label="原材料案件" disabled={busy} value={sourceJob?.itemIndex??""} onChange={e=>{edit();setSourceItemIndex(Number(e.target.value));setSourceTaskId(versions.find(j=>j.itemIndex===Number(e.target.value))?.taskId||"");}}>{[...new Set(versions.map(j=>j.itemIndex))].map(i=><option key={i} value={i}>{source.inputs[i]?.name||`材料 ${i+1}`}</option>)}</select></label><label>源交付版本<select aria-label="源交付版本" disabled={busy} value={sourceTaskId} onChange={e=>{edit();setSourceTaskId(e.target.value);}}>{versions.filter(j=>j.itemIndex===sourceJob?.itemIndex).map(j=><option key={j.taskId} value={j.taskId}>{j.attempt?`第 ${j.attempt} 次返修交付`:"首次交付"} · {j.taskId.slice(-12)}</option>)}</select></label></div>}
  {!source&&<><label className="delivery-upload"><FileUp size={26}/><strong>{files.length?`已选择 ${files.length} 件材料`:"选择材料文件"}</strong><span>按设备交给原技能总控安排；同一案件的资料请打包 ZIP · 单文件 ≤512 MB</span><input aria-label="上传材料" type="file" multiple disabled={busy} onChange={e=>{edit();setFiles(Array.from(e.target.files||[]).slice(0,24));if(!name&&e.target.files?.[0])setName(e.target.files[0].name.replace(/\.[^.]+$/,""));}}/></label>
  {files.map((f,i)=><div className="delivery-input-row" key={f.name+i}><span>{f.name}</span><small>{bytes(f.size)}</small><button type="button" disabled={busy} aria-label={`移除${f.name}`} className="icon-button" onClick={()=>{edit();setFiles(files.filter((_,j)=>i!==j));}}><X size={14}/></button></div>)}
  </>}
  {user.access?.mode==="groups"&&user.access.groupIds.length>1&&<label>文件所属分组<select value={groupId} disabled={busy} onChange={e=>{edit();setGroupId(e.target.value);}}>{user.access.groupIds.map(id=><option key={id} value={id}>{nodes.find(n=>n.groupId===id)?.groupName||id}</option>)}</select></label>}
  <label>{source?"补充要求":"交付要求"}<textarea required={!!source} minLength={source?10:undefined} rows={4} maxLength={6000} value={notes} disabled={busy} onChange={e=>{edit();setNotes(e.target.value);}} placeholder="说明用途、需要呈现的结果、参考样式和交付格式；也可附在材料中"/>{profile.id==="software"&&<span className="field-hint">按材料与需求确定交付内容；需要出图时，按专业设备报告或科研文献规范制作。</span>}</label>
  {source?<FeedbackFiles files={attachments} busy={busy} onChange={next=>{edit();setAttachments(next);}}/>:<details className="delivery-supplement-editor"><summary>补充需求与反馈附件（可选）{attachments.length>0?` · ${attachments.length} 个附件`:""}</summary><p className="field-hint">适用于本批所有案件；单案不同要求请分别提交。</p><label>随本次交付一并制作<textarea required={attachments.length>0} rows={3} maxLength={6000} value={supplementalText} disabled={busy} onChange={e=>{edit();setSupplementalText(e.target.value);}} placeholder="例如：按预审意见补充图示，结合成品编写视频讲解词或代码说明"/></label><FeedbackFiles files={attachments} busy={busy} onChange={next=>{edit();setAttachments(next);}}/></details>}
  <fieldset><legend>执行设备</legend><div className="delivery-choices"><label><input type="radio" checked={automatic} disabled={busy} onChange={()=>{edit();setAutomatic(true);}}/>自动分配</label><label><input type="radio" checked={!automatic} disabled={busy} onChange={()=>{edit();setAutomatic(false);}}/>指定设备</label></div><div className="delivery-worker-list">{workers.map(n=>{const issue=workerIssue(n);return <label key={n.id} className={issue?"unavailable":""}><input type="checkbox" disabled={busy||automatic||!!issue} checked={targets.includes(n.id)} onChange={e=>{edit();setSelection(e.target.checked?[...selection,n.id]:selection.filter(id=>id!==n.id));}}/><Monitor size={16}/><span>{n.displayName||n.name}<small>{issue||(settings.dispatchMode==="local-controller"?`交给 ${binding(n.id)?.title||"本机总控"}`:"可以接收任务")}</small></span></label>;})}</div>{!targets.length&&<p className="delivery-warning">暂无可执行设备。恢复桌面联动后可提交。</p>}</fieldset>
  {progress&&<p role="status">{progress}</p>}
  <footer className="delivery-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy||!valid}><Plus size={16}/>{busy?"正在提交":source?"提交补充需求":"开始交付"}</button></footer>
 </form></Modal>;
}
function FeedbackFiles({files,busy,onChange}:{files:File[];busy:boolean;onChange:(files:File[])=>void}){
 const [error,setError]=useState("");
 return <div className="delivery-feedback-files"><label className="delivery-feedback-upload"><FileUp size={17}/><span>添加反馈附件</span><input aria-label="上传反馈附件" type="file" multiple disabled={busy} onChange={e=>{const next=[...files,...Array.from(e.target.files||[])];e.target.value="";if(next.length>12){setError("最多添加 12 个反馈附件，请分批整理后再上传。");return;}if(next.some(f=>f.size===0||f.size>512*1024*1024)){setError("反馈附件须非空且单文件不超过 512 MB。");return;}if(new Set(next.map(f=>f.name.toLocaleLowerCase())).size!==next.length){setError("反馈附件文件名重复，请移除同名附件或重命名后添加。");return;}setError("");onChange(next);}}/></label>{error&&<Notice>{error}</Notice>}<small className="field-hint">通知书、参考图或修改意见，仅作参考，不会拆成新案件。单文件 ≤512 MB，最多 12 个。</small>{files.map((f,i)=><div className="delivery-input-row" key={f.name+i}><span>{f.name}</span><small>{bytes(f.size)}</small><button type="button" className="icon-button" disabled={busy} aria-label={`移除反馈附件${f.name}`} onClick={()=>onChange(files.filter((_,j)=>j!==i))}><X size={14}/></button></div>)}</div>;
}

type ControllerWorkspace={id:string;nodeId:string;name:string;status:string;root:string};
function ControllerSettings({nodes,profiles,value,onClose,onSave}:{nodes:FleetNode[];profiles:Profile[];value:Settings|null;onClose:()=>void;onSave:(v:Settings)=>Promise<void>}){
 const [controller,setController]=useState(value?.controller||nodes[0]?.id||""),[excluded,setExcluded]=useState(value?.excludedNodes||[]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [local,setLocal]=useState(true),[allowLocal,setAllowLocal]=useState(!!value?.allowControllerWork),[autoDiscover,setAutoDiscover]=useState(!!value?.autoDiscover),[bindings,setBindings]=useState<LocalController[]>(value?.localControllers||[]),[workspaces,setWorkspaces]=useState<ControllerWorkspace[]>([]);
 const [regions,setRegions]=useState<Region[]>(value?.regionalControllers||[]),[groups,setGroups]=useState<{id:string;name:string}[]>([]);
 useEffect(()=>{let live=true;api<{groups:{id:string;name:string}[]}>("/v1/device-groups").then(r=>{if(live)setGroups(r.groups);}).catch(e=>{if(live)setError(errorText(e));});return()=>{live=false;};},[]);
 useEffect(()=>{let live=true;api<{workspaces:ControllerWorkspace[]}>("/v1/workspaces").then(r=>{if(live)setWorkspaces(r.workspaces.filter(w=>w.status==="ready"));}).catch(e=>{if(live)setError(errorText(e));});return()=>{live=false;};},[]);
 return <Modal title="总控与本机分工" wide busy={busy} onClose={onClose}><div className="delivery-form">
  {error&&<Notice>{error}</Notice>}
  <label>派发与汇总电脑<select value={controller} disabled={busy||!!value?.controller} onChange={e=>{setController(e.target.value);setExcluded(excluded.filter(id=>id!==e.target.value));}}>{nodes.map(n=><option key={n.id} value={n.id}>{n.displayName||n.name}</option>)}</select></label>
  <div className="delivery-choices"><label><input type="checkbox" checked={local} disabled={true} onChange={e=>setLocal(e.target.checked)}/>交给各电脑已有总控分发</label><label><input type="checkbox" checked={allowLocal} disabled={busy} onChange={e=>setAllowLocal(e.target.checked)}/>主控电脑也可参与制作</label></div>
  <fieldset><legend>暂不参与制作</legend><div className="delivery-choices">{nodes.filter(n=>n.id!==controller).map(n=><label key={n.id}><input type="checkbox" disabled={busy} checked={excluded.includes(n.id)} onChange={e=>setExcluded(e.target.checked?[...excluded,n.id]:excluded.filter(id=>id!==n.id))}/>{n.displayName||n.name}</label>)}</div></fieldset>
  <section className="delivery-controller-settings"><h3>区域协调</h3><p className="muted">按分组接单，全局主控统一核验与汇总。未完成桌面和原总控接入的设备保持待准备。</p>{regions.map((r,i)=><fieldset key={i}><legend>区域 {i+1}</legend><label>协调电脑<select aria-label={`区域 ${i+1} 协调电脑`} value={r.nodeId} disabled={busy} onChange={e=>setRegions(old=>old.map((v,j)=>j===i?{...v,nodeId:e.target.value}:v))}><option value="">选择电脑</option>{nodes.filter(n=>n.id!==controller).map(n=><option key={n.id} value={n.id}>{n.code||n.name} · {n.displayName||n.name}</option>)}</select></label><p className="muted">管理分组</p><div className="delivery-choices">{groups.map(g=><label key={g.id}><input type="checkbox" disabled={busy} checked={r.groupIds.includes(g.id)} onChange={e=>setRegions(old=>old.map((v,j)=>j===i?{...v,groupIds:e.target.checked?[...v.groupIds,g.id]:v.groupIds.filter(x=>x!==g.id)}:v))}/>{g.name}</label>)}</div><p className="muted">负责流程</p><div className="delivery-choices">{profiles.map(p=><label key={p.id}><input type="checkbox" disabled={busy} checked={r.profiles.includes(p.id)} onChange={e=>setRegions(old=>old.map((v,j)=>j===i?{...v,profiles:e.target.checked?[...v.profiles,p.id]:v.profiles.filter(x=>x!==p.id)}:v))}/>{p.name}</label>)}</div><button className="button secondary" disabled={busy} onClick={()=>setRegions(old=>old.filter((_,j)=>i!==j))}>移除区域协调</button></fieldset>)}<button className="button secondary" disabled={busy} onClick={()=>setRegions(old=>[...old,{nodeId:"",groupIds:[],profiles:profiles.map(p=>p.id)}])}><Plus size={14}/>添加区域协调</button></section>
  {local&&<section className="delivery-controller-settings"><h3>绑定原对话</h3><p className="muted">后续批次直接发到这里，沿用此电脑的项目与环境。技能负责人在“技能改进”中单独设置。</p>{nodes.filter(n=>!excluded.includes(n.id)).map(n=><details key={n.id} open={nodes.length<=3}><summary>{n.code||n.name} · {n.displayName||n.name}</summary>{profiles.map(p=><ControllerBinding key={p.id} label={p.name} busy={busy} workspaces={workspaces.filter(w=>w.nodeId===n.id)} value={bindings.find(b=>b.nodeId===n.id&&b.profile===p.id)} onChange={b=>setBindings(old=>[...old.filter(x=>x.nodeId!==n.id||x.profile!==p.id),...(b?[{...b,nodeId:n.id,profile:p.id}]:[])])}/>)}</details>)}</section>}
  <button disabled={busy||!controller} className="button primary" onClick={async()=>{setBusy(true);try{await onSave({controller,excludedNodes:excluded,dispatchMode:local?"local-controller":"direct",allowControllerWork:allowLocal,autoDiscover,localControllers:bindings,regionalControllers:regions});}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>保存设置</button>
 </div></Modal>;
}
function ControllerBinding({label,value,workspaces,busy,onChange}:{label:string;value?:LocalController;workspaces:ControllerWorkspace[];busy:boolean;onChange:(v:{workspaceId:string;threadId:string}|null)=>void}){
 const [workspace,setWorkspace]=useState(value?.workspaceId||""),[threads,setThreads]=useState<{threadId:string;title:string;archived:boolean}[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
 useEffect(()=>{let live=true;setThreads([]);setError("");if(!workspace)return;setLoading(true);api<{threads:{threadId:string;title:string;archived:boolean}[]}>(`/v1/workspaces/${workspace}/threads`).then(r=>{if(live)setThreads(r.threads.filter(t=>!t.archived));}).catch(e=>{if(live)setError(errorText(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[workspace]);
 return <div className="delivery-binding"><strong>{label}</strong><label>已有项目<select disabled={busy} value={workspace} onChange={e=>{setWorkspace(e.target.value);onChange(null);}}><option value="">选择项目</option>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>本机总控对话<select disabled={busy||!workspace||loading} value={value?.workspaceId===workspace?value.threadId:""} onChange={e=>onChange(e.target.value?{workspaceId:workspace,threadId:e.target.value}:null)}><option value="">{loading?"正在读取…":"选择原对话"}</option>{threads.map(t=><option key={t.threadId} value={t.threadId}>{t.title||"未命名对话"}</option>)}</select></label>{error&&<small className="delivery-warning">{error}</small>}</div>;
}
