"use client";
import { deviceLabel } from "./device-utils";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowDown, ArrowRight, Check, ChevronRight, Download, Pause, Play, Plus, RefreshCw, Square, Trash2, Workflow } from "lucide-react";
import { ApiError, api, errorText, mutation, time, uid } from "./api";
import { runtimeIssue } from "../../lib/fleet/runtime-readiness.mjs";
import type { FleetNode } from "./types";
import ProjectPicker, { type Workspace } from "./ProjectPicker";
import { Busy, Empty, Modal, Notice, Section, Status } from "./ui";

type FlowFile = { sha: string; name: string; size: number; status?: string };
type FlowStep = { key: string; name: string; targetNode: string; workspaceId?: string; prompt?: string; mode?: "question" | "execute"; executionPolicy?: "local" | "project"; skills?: string[]; outputs?: string[]; outputText?: string; taskId?: string | null; status?: string; error?: string; summary?: string; updatedAt?: string; inputs?: FlowFile[]; artifacts?: FlowFile[] };
type Flow = { id: string; kind?: "parallel"; executionMode?: "parallel" | "sequential"; workflowId?: string; creator?: string; controllerNode?: string; name: string; project: string; status: string; currentStep: number; totalSteps: number; canManage?: boolean; createdAt?: string; updatedAt?: string; error?: string | null; steps: FlowStep[]; result?: { summary?: string; taskId?: string; artifacts?: { sha: string; name: string; size: number }[] } | null };
const FLOW_STATUS: Record<string, { label: string; tone: string }> = { collecting: { label: "等待汇总", tone: "blue" }, running: { label: "运行中", tone: "green" }, paused: { label: "已暂停", tone: "neutral" }, needs_attention: { label: "需要处理", tone: "amber" }, completed: { label: "流程完成", tone: "green" }, cancelling: { label: "正在取消", tone: "amber" }, cancelled: { label: "已取消", tone: "neutral" } };
const DONE_STEPS = new Set(["submitted", "accepted", "completed"]);
function StepStatus({ status }: { status?: string }) { return !status || ["waiting", "pending", "not_started", "planned"].includes(status) ? <span className="status status-neutral">等待前置步骤</span> : status === "prepared" ? <span className="status status-blue">准备交接</span> : ["completed", "submitted"].includes(status) ? <span className="status status-green">本项已提交</span> : <Status value={status} />; }

