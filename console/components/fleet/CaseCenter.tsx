"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import {ArrowRight, Check, Download, FileText, FileUp, FolderOpen, History, Play, Plus, RefreshCw, X} from "lucide-react";
import {api, bytes, errorText, mutation, time, uid, uploadFile} from "./api";
import {Empty, Modal, Notice} from "./ui";
import DetailTabs from "./DetailTabs";
import type {FleetNode, InputFile, User} from "./types";
import "./case-center.css";

export type CaseFlow = {
 id:string; name:string; description?:string; adapter:string; version:number; deliveryProfile?:string;
 fields?:{id?:string;key?:string;name?:string;label?:string;type?:string;required?:boolean;placeholder?:string;options?:{value:string;label:string}[]}[];
 capabilities:{create:boolean;link:boolean;import:boolean;resume:boolean;requirements:boolean};
};
type CaseFile = InputFile & {taskId?:string;batchId?:string;versionId?:string;verification?:string};
type CaseRevision = {id:string;number:number;text:string;status:string;requestHash?:string;acceptedAt?:string;batchId?:string;attachments?:CaseFile[];acknowledgement?:{acceptedAt:string;actor?:string;message:string}};
type CaseVersion = {id:string;number:number;status:string;batchId?:string|null;createdAt?:string;files?:CaseFile[];requestHash?:string;verification?:string;error?:string|null;sourceSnapshot?:{inputs?:CaseFile[]};jobs?:{phase:string;taskId:string;node:string;status:string}[]};
type CaseBatch = {id:string;name:string;status:string;createdAt?:string;updatedAt?:string;inputs?:InputFile[]};
export type CaseDossier = {
 id:string;name:string;project:string;flowId:string;flow:CaseFlow;status:string;currentRevision:number;requestHash?:string;nodeIds:string[];canManage?:boolean;
 source?:{kind?:string;batchId?:string;description?:string;sourceLocation?:string;verification?:string};
 versions:CaseVersion[];revisions:CaseRevision[];files:CaseFile[];batches:CaseBatch[];
 latestProgress?:{message:string;at?:string}|null;resume:{allowed:boolean;requiresNote?:boolean;reason?:string};createdAt:string;updatedAt:string;error?:string|null;
};
export type CaseLinkedBatch = {id:string;name:string;profile:string;project?:string;status:string;inputs:InputFile[]};
type Props<T extends CaseLinkedBatch> = {nodes:FleetNode[];user:User;batches:T[];onBatch:(id:string)=>void;onTask:(id:string)=>void;onChanged:()=>Promise<void>};
const states:Record<string,string> = {rejected:"审核未通过",draft:"待开始",registered:"已建档",ready:"待开始",imported:"历史归档",historical:"历史归档",unverified:"待核验",running:"制作中",producing:"制作中",reviewing:"审核中",preflight:"准备设备",baseline:"核对版本",collecting:"归集文件",completed:"已交付",delivered:"已交付",paused:"已暂停",cancelled:"已停止",superseded:"已接续",needs_attention:"需要处理",pending_requirements:"待接续新需求",pending_boundary:"等待接续",pending:"待处理",planned:"待派发",applied:"已接续",accepted:"已受理",fulfilled:"已完成",verified:"核验通过",queued:"待发送",claimed:"已接收",submitted:"待核验",failed:"执行失败",blocked:"需要处理",uncertain:"待核实",cancelling:"正在停止",cancel_requested:"正在停止",linked:"已关联"};
const stateLabel=(value:string)=>states[value]||"状态待核实";
const taskStateLabel=(value:string)=>({running:"正在执行",accepted:"核验通过"} as Record<string,string>)[value]||stateLabel(value);
const finished=new Set(["completed","delivered","imported","historical","cancelled","superseded"]);

