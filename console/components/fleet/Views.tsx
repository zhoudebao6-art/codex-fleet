"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, ChevronRight, Clock3, Copy, Download, FileText, FolderOpen, MessageSquare, Monitor, Plus, Search, Send, Upload } from "lucide-react";
import { api, bytes, errorText, mutation, taskTitle, time, uploadFile } from "./api";
import type { ComposerSeed, DeviceGroup, FleetEvent, FleetFile, FleetNode, FleetTask, GroupAccess } from "./types";
import { Busy, Empty, Modal, Notice, Section, Status } from "./ui";
import { actorName, describeEvent } from "./events";
import {RuntimeBadge} from "./RuntimeStatus";
import { FileCatalog } from "./FileCatalog";

export function NodeList({ nodes, tasks, canWrite, onCompose, detailed = false }: { nodes: FleetNode[]; tasks: FleetTask[]; canWrite: boolean; onCompose: (seed: ComposerSeed) => void; detailed?: boolean }) {
  if (!nodes.length) return <Empty icon={<Monitor size={27} />} title="还没有设备">添加电脑后，即可派发任务。</Empty>;
  return <div className="node-list">{[...nodes].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })).map(node => {
    const active = tasks.filter(t => t.target === node.id && ["claimed", "running", "blocked", "uncertain"].includes(t.status));
    const skills = Array.from(new Set((node.capabilities?.skills || []).flatMap(s => typeof s === "string" ? [s] : s.names || (s.name ? [s.name] : []))));
    return <article className={`node-row ${node.revoked ? "revoked" : ""}`} key={node.id}>
      <div className="node-symbol"><Monitor size={26} strokeWidth={1.7} /></div>
      <div className="node-identity"><h3>{node.name}</h3><RuntimeBadge node={node}/>{detailed && <small>最近连接 {time(node.lastSeen || node.last_seen)}</small>}</div>
      <div className="node-work"><div><span>项目</span>{node.projects?.join("、") || "未登记"}</div>{active.length ? <p>{node.online ? `${active.length} 项处理中` : "最后任务"} · {taskTitle(active[0].spec?.prompt)}</p> : <p>{node.revoked ? "已停用" : node.online ? "空闲" : "离线"}</p>}{detailed && (skills.length > 0 || node.accountGroup) && <details className="node-extra"><summary>技能与账号</summary>{skills.length > 0 && <div className="tags">{skills.slice(0, 8).map(s => <span key={s}>{s}</span>)}{skills.length > 8 && <span>另 {skills.length - 8} 项</span>}</div>}{node.accountGroup && <small className="account-group">账号分组 {node.accountGroup}</small>}</details>}</div>
      {canWrite && !node.revoked && <button className="button outline small" onClick={() => onCompose({ node })}><Send size={15} /><span>派任务</span></button>}
    </article>;
  })}</div>;
}