function FlowComposer({ nodes, onClose, onCreated }: { nodes: FleetNode[]; onClose: () => void; onCreated: (value: Flow) => void }) {
  const [executionMode,setExecutionMode]=useState<"sequential"|"parallel">("parallel");
  const [name, setName] = useState(""); const [steps, setSteps] = useState<FlowStep[]>(() => [0, 1].map(index => ({ key: uid(), name: "", targetNode: nodes[index]?.id || nodes[0]?.id || "", workspaceId: "", prompt: "", mode: "execute", skills: [], outputs: [] })));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [syncError, setSyncError] = useState(""); const [busy, setBusy] = useState(false); const [projectStep, setProjectStep] = useState("");
  const requestId = useRef(uid()); const sentSnapshot = useRef<string | null>(null);
  useEffect(() => { let alive = true; void api<{ workspaces: Workspace[] }>("/v1/workspaces").then(value => { if (alive) { setWorkspaces(value.workspaces); setSyncError(""); } }).catch(err => { if (alive) setSyncError(errorText(err)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, []);
  function update(key: string, value: Partial<FlowStep>) { setSteps(previous => previous.map(step => step.key === key ? { ...step, ...value } : step)); }
  function acceptWorkspace(key: string, value: Workspace | null) {
    if (!value || value.status !== "ready") return;
    setWorkspaces(previous => [...previous.filter(workspace => workspace.id !== value.id), value]); update(key, { workspaceId: value.id }); setProjectStep("");
  }
  const valid = name.trim() && steps.every(step => step.targetNode && step.prompt?.trim() && nodes.find(node => node.id === step.targetNode)?.capabilities?.workspaceExecution === true && (step.mode === "question" || step.executionPolicy === "project" || nodes.find(node => node.id === step.targetNode)?.capabilities?.localExecutionPolicy === true) && workspaces.some(workspace => workspace.id === step.workspaceId && workspace.nodeId === step.targetNode && workspace.status === "ready"));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!valid || busy) return;
    if(executionMode==="parallel"&&!sentSnapshot.current){
      const problem=steps.map(step=>{const node=nodes.find(n=>n.id===step.targetNode);const reason=runtimeIssue(node,{parallel:true});return reason?`${node?deviceLabel(node):"目标电脑"}：${reason}`:null;}).find(Boolean);
      if(problem){setError(problem);return;}
    }
    const projects = new Set(steps.map(step => workspaces.find(workspace => workspace.id === step.workspaceId)?.project));
    if (projects.size !== 1) { setError("流程内的项目需要使用同一协作权限范围。"); return; }
    if(executionMode==="parallel"&&(steps.at(-1)?.mode==="question"||!(steps.at(-1)?.outputText??steps.at(-1)?.outputs?.join("\n")??"").trim())){setError("请为最后的汇总步骤填写交回文件。");return;}
    const body = { id: requestId.current, name: name.trim(), project: [...projects][0],executionMode, steps: steps.map((step, index) => ({ key: step.key, name: step.name.trim() || `步骤 ${index + 1}`, targetNode: step.targetNode, workspaceId: step.workspaceId, prompt: step.prompt!.trim(), mode: step.mode || "execute",requireDesktop:true,...(executionMode==="parallel"?{dependsOn:index===steps.length-1?steps.slice(0,-1).map(s=>s.key):[]}:{}), ...(step.mode !== "question" ? { executionPolicy: step.executionPolicy || "local" } : {}), skills: step.skills || [], outputs: step.mode === "question" ? [] : (step.outputText ?? (step.outputs || []).join("\n")).split(/\r?\n/).map(path => path.trim()).filter(Boolean) })) };
    const snapshot = JSON.stringify(body);
    if (sentSnapshot.current && sentSnapshot.current !== snapshot) { setError("上次启动结果尚未确认。请保留原内容重试，或先回流程列表检查。"); return; }
    setBusy(true); setError(""); sentSnapshot.current = snapshot;
    try { onCreated(await mutation<Flow>("/v1/automations", body)); } catch (err) { if(err instanceof ApiError&&err.code==="AUTOMATION_TARGET_NOT_READY")sentSnapshot.current=null;setError(errorText(err)); } finally { setBusy(false); }
  }
  return <Modal title="创建协作流程" wide onClose={onClose} busy={busy}><form className="form-body" onSubmit={submit}>
    {error && <Notice>{error}</Notice>}{syncError && <Notice>{syncError}</Notice>}
    <label>流程名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={160} placeholder="例如：资料整理 → 检查 → 汇总" disabled={busy} /></label>
    <label>执行顺序<select value={executionMode} onChange={e=>setExecutionMode(e.target.value as "parallel"|"sequential")} disabled={busy}><option value="parallel">分头工作，最后统一汇总</option><option value="sequential">按步骤依次交接</option></select></label>
    <p className="flow-transfer-hint">{executionMode==="parallel"?"前面的步骤分别运行，最后一步收到全部交回文件后开始汇总。":"每步提交结果后，摘要与交回文件会自动交给下一台电脑。"}</p>
    <div className="flow-composer-steps">{steps.map((step, index) => {
      const node = nodes.find(item => item.id === step.targetNode);
      const choices = workspaces.filter(workspace => workspace.nodeId === step.targetNode && workspace.status === "ready");
      const skills = Array.from(new Set((node?.capabilities?.skills || []).flatMap(value => typeof value === "string" ? [value] : value.names || (value.name ? [value.name] : []))));
      return <div className="flow-step-editor" key={step.key}><header><span>{index + 1}</span><input aria-label={`步骤 ${index + 1} 名称`} value={step.name} placeholder={`步骤 ${index + 1} 名称（可选）`} maxLength={160} onChange={event => update(step.key, { name: event.target.value })} disabled={busy} /><button type="button" className="icon-button" aria-label={`删除步骤 ${index + 1}`} disabled={busy || steps.length <= 2} onClick={() => setSteps(previous => previous.filter(value => value.key !== step.key))}><Trash2 size={16} /></button></header>
        <div className="form-grid"><label>电脑<select aria-label={`步骤 ${index + 1} 电脑`} value={step.targetNode} onChange={event => { update(step.key, { targetNode: event.target.value, workspaceId: "", skills: [] }); setProjectStep(""); }} disabled={busy}>{nodes.map(item => <option key={item.id} value={item.id}>{deviceLabel(item)} · {item.online ? "在线" : "离线"}</option>)}</select></label><label>项目<select aria-label={`步骤 ${index + 1} 项目`} value={step.workspaceId || ""} onChange={event => update(step.key, { workspaceId: event.target.value })} disabled={busy || loading}><option value="">{loading ? "读取项目中…" : "选择已就绪项目"}</option>{choices.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name === "workspace" ? "默认工作目录" : workspace.name}</option>)}</select></label></div>
        {node?.capabilities?.workspaceExecution !== true && <p className="field-hint">等待这台电脑升级并启用项目任务执行。</p>}
        {executionMode==="parallel"&&runtimeIssue(node,{parallel:true})&&<p className="field-hint" role="status">{runtimeIssue(node,{parallel:true})}</p>}
        {step.mode !== "question" && step.executionPolicy !== "project" && node?.capabilities?.localExecutionPolicy !== true && <p className="field-hint">沿用本机权限需要新版节点，也可选择“仅项目目录”。</p>}
        <button type="button" className="text-button flow-connect-project" onClick={() => setProjectStep(value => value === step.key ? "" : step.key)} disabled={busy}>{projectStep === step.key ? "收起项目设置" : "接入或新建项目"}<ChevronRight size={13} /></button>
        {projectStep === step.key && <ProjectPicker key={`${step.key}:${step.targetNode}`} node={node} disabled={busy} onSelection={value => acceptWorkspace(step.key, value)} />}
        <label>这一步做什么？<textarea aria-label={`步骤 ${index + 1} 任务`} rows={3} value={step.prompt || ""} maxLength={40000} required placeholder={index === 0 ? "说明第一步的目标和需要交回的结果。" : "收到上一步的摘要与文件后，需要完成什么？"} onChange={event => update(step.key, { prompt: event.target.value })} disabled={busy} /></label>
        <details className="advanced-options"><summary>执行方式、交回文件与技能</summary><label>执行方式<select aria-label={`步骤 ${index + 1} 执行方式`} value={step.mode || "execute"} onChange={event => update(step.key, { mode: event.target.value as "question" | "execute" })} disabled={busy}><option value="execute">安排工作</option><option value="question">只读检查</option></select></label>{step.mode !== "question" && <><label>执行权限<select aria-label={`步骤 ${index + 1} 执行权限`} value={step.executionPolicy || "local"} onChange={event => update(step.key, { executionPolicy: event.target.value as "local" | "project" })} disabled={busy}><option value="local">沿用本机 Codex 权限</option><option value="project">仅项目目录</option></select></label><label>交给下一步的文件<textarea aria-label={`步骤 ${index + 1} 交回文件`} rows={2} value={step.outputText ?? (step.outputs || []).join("\n")} placeholder="每行一个相对路径，例如 output/report.docx" onChange={event => update(step.key, { outputText: event.target.value })} disabled={busy} /></label></>}{skills.length > 0 && <div className="skill-picker">{skills.map(skill => <label className="check-chip" key={skill}><input type="checkbox" disabled={busy} checked={step.skills?.includes(skill) || false} onChange={event => update(step.key, { skills: event.target.checked ? [...(step.skills || []), skill] : step.skills?.filter(value => value !== skill) })} />{skill}</label>)}</div>}</details>
      </div>;
    })}</div>
    <button type="button" className="button secondary" disabled={busy || steps.length >= 12} onClick={() => setSteps(previous => [...previous, { key: uid(), name: "", targetNode: nodes[previous.length % Math.max(nodes.length, 1)]?.id || "", workspaceId: "", prompt: "", mode: "execute", skills: [], outputs: [] }])}><Plus size={16} />添加步骤<span className="muted">{steps.length} / 12</span></button>
    <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={!valid || busy}>{busy ? <Busy>正在启动</Busy> : <><Play size={17} />创建并启动</>}</button></footer>
  </form></Modal>;
}