export default function CaseCenter<T extends CaseLinkedBatch>({nodes,user,batches,onBatch,onTask,onChanged}:Props<T>){
 const [cases,setCases]=useState<CaseDossier[]>([]),[flows,setFlows]=useState<CaseFlow[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const [selected,setSelected]=useState<CaseDossier|null>(null),[composer,setComposer]=useState<"new"|"import"|"link"|null>(null);
 const [query,setQuery]=useState(""),[filter,setFilter]=useState("unfinished"),[flowFilter,setFlowFilter]=useState("all"),[pages,setPages]=useState<(number|string)[]>([0]),[next,setNext]=useState<number|string|null>(null);
 const pageCursor=pages[pages.length-1];
 const selectedId=useRef<string|null>(null),inflight=useRef(false);selectedId.current=selected?.id||null;
 const refresh=useCallback(async()=>{
  if(inflight.current)return;inflight.current=true;
  try{
   const results=await Promise.allSettled([api<{cases:CaseDossier[];nextCursor:number|string|null}>(`/v1/cases?limit=30&cursor=${encodeURIComponent(pageCursor)}`),api<{flows:CaseFlow[]}>("/v1/case-flows"),selectedId.current?api<CaseDossier>(`/v1/cases/${encodeURIComponent(selectedId.current)}`):Promise.resolve(null)]);
   const [list,registry,detail]=results;
   if(list.status==="fulfilled"){setCases(list.value.cases);setNext(list.value.nextCursor??null);}
   if(registry.status==="fulfilled")setFlows(registry.value.flows);
   if(detail.status==="fulfilled"&&detail.value)setSelected(old=>old?.id===detail.value!.id?detail.value:old);
   setError(results.flatMap((r,i)=>r.status==="rejected"?[`${["案件档案","自动化流程","案件详情"][i]}读取失败：${errorText(r.reason)}`]:[]).join("；"));
  }finally{inflight.current=false;setLoading(false);}
 },[pageCursor]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},10000);return()=>clearInterval(timer);},[refresh]);
 const open=async(dossier:CaseDossier)=>{setSelected(dossier);try{const detail=await api<CaseDossier>(`/v1/cases/${encodeURIComponent(dossier.id)}`);setSelected(old=>old?.id===detail.id?detail:old);}catch(e){setError(errorText(e));}};
 const changed=async(dossier:CaseDossier)=>{setSelected(dossier);setCases(old=>[dossier,...old.filter(c=>c.id!==dossier.id)]);await Promise.all([refresh(),onChanged()]);};
 const visible=cases.filter(c=>(filter==="all"||filter==="unfinished"&&!finished.has(c.status)||filter==="history"&&finished.has(c.status))&&(flowFilter==="all"||c.flowId===flowFilter)&&(!query.trim()||`${c.name} ${c.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
 const unfinished=cases.filter(c=>!finished.has(c.status)).length;
 const writable=user.role!=="viewer";
 return <section className="case-center" aria-label="案件档案">
  <div className="case-heading"><div><h2>案件档案 <span>本页 {unfinished} 件未完成</span></h2></div><div className="delivery-actions"><button className="button secondary" aria-label="刷新案件" onClick={()=>void refresh()}><RefreshCw size={15}/>刷新</button>{writable&&<><button className="button secondary" disabled={!flows.some(f=>f.capabilities.import)} onClick={()=>setComposer("import")}><History size={16}/>历史导入</button><button className="button primary" disabled={!flows.some(f=>f.capabilities.create||f.capabilities.link)} onClick={()=>setComposer("new")}><Plus size={16}/>新建案件</button></>}</div></div>
  {error&&<Notice>{error}</Notice>}
  <div className="case-filters"><input aria-label="搜索案件" type="search" placeholder="搜索本页案件名称或编号" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="案件状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="unfinished">未完成</option><option value="all">全部案件</option><option value="history">历史与已交付</option></select><select aria-label="案件自动化流程" value={flowFilter} onChange={e=>setFlowFilter(e.target.value)}><option value="all">全部流程</option>{flows.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
  <div className="case-result-count"><span>本页 {visible.length} / {cases.length} 件</span>{writable&&batches.length>0&&<button className="text-button" disabled={!flows.some(f=>f.capabilities.link)} onClick={()=>setComposer("link")}>关联已有批次<ArrowRight size={14}/></button>}</div>
  {!visible.length?<Empty icon={<FolderOpen/>} title={loading?"正在读取案件":cases.length?"没有匹配的案件":"暂无案件档案"} action={!loading&&cases.length>0?<button className="button secondary" onClick={()=>{setFilter("all");setQuery("");setFlowFilter("all");}}>显示全部案件</button>:undefined}/>:<div className="case-list">{visible.map(c=><button className="case-row" key={c.id} onClick={()=>void open(c)}><FileText size={20}/><span className="case-row-main"><strong>{c.name}</strong><small>{c.flow?.name||flows.find(f=>f.id===c.flowId)?.name||c.flowId} · 需求 {c.currentRevision} 版 · {c.versions?.length||0} 个版本</small>{c.latestProgress?.message&&<span className="case-row-progress">{c.latestProgress.message}</span>}</span><span className="case-row-status"><span className={`delivery-state state-${c.status}`}><i/>{stateLabel(c.status)}</span><small>{time(c.updatedAt)}</small></span><ArrowRight size={17}/></button>)}</div>}
  {(pages.length>1||next!==null)&&<div className="case-pagination"><span>第 {pages.length} 页</span><button className="button secondary" disabled={pages.length===1||loading} onClick={()=>{setLoading(true);setPages(old=>old.slice(0,-1));}}>上一页</button><button className="button secondary" disabled={next===null||loading} onClick={()=>{if(next!==null){setLoading(true);setPages(old=>[...old,next]);}}}>下一页</button></div>}
  {composer&&<CaseComposer mode={composer} flows={flows} batches={batches} nodes={nodes} user={user} onClose={()=>setComposer(null)} onCreated={async c=>{setComposer(null);setFilter("all");await changed(c);}}/>}
  {selected&&<CaseDetail dossier={selected} writable={writable&&selected.canManage!==false} user={user} nodes={nodes} onClose={()=>setSelected(null)} onChanged={changed} onTask={id=>{setSelected(null);onTask(id);}} onBatch={id=>{setSelected(null);onBatch(id);}}/>}
 </section>;
}

function CaseDetail({dossier:c,writable,nodes,user,onClose,onChanged,onBatch,onTask}:{dossier:CaseDossier;writable:boolean;nodes:FleetNode[];user:User;onClose:()=>void;onChanged:(c:CaseDossier)=>Promise<void>;onBatch:(id:string)=>void;onTask:(id:string)=>void}){
 const [tab,setTab]=useState("progress"),[busy,setBusy]=useState(false),[requirementBusy,setRequirementBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[adding,setAdding]=useState(false),[nodeIds,setNodeIds]=useState<string[]>([]),[resumeNote,setResumeNote]=useState("");
 const request=useRef(uid());
 const requiresNote=!!c.resume?.requiresNote||c.status==="needs_attention";
 const action=async(kind:"resume"|"reconcile")=>{setBusy(true);setError("");setNotice("");try{const next=await mutation<CaseDossier>(`/v1/cases/${encodeURIComponent(c.id)}/${kind}`,kind==="resume"?{id:request.current,expectedRevision:c.currentRevision,...(nodeIds.length?{nodeIds}:{}),...(resumeNote.trim()?{note:resumeNote.trim()}:{})}:{});await onChanged(next);request.current=uid();setNotice(kind==="resume"?"已受理接续，请查看执行进度。":"已核对接续状态。");}catch(e){setError(errorText(e));}finally{setBusy(false);}};
 const pending=c.revisions?.filter(r=>r.status==="pending_boundary")||[];
 return <Modal title={c.name} wide busy={busy||requirementBusy} onClose={onClose}><div className="delivery-detail case-detail">
  <div className="case-detail-summary"><span className={`delivery-state state-${c.status}`}><i/>{stateLabel(c.status)}</span><span>{c.flow?.name||c.flowId} · 流程 {c.flow?.version??1} 版</span><span>需求 {c.currentRevision} 版</span></div>
  {(error||c.error)&&<Notice>{error||c.error}</Notice>}{notice&&<Notice tone="success">{notice}</Notice>}
  <div className="case-next"><div><strong>{c.latestProgress?.message||c.resume?.reason||"档案已保存"}</strong><small>更新于 {time(c.latestProgress?.at||c.updatedAt)}</small></div>{writable&&c.flow?.capabilities.requirements&&<button className="button secondary" disabled={busy} onClick={()=>{setAdding(true);setTab("requirements");}}><Plus size={15}/>追加需求</button>}{writable&&c.resume?.allowed&&<button className="button primary" disabled={busy||!c.nodeIds?.length&&!nodeIds.length||requiresNote&&resumeNote.trim().length<10} onClick={()=>void action("resume")}><Play size={15}/>{busy?"正在接续":c.status==="draft"?"开始制作":"继续未完成"}</button>}{writable&&c.resume?.allowed&&!c.nodeIds?.length&&<div className="case-resume-devices"><strong>执行设备</strong><div className="delivery-choices">{nodes.filter(n=>n.projects.includes(c.project)).map(n=><label key={n.id}><input type="checkbox" disabled={busy||!n.online} checked={nodeIds.includes(n.id)} onChange={e=>{request.current=uid();setNodeIds(old=>e.target.checked?[...old,n.id]:old.filter(id=>id!==n.id));}}/>{n.displayName||n.code||n.name}{!n.online?"（离线）":""}</label>)}</div></div>}{writable&&c.resume?.allowed&&requiresNote&&<label className="case-resume-note">已处理的问题<textarea aria-label="已处理的问题" value={resumeNote} rows={3} minLength={10} maxLength={6000} disabled={busy} onChange={e=>{request.current=uid();setResumeNote(e.target.value);}} placeholder="说明已经完成的修复或补充，接续任务会读取这段记录"/></label>}</div>
  {!!pending.length&&<Notice tone="info">{pending.length} 条需求已受理，等待当前任务结束后接续。<button className="inline-link" disabled={busy||!writable} onClick={()=>void action("reconcile")}>核对接续状态</button></Notice>}
  <DetailTabs label="案件详情分区" value={tab} onChange={setTab} items={[{id:"progress",label:"进度"},{id:"requirements",label:"需求",count:c.revisions?.length||0},{id:"files",label:"文件",count:c.files?.length||0},{id:"history",label:"历史",count:c.versions?.length||0}]}/>
  <div className="detail-tab-panel case-panel" hidden={tab!=="progress"}>
   {c.versions.at(-1)?.error&&c.versions.at(-1)?.error!==c.error&&<Notice>{c.versions.at(-1)!.error}</Notice>}
   {(c.batches?.length||0)>0?<div className="case-related-batches">{c.batches.map(b=><div className="case-batch" key={b.id}><div><strong>{b.name}</strong><small>{time(b.updatedAt||b.createdAt)}</small></div><span className={`delivery-state state-${b.status}`}><i/>{stateLabel(b.status)}</span><button className="text-button" onClick={()=>onBatch(b.id)}>查看批次<ArrowRight size={14}/></button></div>)}</div>:!c.versions.some(v=>v.jobs?.length)?<p className="muted">尚未开始制作。</p>:null}
   {!!c.versions.at(-1)?.jobs?.length&&<div className="case-execution-records"><h3>执行记录</h3>{c.versions.at(-1)!.jobs!.map(j=><button className="delivery-job" key={j.taskId} onClick={()=>onTask(j.taskId)}><span><strong>{({prepare:"准备",produce:"制作",review:"审核",collect:"归集",execute:"执行",verify:"核验",preflight:"环境核对"} as Record<string,string>)[j.phase]||"执行步骤"}</strong><small>{nodes.find(n=>n.id===j.node)?.displayName||nodes.find(n=>n.id===j.node)?.name||j.node}</small></span><span>{taskStateLabel(j.status)}<ArrowRight size={14}/></span></button>)}</div>}
   {c.resume?.reason&&<p className="case-note">{c.resume.reason}</p>}
   <dl className="case-metadata"><div><dt>案件编号</dt><dd>{c.id}</dd></div><div><dt>建立时间</dt><dd>{time(c.createdAt)}</dd></div></dl>
  </div>
  <div className="detail-tab-panel case-panel" hidden={tab!=="requirements"}>
   {adding&&<CaseRequirement dossier={c} nodes={nodes} user={user} onBusy={setRequirementBusy} onCancel={()=>setAdding(false)} onSaved={async next=>{await onChanged(next);setAdding(false);setNotice("需求已受理，原版本已保留。");}}/>}
   {!c.revisions?.length?<p className="muted">暂无需求记录。</p>:<div className="case-revisions">{c.revisions.slice().reverse().map(r=><article key={r.id} className="case-revision"><header><strong>需求 {r.number} 版</strong><span className={`delivery-state state-${r.status}`}>{stateLabel(r.status)}</span><time>{time(r.acceptedAt||r.acknowledgement?.acceptedAt)}</time></header><p>{r.text||"按原材料与交付要求制作。"}</p>{!!r.attachments?.length&&<CaseFiles files={r.attachments}/>} {r.acknowledgement&&<small className="case-ack"><Check size={14}/>{r.acknowledgement.message} · {time(r.acknowledgement.acceptedAt)}</small>}</article>)}</div>}
  </div>
  <div className="detail-tab-panel case-panel" hidden={tab!=="files"}>{c.versions[0]?.sourceSnapshot?.inputs?.length?<section className="case-file-group"><h3>原始材料</h3><CaseFiles files={c.versions[0].sourceSnapshot.inputs.map(f=>({...f,project:f.project||c.project}))}/></section>:null}{c.files?.length?c.versions.filter(v=>v.files?.length).map(v=><section className="case-file-group" key={v.id}><h3>版本 {v.number}</h3><CaseFiles files={v.files!}/></section>):!c.versions[0]?.sourceSnapshot?.inputs?.length?<Empty icon={<FolderOpen/>} title="暂无档案文件"/>:null}</div>
  <div className="detail-tab-panel case-panel" hidden={tab!=="history"}>
   {c.source?.kind==="import"&&<div className="case-import-source"><span className="delivery-state state-unverified">历史材料 · 未核验</span>{c.source.description&&<p>{c.source.description}</p>}{c.source.sourceLocation&&<small>{c.source.sourceLocation}</small>}</div>}
   {!c.versions?.length?<p className="muted">暂无交付版本。</p>:<div className="case-version-list">{c.versions.slice().reverse().map(v=><article key={v.id} className="case-version"><header><strong>版本 {v.number}</strong><span className={`delivery-state state-${v.status}`}>{stateLabel(v.status)}</span><time>{time(v.createdAt)}</time></header>{v.verification&&<small>{stateLabel(v.verification)}</small>}{v.files?.length?<CaseFiles files={v.files}/>:null}{v.batchId&&<button className="text-button" onClick={()=>onBatch(v.batchId!)}>查看执行批次<ArrowRight size={14}/></button>}</article>)}</div>}
  </div>
 </div></Modal>;
}

function CaseFiles({files}:{files:CaseFile[]}){
 return <div className="case-files">{files.map((f,i)=>{const href=f.taskId?`/v1/artifacts/${encodeURIComponent(f.sha)}?task=${encodeURIComponent(f.taskId)}`:f.project?`/v1/files/${encodeURIComponent(f.sha)}?project=${encodeURIComponent(f.project)}`:undefined;return <div className="case-file" key={`${f.sha}-${f.taskId||i}`}><FileText size={17}/><span><strong>{f.name}</strong><small>{bytes(f.size)}{f.verification?` · ${stateLabel(f.verification)}`:""}</small></span>{href?<a className="icon-button" aria-label={`下载 ${f.name}`} href={href} download><Download size={17}/></a>:<small className="muted">暂无下载</small>}</div>;})}</div>;
}

function CaseRequirement({dossier:c,nodes,user,onSaved,onCancel,onBusy}:{dossier:CaseDossier;nodes:FleetNode[];user:User;onSaved:(c:CaseDossier)=>Promise<void>;onCancel:()=>void;onBusy:(busy:boolean)=>void}){
 const [text,setText]=useState(""),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState("");
 const [itemIndex,setItemIndex]=useState(0),[nodeIds,setNodeIds]=useState<string[]>([]),[groupId,setGroupId]=useState(user.access?.mode==="groups"?user.access.groupIds[0]||"":""),sourceInputs=c.batches.at(-1)?.inputs||[],needsDevices=!c.nodeIds?.length;
 const request=useRef<{id:string;body?:unknown}>({id:uid()}),edited=()=>{request.current={id:uid()};};
 const submit=async()=>{if(text.trim().length<10||needsDevices&&!nodeIds.length)return;setBusy(true);onBusy(true);setError("");try{if(!request.current.body){const attachments=[];for(const file of files)attachments.push(await uploadFile(file,c.project,p=>setProgress(`${file.name} · ${p.text} ${p.percent}%`),groupId||undefined));request.current.body={id:request.current.id,expectedRevision:c.currentRevision,text:text.trim(),attachments,...(needsDevices?{nodeIds}:{}),...(sourceInputs.length>1?{itemIndex}:{})};}setProgress("正在提交需求");await onSaved(await mutation<CaseDossier>(`/v1/cases/${encodeURIComponent(c.id)}/requirements`,request.current.body));}catch(e){setError(errorText(e));}finally{setBusy(false);onBusy(false);setProgress("");}};
 return <form className="case-requirement-form delivery-form" onSubmit={e=>{e.preventDefault();void submit();}}>{error&&<Notice>{error}</Notice>}{sourceInputs.length>1&&<label>本次针对材料<select aria-label="本次针对材料" value={itemIndex} disabled={busy} onChange={e=>{edited();setItemIndex(Number(e.target.value));}}>{sourceInputs.map((f,i)=><option key={f.sha+i} value={i}>{f.name}</option>)}</select></label>}<label>追加要求<textarea aria-label="追加要求" required minLength={10} maxLength={6000} rows={4} value={text} disabled={busy} onChange={e=>{edited();setText(e.target.value);}} placeholder="说明需要增加或修改的内容、预期结果"/></label><CaseUploads files={files} busy={busy} label="需求附件" onChange={next=>{edited();setFiles(next);}}/><UploadGroup user={user} nodes={nodes} busy={busy} value={groupId} onChange={id=>{edited();setGroupId(id);}}/>{needsDevices&&<fieldset><legend>执行设备</legend><div className="delivery-choices">{nodes.filter(n=>n.projects.includes(c.project)).map(n=><label key={n.id}><input type="checkbox" disabled={busy||!n.online} checked={nodeIds.includes(n.id)} onChange={e=>{edited();setNodeIds(old=>e.target.checked?[...old,n.id]:old.filter(id=>id!==n.id));}}/>{n.displayName||n.code||n.name}{!n.online?"（离线）":""}</label>)}</div></fieldset>}<small className="field-hint">提交后留存受理记录，制作中的任务结束后接续。</small>{progress&&<p role="status">{progress}</p>}<div className="delivery-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" disabled={busy||text.trim().length<10||needsDevices&&!nodeIds.length}>{busy?"正在提交":"提交需求"}</button></div></form>;
}

function CaseUploads({files,busy,label,onChange}:{files:File[];busy:boolean;label:string;onChange:(files:File[])=>void}){
 const [error,setError]=useState("");
 return <div className="case-upload"><label className="delivery-feedback-upload"><FileUp size={16}/><span>{label}</span><input aria-label={label} type="file" multiple disabled={busy} onChange={e=>{const next=[...files,...Array.from(e.target.files||[])];e.target.value="";if(next.length>24){setError("最多上传 24 个文件。");return;}if(next.some(f=>f.size===0||f.size>512*1024*1024)){setError("文件须非空，单文件不超过 512 MB。");return;}if(new Set(next.map(f=>f.name.toLocaleLowerCase())).size!==next.length){setError("文件名重复，请先重命名。");return;}setError("");onChange(next);}}/></label>{error&&<Notice>{error}</Notice>}{files.map((f,i)=><div className="delivery-input-row" key={f.name+i}><span>{f.name}</span><small>{bytes(f.size)}</small><button className="icon-button" type="button" aria-label={`移除 ${f.name}`} disabled={busy} onClick={()=>onChange(files.filter((_,j)=>j!==i))}><X size={14}/></button></div>)}</div>;
}

function UploadGroup({user,nodes,value,busy,onChange}:{user:User;nodes:FleetNode[];value:string;busy:boolean;onChange:(id:string)=>void}){
 if(user.access?.mode!=="groups"||user.access.groupIds.length<2)return null;
 return <label>文件所属分组<select aria-label="文件所属分组" value={value} disabled={busy} onChange={e=>onChange(e.target.value)}>{user.access.groupIds.map(id=><option key={id} value={id}>{nodes.find(n=>n.groupId===id)?.groupName||id}</option>)}</select></label>;
}

function CaseComposer<T extends CaseLinkedBatch>({mode:initialMode,flows,batches,nodes,user,onClose,onCreated}:{mode:"new"|"import"|"link";flows:CaseFlow[];batches:T[];nodes:FleetNode[];user:User;onClose:()=>void;onCreated:(c:CaseDossier)=>Promise<void>}){
 const [mode,setMode]=useState(initialMode),[flowId,setFlowId]=useState(flows.find(f=>f.capabilities[initialMode==="new"?"create":initialMode])?.id||"");
 const [name,setName]=useState(""),[notes,setNotes]=useState(""),[files,setFiles]=useState<File[]>([]),[batchId,setBatchId]=useState(""),[historyDescription,setHistoryDescription]=useState(""),[sourceLocation,setSourceLocation]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState(""),[selectedNodes,setSelectedNodes]=useState<string[]>([]),[fields,setFields]=useState<Record<string,string>>({});
 const request=useRef<{id:string;body?:unknown}>({id:uid()}),edit=()=>{request.current={id:uid()};};
 const flow=flows.find(f=>f.id===flowId),availableFlows=flows.filter(f=>f.capabilities[mode==="new"?"create":mode]&&(mode!=="link"||f.adapter==="delivery-v1"));
 const sourceBatch=batches.find(b=>b.id===batchId),project=sourceBatch?.project||"workspace";
 const availableBatches=batches.filter(b=>!flow?.deliveryProfile||b.profile===flow.deliveryProfile);
 const [groupId,setGroupId]=useState(user.access?.mode==="groups"?user.access.groupIds[0]||"":"");
 const invalidFields=(flow?.fields||[]).some(f=>f.required&&!fields[f.key||f.id||"limit" ]?.trim());
 const valid=!!name.trim()&&!!flow&&availableFlows.some(f=>f.id===flow.id)&&!invalidFields&&(mode==="link"?!!sourceBatch:mode==="import"?!!historyDescription.trim():files.length>0);
 const switchMode=(next:typeof mode)=>{edit();setMode(next);const available=flows.filter(f=>f.capabilities[next==="new"?"create":next]);if(!available.some(f=>f.id===flowId))setFlowId(available[0]?.id||"");setBatchId("");};
 const submit=async()=>{if(!valid)return;setBusy(true);setError("");try{if(!request.current.body){const inputs:InputFile[]=[];if(mode!=="link")for(const file of files)inputs.push(await uploadFile(file,project,p=>setProgress(`${file.name} · ${p.text} ${p.percent}%`),groupId||undefined));request.current.body={id:request.current.id,name:name.trim(),project,flowId,flowVersion:flow!.version,mode,...(mode==="link"?{batchId}:{}),inputs:mode==="import"?[]:inputs,notes:mode==="new"?notes.trim():"",nodeIds:selectedNodes,...(Object.keys(fields).length?{fields}:{}),...(mode==="import"?{history:{description:historyDescription.trim(),sourceLocation:sourceLocation.trim(),files:inputs}}:{})};}setProgress(mode==="import"?"正在保存档案":"正在建立案件");await onCreated(await mutation<CaseDossier>("/v1/cases",request.current.body));}catch(e){setError(errorText(e));}finally{setBusy(false);setProgress("");}};
 return <Modal title={mode==="import"?"导入历史案件":mode==="link"?"关联已有批次":"新建案件"} busy={busy} onClose={onClose}><form className="delivery-form case-compose" onSubmit={e=>{e.preventDefault();void submit();}}>
  {error&&<Notice>{error}</Notice>}
  <div className="case-mode" role="group" aria-label="建档方式">{([['new','新建案件'],['link','关联批次'],['import','历史导入']] as const).map(([id,label])=><button type="button" key={id} disabled={busy||!flows.some(f=>f.capabilities[id==="new"?"create":id])} aria-pressed={mode===id} className={mode===id?"active":""} onClick={()=>switchMode(id)}>{label}</button>)}</div>
  <label>自动化流程<select aria-label="自动化流程" value={flowId} disabled={busy} required onChange={e=>{edit();setFlowId(e.target.value);setBatchId("");setFields({});}}>{availableFlows.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
  <label>案件名称<input aria-label="案件名称" value={name} maxLength={120} required disabled={busy} onChange={e=>{edit();setName(e.target.value);}} placeholder="输入便于查找的案件名称"/></label>
  {mode==="link"?<label>已有批次<select aria-label="已有批次" value={batchId} required disabled={busy} onChange={e=>{edit();setBatchId(e.target.value);const batch=batches.find(b=>b.id===e.target.value);if(!name&&batch)setName(batch.name);}}><option value="">选择批次</option>{availableBatches.map(b=><option key={b.id} value={b.id}>{b.name} · {stateLabel(b.status)}</option>)}</select></label>:<CaseUploads files={files} label={mode==="import"?"上传历史文件":"上传案件材料"} busy={busy} onChange={next=>{edit();setFiles(next);}}/>}
  {mode!=="link"&&<UploadGroup user={user} nodes={nodes} busy={busy} value={groupId} onChange={id=>{edit();setGroupId(id);}}/>}
  {mode==="import"&&<><label>历史记录<textarea aria-label="历史记录" required rows={3} maxLength={6000} disabled={busy} value={historyDescription} onChange={e=>{edit();setHistoryDescription(e.target.value);}} placeholder="说明已完成内容、遗留事项和原版本"/></label><label>原存放位置<input aria-label="原存放位置" disabled={busy} value={sourceLocation} maxLength={1000} onChange={e=>{edit();setSourceLocation(e.target.value);}} placeholder="可选：原文件夹、项目或版本地址"/></label><small className="field-hint">历史文件保留原状，以未核验状态建档。</small></>}
  {mode==="new"&&<label>交付要求<textarea aria-label="交付要求" rows={3} maxLength={6000} value={notes} disabled={busy} onChange={e=>{edit();setNotes(e.target.value);}} placeholder="说明本次需要完成的内容与交付格式"/></label>}
  {mode==="new"&&(flow?.fields||[]).map(f=>{const key=f.key||f.id||"limit",label=f.label||f.name||key;return <label key={key}>{label}{f.options?.length?<select aria-label={label} required={f.required} value={fields[key]||""} disabled={busy} onChange={e=>{edit();setFields(old=>({...old,[key]:e.target.value}));}}><option value="">请选择</option>{f.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input aria-label={label} type={f.type==="number"?"number":"text"} required={f.required} maxLength={2000} value={fields[key]||""} placeholder={f.placeholder} disabled={busy} onChange={e=>{edit();setFields(old=>({...old,[key]:e.target.value}));}}/>}</label>;})}
  {mode==="new"&&<details className="case-device-picker"><summary>执行设备{selectedNodes.length?` · 已选 ${selectedNodes.length} 台`:" · 稍后选择"}</summary><div className="delivery-choices">{nodes.filter(n=>n.projects.includes(project)).map(n=><label key={n.id}><input type="checkbox" disabled={busy||!n.online} checked={selectedNodes.includes(n.id)} onChange={e=>{edit();setSelectedNodes(old=>e.target.checked?[...old,n.id]:old.filter(id=>id!==n.id));}}/>{n.displayName||n.code||n.name}{!n.online?"（离线）":""}</label>)}</div></details>}
  {progress&&<p role="status">{progress}</p>}
  <footer className="delivery-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy||!valid}>{busy?"正在保存":mode==="import"?"保存历史档案":mode==="link"?"关联并建档":selectedNodes.length?"建立并开始":"建立档案"}</button></footer>
 </form></Modal>;
}
