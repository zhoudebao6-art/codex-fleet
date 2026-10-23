"use client";

import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { FileText, HelpCircle, Paperclip, Play, Send, X } from "lucide-react";
import { ApiError, bytes, errorText, mutation, uid, uploadFile } from "./api";
import type { ComposerSeed, FleetFile, FleetNode, FleetTask, InputFile } from "./types";
import { Busy, Modal, Notice } from "./ui";
import ProjectPicker, { type Workspace } from "./ProjectPicker";
import { deviceLabel } from "./device-utils";
import { runtimeIssue } from "../../lib/fleet/runtime-readiness.mjs";

export type TaskDraft={intent?:"conversation"|"collaboration";target:string;project:string;mode:"question"|"execute";executionPolicy:"local"|"project";prompt:string;skills:string[];outputs:string;inputs:InputFile[];workspaceId?:string;requestId:string;submittedSnapshot:string|null};

export default function TaskComposer({ nodes, files, seed, draft, onDraft, onClose, onCreated }: { nodes: FleetNode[]; files: FleetFile[]; seed: ComposerSeed; draft?:TaskDraft|null; onDraft?:(draft:TaskDraft|null)=>void; onClose: () => void; onCreated: (task: FleetTask) => void }) {
  const available = nodes.filter(n => !n.revoked).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const initialNode = seed.node || available.find(n=>n.id===draft?.target) || available.find(n => n.id === seed.resumeTask?.target) || available.find(n => seed.project && n.projects.includes(seed.project)) || available[0];
  const [target, setTarget] = useState(initialNode?.id || "");
  const [project, setProject] = useState(draft?.project || seed.project || seed.resumeTask?.project || initialNode?.projects?.[0] || "workspace");
  const [intent,setIntent]=useState<"conversation"|"collaboration">(seed.resumeTask?"collaboration":draft?.intent||"conversation");
  const conversation=intent==="conversation";
  const [mode, setMode] = useState<"question" | "execute">(draft?.mode || seed.mode || "execute");
  const [executionPolicy, setExecutionPolicy] = useState<"local" | "project">(draft?.executionPolicy || (seed.resumeTask ? seed.resumeTask.spec.executionPolicy === "local" ? "local" : "project" : "local"));
  const [prompt, setPrompt] = useState(draft?.prompt || "");
  const [skills, setSkills] = useState<string[]>(draft?.skills || []);
  const [outputs, setOutputs] = useState(draft?.outputs || "");
  const [inputs, setInputs] = useState<InputFile[]>(draft?.inputs || seed.inputs || []);
  const [selectedFile, setSelectedFile] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<{ text: string; percent: number } | null>(null);
  const [requestId] = useState(()=>draft?.requestId || uid());
  const [submittedSnapshot, setSubmittedSnapshot] = useState<string | null>(draft?.submittedSnapshot || null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const node = available.find(n => n.id === target);
  const knownSkills = Array.from(new Set((node?.capabilities?.skills || []).flatMap(s => typeof s === "string" ? [s] : s.project && s.project !== project ? [] : s.names || (s.name ? [s.name] : []))));
  const eligibleFiles = files.filter(file => file.project === project && file.status === "complete" && !inputs.some(i => i.sha === file.sha));
  const projectScope = useRef(project); projectScope.current = project;
  const chooseWorkspace = useCallback((value: Workspace | null) => { setWorkspace(value); if (value) { if (value.project !== projectScope.current) { setInputs([]); setSkills([]); } setProject(value.project); } }, []);
  const workspaceReady = seed.resumeTask ? true : workspace?.status === "ready" && node?.capabilities?.workspaceExecution === true;
  const policyReady = mode === "question" || executionPolicy === "project" || node?.capabilities?.localExecutionPolicy === true;

  function closeWithDraft(){if(!seed.resumeTask)onDraft?.(prompt.trim()||inputs.length ? {intent,target,project,mode,executionPolicy,prompt,skills,outputs,inputs,workspaceId:workspace?.id,requestId,submittedSnapshot}:null);onClose();}
  function changeTarget(id: string) {
    const next = available.find(n => n.id === id);
    setTarget(id); setSkills([]); setWorkspace(null);
    if (!next?.projects?.includes(project)) { setProject(next?.projects?.[0] || "workspace"); setInputs([]); }
  }
  async function pickFile(file?: File) {
    if (!file) return;
    setUploading(true); setError("");
    try { const uploaded = await uploadFile(file, project, setUploadState, node ? node.groupId || "__ungrouped__" : undefined); setInputs(previous => [...previous.filter(i => i.sha !== uploaded.sha), uploaded]); }
    catch (err) { setError(errorText(err)); }
    finally { setUploading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (conversation&&node?.capabilities?.conversationDispatch!==true){setError(runtimeIssue(node)||"此电脑需要新版桌面联动，升级后即可直接新建对话。");return;}
    if (!node || !node.projects.includes(project) || !prompt.trim() || !workspaceReady || !policyReady || busy || uploading) return;
    const workspaceId = workspace?.id || (typeof seed.resumeTask?.spec.workspaceId === "string" ? seed.resumeTask.spec.workspaceId : undefined);
    const body = { ...(conversation?{intent:"conversation",worktree:false}:{}),id: requestId, targetNode: node.id, project, ...(workspaceId ? { workspaceId } : {}), prompt: prompt.trim(), mode, ...(!seed.resumeTask ? {requireDesktop:true} : seed.resumeTask.spec.requireDesktop !== undefined ? {requireDesktop:seed.resumeTask.spec.requireDesktop} : {}), ...(mode === "execute" ? { executionPolicy } : {}), skills, outputs: mode === "question" ? [] : outputs.split(/\r?\n/).map(s => s.trim()).filter(Boolean), dependencies: [], inputs: inputs.map(({ sha, size, name }) => ({ sha, size, name })), ...(seed.resumeTask ? { resumeTaskId: seed.resumeTask.id, worktree: false } : {}) };
    const snapshot = JSON.stringify(body);
    if (submittedSnapshot && snapshot !== submittedSnapshot) { setError("上次发送结果尚未确认。请保留原内容重试，或关闭窗口后在任务列表确认是否已创建。"); return; }
    setBusy(true); setError(""); setSubmittedSnapshot(snapshot);
    try { const task = await mutation<FleetTask>("/v1/tasks", body); onCreated(task); }
    catch (err) { if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 409) setSubmittedSnapshot(null); setError(`${errorText(err)} 表单已保留，重试会沿用同一任务编号，避免重复派发。`); }
    finally { setBusy(false); }
  }

  return <Modal title={seed.resumeTask ? "继续协作任务" : conversation ? "新建桌面对话" : "派发协作任务"} onClose={closeWithDraft} busy={busy || uploading}>
    <form onSubmit={submit} className="form-body">
      {error && <Notice>{error}</Notice>}
      {draft && <div className="draft-hint">已恢复本次会话草稿</div>}
      {seed.resumeTask && <Notice tone="info">在原设备上继续。</Notice>}
      {!seed.resumeTask&&<label>操作<select value={intent} onChange={e=>setIntent(e.target.value as "conversation"|"collaboration")} disabled={busy}><option value="conversation">新建桌面对话</option><option value="collaboration">派发协作任务</option></select></label>}
      <div className="mode-picker" role="group" aria-label="任务类型">
        <button type="button" className={mode === "execute" ? "selected" : ""} onClick={() => setMode("execute")}><Play size={19} /><span><strong>{conversation?"普通对话":"安排工作"}</strong><small>按授权处理文件与代码</small></span></button>
        <button type="button" className={mode === "question" ? "selected" : ""} onClick={() => setMode("question")}><HelpCircle size={19} /><span><strong>只读提问</strong><small>查看并回答，不修改项目</small></span></button>
      </div>
      <label>目标电脑<select value={target} onChange={e => changeTarget(e.target.value)} disabled={!!seed.resumeTask || busy || uploading}><option value="" disabled>选择已接入的电脑</option>{available.map(n => <option value={n.id} key={n.id}>{deviceLabel(n)} · {n.online ? "在线" : "离线"}</option>)}</select></label>
      {seed.resumeTask ? <div className="resume-project">继续使用原任务的项目目录与会话。</div> : <ProjectPicker key={target} node={node} initialId={target === initialNode?.id ? (draft?.workspaceId || seed.workspaceId) : undefined} disabled={busy || uploading} onSelection={chooseWorkspace} />}
      {!seed.resumeTask && workspace?.status === "ready" && node?.capabilities?.workspaceExecution !== true && <Notice tone="info">项目目录已准备好，等待该电脑启用项目任务执行。</Notice>}
      {!policyReady && <Notice tone="info">这台电脑需要升级，才能沿用本机 Codex 权限。也可在高级设置中选择“仅项目目录”。</Notice>}
      {conversation&&node?.capabilities?.conversationDispatch!==true&&<Notice tone="info">{runtimeIssue(node)||'此电脑需更新桌面联动组件，完成后可直接创建普通对话。'}</Notice>}
      {node && !node.online && <Notice tone="info">设备离线，上线后接收任务。</Notice>}
      {node && !seed.resumeTask && node.capabilities?.desktopSessionBridge!==true && <Notice tone="info">等待这台电脑启用“Codex Fleet 联动”后执行，任务会保留在队列中。</Notice>}
      <label>{conversation?"第一条消息":mode === "question" ? "你想了解什么？" : "具体任务"}<textarea autoComplete="off" rows={5} placeholder={conversation ? "例如：只回复我你好。" : mode === "question" ? "例如：检查这个项目的当前进展，告诉我还缺哪些内容。" : "说明目标、范围和完成标准，例如：读取附件中的需求，完成修改并把结果文件交回。"} value={prompt} onChange={e => setPrompt(e.target.value)} required maxLength={40000} disabled={busy} /></label>
      <fieldset><legend>附件 <span>可选 · 最大 512 MB</span></legend>
        {inputs.length > 0 && <div className="attachment-list">{inputs.map(file => <div className="attachment" key={file.sha}><FileText size={17} /><span>{file.name}<small>{bytes(file.size)} · 已校验</small></span><button type="button" className="icon-button" aria-label={`移除 ${file.name}`} onClick={() => setInputs(previous => previous.filter(i => i.sha !== file.sha))}><X size={16} /></button></div>)}</div>}
        <div className="upload-actions"><label className={`button secondary file-input ${uploading ? "disabled" : ""}`}><Paperclip size={17} />{uploading ? "正在上传" : "上传文件"}<input type="file" disabled={busy || uploading} onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>{eligibleFiles.length > 0 && <select aria-label="添加已上传文件" value={selectedFile} onChange={e => { const file = eligibleFiles.find(f => f.sha === e.target.value); if (file) setInputs(previous => [...previous, file]); setSelectedFile(""); }}><option value="">选择已有文件</option>{eligibleFiles.map(f => <option key={f.sha} value={f.sha}>{f.name}</option>)}</select>}</div>
        {uploadState && <div className="upload-progress" role="status"><span>{uploadState.text}</span><span>{uploadState.percent}%</span><progress value={uploadState.percent} max={100} /></div>}
      </fieldset>
      {(knownSkills.length > 0 || mode === "execute") && <details className="advanced-options"><summary>高级设置</summary>{mode === "execute" && <label>执行权限<select value={executionPolicy} onChange={event => setExecutionPolicy(event.target.value as "local" | "project")} disabled={busy || !!seed.resumeTask}><option value="local">沿用本机 Codex 权限</option><option value="project">仅项目目录</option></select></label>}{knownSkills.length > 0 && <fieldset><legend>指定技能</legend><div className="skill-picker">{knownSkills.map(skill => <label key={skill} className="check-chip"><input type="checkbox" checked={skills.includes(skill)} onChange={e => setSkills(previous => e.target.checked ? [...previous, skill] : previous.filter(s => s !== skill))} />{skill}</label>)}</div></fieldset>}{mode === "execute" && <label>交回文件<textarea rows={2} value={outputs} onChange={e => setOutputs(e.target.value)} placeholder={"每行一个相对路径，例如 output/report.docx"} /></label>}</details>}
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={closeWithDraft} disabled={busy || uploading}>{prompt.trim() && !seed.resumeTask ? "保留草稿" : "取消"}</button><button type="submit" className="button primary" disabled={!node || !node.projects.includes(project) || !prompt.trim() || !workspaceReady || !policyReady || (conversation&&node?.capabilities?.conversationDispatch!==true) || busy || uploading}>{busy ? <Busy>正在发送</Busy> : <><Send size={17} />{conversation?"在桌面新建并发送":mode === "question" ? "向这台电脑提问" : "派发协作任务"}</>}</button></footer>
    </form>
  </Modal>;
}