export default function Automations({ nodes, canWrite, onTask }: { nodes: FleetNode[]; canWrite: boolean; onTask: (id: string) => void }) {
  const [cursor, setCursor] = useState("0"); const [nextCursor, setNextCursor] = useState<string | null>(null); const [history, setHistory] = useState<string[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]); const [selected, setSelected] = useState(""); const [loading, setLoading] = useState(true); const [syncError, setSyncError] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [revision, setRevision] = useState(0); const [composer, setComposer] = useState(false); const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const [serial, parallel] = await Promise.all([api<{ automations: Flow[] }>("/v1/automations?limit=200"), api<{ workflows: Flow[]; nextCursor: string | null }>(`/v1/workflows?limit=20&cursor=${cursor}`)]); if (alive) { setFlows([...parallel.workflows, ...(cursor === "0" ? serial.automations : [])].sort((a,b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))); setNextCursor(parallel.nextCursor); setSyncError(""); } }
      catch (err) { if (alive) setSyncError(errorText(err)); }
      finally { if (alive) { setLoading(false); timer = setTimeout(load, document.hidden ? 30000 : 5000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [revision, cursor]);
  const flow = flows.find(value => value.id === selected) || flows[0];
  async function action(kind: "pause" | "resume" | "cancel") {
    if (!flow || busy) return; setBusy(kind); setError("");
    try { if (flow.kind === "parallel") await mutation("/v1/workflows/cancel", { workflowId: flow.workflowId, creator: flow.creator, project: flow.project }); else await mutation(`/v1/automations/${encodeURIComponent(flow.id)}/${kind}`, {}); setConfirmCancel(false); setRevision(value => value + 1); }
    catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  const state = FLOW_STATUS[flow?.status || ""] || { label: flow?.status || "", tone: "neutral" };
  const displaySteps = flow?.kind === "parallel" ? [...flow.steps].sort((a,b) => (nodes.find(n => n.id === a.targetNode)?.code || a.targetNode).localeCompare(nodes.find(n => n.id === b.targetNode)?.code || b.targetNode, "zh-CN", {numeric:true})) : flow?.steps || [];
  const done = flow?.steps.filter(step => DONE_STEPS.has(step.status || "")).length || 0;
  return <>
    <div className="flow-page-heading">{canWrite && <button className="button primary" onClick={() => setComposer(true)} disabled={!nodes.length}><Plus size={17} />创建流程</button>}</div>
    {syncError && <Notice>{syncError}</Notice>}{error && <Notice>{error}</Notice>}
    {loading && !flows.length ? <div className="loading-inline"><Busy>正在读取流程</Busy></div> : !flows.length ? <Section title="协作流程"><Empty icon={<Workflow size={28} />} title="把多台电脑连成一条工作流程">每步完成后自动交接，有异常再处理。</Empty></Section> : <div className="flow-layout"><Section title="我的流程" className="flow-list-panel"><div className="flow-list">{flows.map(value => { const status = FLOW_STATUS[value.status] || { label: value.status, tone: "neutral" }; return <button key={value.id} className={value.id === flow?.id ? "active" : ""} onClick={() => { setSelected(value.id); setConfirmCancel(false); setError(""); }}><strong>{value.name}</strong><div><span className={`status status-${status.tone}`}>{status.label}</span><small>{value.kind === "parallel" || value.executionMode === "parallel" ? "并行 · " : "串行 · "}{value.totalSteps || value.steps.length} 项</small></div><time>{time(value.updatedAt)}</time></button>; })}</div>{(history.length > 0 || nextCursor) && <div className="flow-pagination"><button className="text-button" disabled={!history.length} onClick={() => { setCursor(history.at(-1)!); setHistory(v => v.slice(0,-1)); setSelected(""); }}>上一页</button><button className="text-button" disabled={!nextCursor} onClick={() => { setHistory(v => [...v,cursor]); setCursor(nextCursor!); setSelected(""); }}>更早流程</button></div>}</Section>
      {flow && <Section title={flow.name} className="flow-detail-panel" action={<button className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />刷新</button>}><div className="flow-status-line"><span className={`status status-${state.tone}`}><i />{state.label}</span><span>{done} / {flow.totalSteps || flow.steps.length} 项已提交</span></div><progress className="flow-progress" value={done} max={flow.totalSteps || flow.steps.length || 1} />
        {flow.error && <Notice>{flow.error}</Notice>}{flow.status === "paused" && <p className="flow-state-note">当前执行可继续，后续步骤暂停派发。</p>}{flow.status === "needs_attention" && <p className="flow-state-note">打开异常步骤处理后，再继续流程。</p>}{flow.status === "completed" && <p className="flow-state-note">各步结果已提交，可打开任务检查内容。</p>}
        {flow.kind === "parallel" && <div className="flow-run-overview"><div><span>总控</span><strong>{nodes.find(n => n.id === flow.controllerNode)?.code || "总控"}</strong></div><div><span>批次</span><code>{flow.workflowId}</code></div><div><span>汇总</span><strong>{flow.status === "completed" ? "文件已核验并归集" : flow.status === "collecting" ? "等待总控核验与上传" : "各机任务结束后归集"}</strong></div></div>}<ol className={`flow-steps ${flow.kind === "parallel" || flow.executionMode === "parallel" ? "flow-parallel" : ""}`}>{displaySteps.map((step, index) => { const node = nodes.find(item => item.id === step.targetNode); return <li key={step.key || index}><div className={`flow-step-number ${DONE_STEPS.has(step.status || "") ? "done" : ""}`}>{DONE_STEPS.has(step.status || "") ? <Check size={16} /> : index + 1}</div><div className="flow-step-content"><header><strong>{(flow.kind === "parallel" && flow.workflowId ? step.name.replace(` · ${flow.workflowId}`, "") : step.name) || `步骤 ${index + 1}`}</strong><StepStatus status={step.status} /></header><div className="flow-step-device"><span>{node ? deviceLabel(node) : "设备"}</span><span className={`connection ${node?.online ? "online" : "offline"}`}><i />{node?.online ? "在线" : DONE_STEPS.has(step.status || "") ? "离线" : "离线 · 等待恢复"}</span></div>{step.prompt && <p>{step.prompt}</p>}{flow.kind === "parallel" && step.summary && <p>{step.summary}</p>}{flow.kind === "parallel" && <div className="flow-file-counts">输入 {step.inputs?.length || 0} 份 · 已回传 {step.artifacts?.filter(f => f.status === "complete").length || 0} 份{step.updatedAt && <span> · {time(step.updatedAt)}</span>}</div>}{step.error && <p className="flow-step-error">{step.error}</p>}{step.taskId && <button className="text-button" onClick={() => onTask(step.taskId!)}>查看任务与交接文件<ArrowRight size={14} /></button>}</div>{flow.kind !== "parallel" && flow.executionMode !== "parallel" && index < flow.steps.length - 1 && <ArrowDown className="flow-step-arrow" size={14} />}</li>; })}</ol>
        {flow.result && <details className="flow-result" open={flow.kind === "parallel" ? true : undefined}><summary>最终汇总与文件</summary>{flow.result.summary && <p className="prose-block">{flow.result.summary}</p>}{(flow.result.artifacts || []).map(file => <a key={file.sha} href={flow.kind === "parallel" ? `/api/console/files/${encodeURIComponent(file.sha)}?project=${encodeURIComponent(flow.project)}` : `/v1/artifacts/${encodeURIComponent(file.sha)}?task=${encodeURIComponent(flow.result!.taskId!)}`} download={file.name.split(/[\\/]/).pop()}><Download size={15} />{file.name.split(/[\\/]/).pop()}</a>)}</details>}
        {confirmCancel && <Notice tone="info">取消此流程中尚未结束的任务？<div className="inline-actions"><button className="button danger small" disabled={!!busy} onClick={() => void action("cancel")}>确认取消流程</button><button className="button secondary small" disabled={!!busy} onClick={() => setConfirmCancel(false)}>保持运行</button></div></Notice>}
        {canWrite && flow.canManage === true && (flow.kind !== "parallel" || flow.steps.some(s => ["queued","claimed","running","uncertain","blocked","cancel_requested"].includes(s.status || ""))) && !["completed", "cancelled", "cancelling"].includes(flow.status) && <div className="flow-actions"><button className="button quiet small danger-text" disabled={!!busy} onClick={() => setConfirmCancel(true)}><Square size={14} />取消流程</button><div className="spacer" />{flow.kind === "parallel" ? null : flow.status === "running" ? <button className="button secondary small" disabled={!!busy} onClick={() => void action("pause")}>{busy === "pause" ? <Busy /> : <><Pause size={15} />暂停后续步骤</>}</button> : <button className="button primary small" disabled={!!busy} onClick={() => void action("resume")}>{busy === "resume" ? <Busy /> : <><Play size={15} />继续流程</>}</button>}</div>}
      </Section>}
    </div>}
    {composer && <FlowComposer nodes={nodes} onClose={() => setComposer(false)} onCreated={value => { setFlows(previous => [value, ...previous.filter(flow => flow.id !== value.id)]); setSelected(value.id); setComposer(false); setRevision(previous => previous + 1); }} />}
  </>;
}