export function TaskList({ tasks, nodes, onSelect, withFilters = false, history = false, emptyLabel }: { emptyLabel?: string; tasks: FleetTask[]; nodes: FleetNode[]; onSelect: (task: FleetTask) => void; withFilters?: boolean; history?: boolean }) {
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all");
  const shown = tasks.filter(t => (filter === "all" || (filter === "active" ? ["queued", "claimed", "running", "blocked", "uncertain", "cancel_requested"].includes(t.status) : t.status === filter)) && (taskTitle(t.spec?.prompt).toLowerCase().includes(query.toLowerCase()) || (nodes.find(n => n.id === t.target)?.name || "").toLowerCase().includes(query.toLowerCase())));
  return <>{withFilters && <div className="filter-bar"><div className="search-field"><Search size={17} /><input aria-label="搜索任务或设备" placeholder="搜索任务或设备" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="按状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="active">正在处理</option><option value="submitted">待确认</option><option value="accepted">已确认</option><option value="failed">执行失败</option><option value="cancelled">已取消</option></select></div>}
    {shown.length === 0 ? <Empty icon={<FileText size={26} />} title={emptyLabel || (history ? "没有符合条件的协作任务" : query || filter !== "all" ? "没有符合条件的任务" : "从第一个任务开始")}>{emptyLabel ? undefined : history ? "可切换任务阶段，或查看电脑任务。" : query || filter !== "all" ? "调整搜索或筛选条件后再试。" : "选择一台已接入的电脑，安排工作或发起只读提问。"}</Empty> : <div className="task-table"><div className="task-table-header"><span>任务名称</span><span>目标电脑</span><span>状态</span><span>{history ? "执行完成 / 创建" : "创建时间"}</span><span /></div>{shown.map(task => <button className="task-row" key={task.id} onClick={() => onSelect(task)}><div className="task-name"><strong>{taskTitle(task.spec?.prompt)}</strong><small className={history && task.result?.summary ? "task-result-preview" : ""}>{history && task.result?.summary ? task.result.summary : `${task.project === "workspace" ? "协作任务" : task.project}${task.spec?.mode === "question" ? " · 只读提问" : ""}`}</small>{history && (task.artifacts || task.result?.artifacts || []).length > 0 && <small className="task-result-files">{(task.artifacts || task.result?.artifacts || []).length} 个产物</small>}</div><span className="task-target">{nodes.find(n => n.id === task.target)?.name || task.target.slice(0, 12)}</span><Status value={task.status} /><time title={history && task.completedAt ? "执行完成时间" : "创建时间"}>{time(history && task.completedAt ? task.completedAt : task.created)}</time><ChevronRight className="task-chevron" size={17} /></button>)}</div>}
  </>;
}

export function Timeline({ events, onTask, expanded = false }: { events: FleetEvent[]; onTask?: (id: string) => void; expanded?: boolean }) {
  if (!events.length) return <Empty icon={<MessageSquare size={25} />} title="协作记录会出现在这里">派发任务、交换消息、交接文件后，可以查看每一步的真实进展。</Empty>;
  return <ol className="timeline">{events.slice(0, expanded ? 100 : 12).map((event, index) => {
    const payload = event.payload || {}; const { kind, label, text } = describeEvent(event);
    const name = actorName(event.sourceName || event.nodeName || (typeof payload.nodeName === "string" ? payload.nodeName : undefined));
    const taskId = event.taskId || event.task_id || event.task || (typeof payload.taskId === "string" ? payload.taskId : undefined);
    const isFile = /file|input|artifact/.test(kind); const Icon = isFile ? FileText : /finish|accept/.test(kind) ? CheckCircle2 : /assign|start/.test(kind) ? Send : MessageSquare;
    return <li key={event.seq || index}><div className={`timeline-icon ${isFile ? "blue" : ""}`}><Icon size={16} /></div><div className="timeline-content"><div className="timeline-title"><strong>{name}{event.targetName && event.targetName !== name ? ` → ${event.targetName}` : ""}</strong><time>{time(event.created)}</time></div><p>{label}</p>{text && <div className="timeline-detail">{text.slice(0, expanded ? 1000 : 220)}</div>}{event.taskName && !text && <small>{event.taskName}</small>}{taskId && onTask && <button className="text-button" onClick={() => onTask(taskId)}>查看任务<ArrowUpRight size={13} /></button>}</div></li>;
  })}</ol>;
}

export function FilesView({ files, nodes, canWrite, canAdmin, groups, access, refresh, onCompose, onTask }: { files: FleetFile[]; nodes: FleetNode[]; canWrite: boolean; canAdmin: boolean; groups: DeviceGroup[]; access?: GroupAccess; refresh: () => void; onCompose: (seed: ComposerSeed) => void; onTask: (id: string) => void }) {
  const projects = Array.from(new Set(nodes.flatMap(n => n.projects || []))).sort();
  const [project, setProject] = useState(projects[0] || "workspace"); const [error, setError] = useState("");
  const [uploadGroup, setUploadGroup] = useState("");
  const restricted = !canAdmin && access?.mode === "groups";
  const allowedGroups = [...groups, ...(access?.groupIds.includes("__ungrouped__") ? [{ id: "__ungrouped__", name: "未分组" }] : [])].filter(group => access?.groupIds.includes(group.id));
  const selectedGroup = allowedGroups.some(group => group.id === uploadGroup) ? uploadGroup : allowedGroups.length === 1 ? allowedGroups[0].id : "";
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState<{ text: string; percent: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [resetFile, setResetFile] = useState<FleetFile | null>(null); const [resetReason, setResetReason] = useState(""); const [resetBusy, setResetBusy] = useState(false);
  async function resetUpload() { if (!resetFile || !resetReason.trim()) return; setResetBusy(true); setError(""); try { await mutation(`/api/console/files/${resetFile.sha}/reset`, { project: resetFile.project, reason: resetReason.trim() }); setResetFile(null); setResetReason(""); setRevision(x => x + 1); refresh(); } catch (err) { setError(errorText(err)); } finally { setResetBusy(false); } }
  async function upload(file?: File) {
    if (!file || restricted && !selectedGroup) return; setBusy(true); setError("");
    try { await uploadFile(file, project, setProgress, restricted ? selectedGroup : undefined); setRevision(x => x + 1); refresh(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <Section title="文件交接">
    {error && <Notice>{error}</Notice>}
    {canWrite && <div className="upload-zone"><div className="upload-zone-icon"><Upload size={25} /></div><div><h3>上传文件</h3><p>最大 512 MB，支持断点续传。</p></div><div className="upload-zone-controls">{restricted && <select aria-label="文件可见分组" value={selectedGroup} onChange={event => setUploadGroup(event.target.value)} disabled={busy}><option value="">选择可见分组</option>{allowedGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>}<select aria-label="文件所属项目" value={project} onChange={e => setProject(e.target.value)} disabled={busy}>{(projects.length ? projects : ["workspace"]).map(p => <option key={p}>{p}</option>)}</select><label className={`button primary file-input ${busy || restricted && !selectedGroup ? "disabled" : ""}`}>{busy ? <Busy>正在上传</Busy> : <><Plus size={18} />上传文件</>}<input type="file" disabled={busy || restricted && !selectedGroup} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label></div></div>}
    {progress && <div className="upload-progress" role="status"><span>{progress.text}</span><span>{progress.percent}%</span><progress value={progress.percent} max={100} /></div>}
    <FileCatalog nodes={nodes} revision={`${revision}:${files.map(f => `${f.sha}:${f.status}:${f.offset}`).join("|")}`} canWrite={canWrite} canAdmin={canAdmin} onCompose={onCompose} onTask={onTask} onReset={file => { setResetFile(file); setResetReason(""); setError(""); }} />
    {resetFile && <Modal title="重置失败上传" onClose={() => setResetFile(null)} busy={resetBusy}><div className="form-body">{error && <Notice>{error}</Notice>}<p>{resetFile.name}</p><label>重置原因<input value={resetReason} onChange={e => setResetReason(e.target.value)} maxLength={2000} placeholder="例如：校验失败，需要重新上传" /></label><footer className="modal-footer"><button className="button secondary" disabled={resetBusy} onClick={() => setResetFile(null)}>取消</button><button className="button primary" disabled={resetBusy || !resetReason.trim()} onClick={resetUpload}>{resetBusy ? <Busy /> : "重置并允许重传"}</button></footer></div></Modal>}
  </Section>;
}

export function AccessScreen({ loading, access, error }: { loading: boolean; access: string; error: string }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [remember, setRemember] = useState(true); const [loginError, setLoginError] = useState(""); const [busy, setBusy] = useState(false);
  async function login() {
    setBusy(true); setLoginError("");
    try { await mutation("/api/console/login", { username: username.trim(), password, remember }); setPassword(""); window.location.reload(); }
    catch (err) { setLoginError(errorText(err)); } finally { setBusy(false); }
  }
  return <main className="access-page"><div className="access-brand">协作台<span>Codex Fleet</span></div><div className="access-panel"><div className="access-icon"><Monitor size={32} /></div><h1>{loading ? "正在连接协作台" : access === "error" ? "暂时无法连接" : "让你的电脑一起工作"}</h1><p>{loading ? "正在确认身份并读取设备状态。" : access === "error" ? "请检查网络连接，然后重新尝试。" : "登录后管理设备与任务。"}</p>{error && !loading && access === "error" && <Notice>{error}</Notice>}{loginError && <Notice>{loginError}</Notice>}{!loading && access !== "error" && <><a className="button secondary full-width" href="http://127.0.0.1:43129/login" target="_top">已接入电脑 · 免登录进入</a><form className="login-form" onSubmit={e => { e.preventDefault(); void login(); }}><label>用户名<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="输入网站账号" required maxLength={64} autoCapitalize="none" spellCheck={false} /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="输入密码" required maxLength={512} /></label><div className="login-options"><label><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />在此设备保持登录</label><span>账号由管理员添加</span></div><button className="button primary full-width" type="submit" disabled={busy}>{busy ? <Busy>正在登录</Busy> : "登录协作台"}</button></form><a className="login-alternative" href="/signin-with-chatgpt?return_to=/" target="_top">也可以使用已授权的 ChatGPT 账号</a></>}{!loading && access === "error" && <button className="button primary full-width" onClick={() => window.location.reload()}>重新连接</button>}<div className="access-note"><CheckCircle2 size={17} /><span>已接入电脑打开桌面「Codex Fleet Console」。</span></div></div></main>;
}
