"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Plus, RefreshCw } from "lucide-react";
import { api, errorText, mutation, uid } from "./api";
import type { DesktopThread } from "./desktop-types";
import type { FleetNode } from "./types";
import { Busy, Notice } from "./ui";

export type Workspace = { id: string; nodeId: string; nodeName?: string; project: string; name: string; root?: string | null; path?: string | null; source: string; sourceThreadId?: string | null; controllerThreadId?: string | null; automationNote?: string; status: string; error?: string | null };
type Discovered = { nodeId: string; project: string; name: string; root: string; path?: string; sourceThreadId: string; threadCount: number };
type ProjectList = { workspaces: Workspace[]; discovered: Discovered[] };
const EMPTY_PROJECTS: ProjectList = { workspaces: [], discovered: [] };
function projectName(name?: string) { return !name || name === "workspace" ? "默认工作目录" : name; }

export default function ProjectPicker({ node, initialId, disabled, onSelection }: { node?: FleetNode; initialId?: string; disabled: boolean; onSelection: (value: Workspace | null) => void }) {
  const [data, setData] = useState<ProjectList>(EMPTY_PROJECTS); const [kind, setKind] = useState<"existing" | "new">("existing");
  const [projectQuery,setProjectQuery]=useState("");
  const [selection, setSelection] = useState(initialId ? `workspace:${initialId}` : ""); const [name, setName] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [syncError, setSyncError] = useState(""); const [revision, setRevision] = useState(0);
  const [controller, setController] = useState(""); const [automation, setAutomation] = useState(""); const [threads, setThreads] = useState<DesktopThread[]>([]); const [saved, setSaved] = useState(false); const [threadError, setThreadError] = useState("");
  const creation = useRef<{ id: string; snapshot: string } | null>(null); const onSelectionRef = useRef(onSelection); const initializedBinding = useRef("");
  onSelectionRef.current = onSelection;
  const selected = data.workspaces.find(workspace => `workspace:${workspace.id}` === selection) || null;
  const discovered = data.discovered.find(workspace => `discovered:${workspace.sourceThreadId}` === selection);
  const version = String(node?.capabilities?.version || ""); const outdated = version.startsWith("0.2.");
  const catalog=node?.capabilities?.workspaceCatalog;
  useEffect(() => {
    if (!node) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const value = await api<ProjectList>(`/v1/workspaces?nodeId=${encodeURIComponent(node!.id)}`); if (alive) { setData(value); setSyncError(""); } }
      catch (err) { if (alive) setSyncError(errorText(err)); }
      finally { if (alive) { setLoading(false); timer = setTimeout(load, document.hidden ? 30000 : 5000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [node?.id, revision]);
  useEffect(() => { onSelectionRef.current(selected); }, [selected]);
  useEffect(() => {
    if (!selected || selected.status !== "ready") { setThreads([]); return; }
    if (initializedBinding.current !== selected.id) { setController(selected.controllerThreadId || ""); setAutomation(selected.automationNote || ""); initializedBinding.current = selected.id; setSaved(false); }
    let alive = true;
    void api<{ threads: DesktopThread[] }>(`/v1/workspaces/${encodeURIComponent(selected.id)}/threads`).then(result => { if (alive) { setThreads(result.threads); setThreadError(""); } }).catch(err => { if (alive) setThreadError(errorText(err)); });
    return () => { alive = false; };
  }, [selected?.id, selected?.status]);
  async function create(source?: Discovered) {
    if (!node || busy || disabled || (!source && !name.trim())) return;
    const spec = { nodeId: node.id, name: source ? projectName(source.name) : name.trim(), ...(source ? { sourceThreadId: source.sourceThreadId } : {}) };
    const snapshot = JSON.stringify(spec);
    if (creation.current && creation.current.snapshot !== snapshot) { setError("上次创建结果尚未确认。请刷新项目列表，或保留原名称重试。"); return; }
    if (!creation.current) creation.current = { id: uid(), snapshot };
    setBusy("create"); setError("");
    try {
      const value = await mutation<Workspace>("/v1/workspaces", { id: creation.current.id, ...spec });
      creation.current = null;
      setData(previous => ({ ...previous, workspaces: [...previous.workspaces.filter(workspace => workspace.id !== value.id), value] }));
      setSelection(`workspace:${value.id}`); setKind("existing"); setRevision(previous => previous + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  async function saveBinding() {
    if (!selected || disabled || busy) return;
    setBusy("binding"); setError(""); setSaved(false);
    try { const value = await mutation<Workspace>(`/v1/workspaces/${encodeURIComponent(selected.id)}`, { controllerThreadId: controller || null, automationNote: automation.trim() }, "PATCH"); setData(previous => ({ ...previous, workspaces: previous.workspaces.map(workspace => workspace.id === value.id ? value : workspace) })); setSaved(true); }
    catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  const matches=(name:string,root?:string|null)=>`${name} ${root||""}`.toLowerCase().includes(projectQuery.trim().toLowerCase());
  const bindingChanged = selected && (controller !== (selected.controllerThreadId || "") || automation.trim() !== (selected.automationNote || ""));
  return <fieldset className="project-picker"><legend>在哪个项目里工作？</legend>
    {catalog?.enabled && <p className="field-hint" role="status">{catalog.state==="synced" ? `已自动同步 ${data.workspaces.length} 个工作空间` : catalog.state==="partial" ? "已有目录可用，部分项目仍待同步" : catalog.state==="retrying" ? "工作空间同步将自动重试" : "正在同步这台电脑的工作空间…"}</p>}
    {outdated && <Notice tone="info">这台电脑需要升级节点，才能选择真实项目目录。已有任务会继续运行。</Notice>}
    <div className="project-kind" role="group" aria-label="项目方式"><button type="button" className={kind === "existing" ? "active" : ""} disabled={disabled || !!busy} onClick={() => { setKind("existing"); onSelectionRef.current(selected); }}><FolderOpen size={15} />已有项目</button><button type="button" className={kind === "new" ? "active" : ""} disabled={disabled || !!busy} onClick={() => { setKind("new"); setSelection(""); onSelectionRef.current(null); }}><Plus size={16} />新建项目</button></div>
    {syncError && <Notice>{syncError}</Notice>}{error && <Notice>{error}</Notice>}
    {kind === "new" ? <div className="project-create"><label>项目名称<input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} placeholder="例如：专利资料整理" maxLength={100} disabled={disabled || !!busy} /></label><button type="button" className="button secondary small" disabled={!name.trim() || disabled || !!busy || outdated} onClick={() => void create()}>{busy === "create" ? <Busy>正在创建</Busy> : <><Plus size={15} />创建项目</>}</button></div> : <>{data.workspaces.length+data.discovered.length>8 && <input aria-label="搜索可选项目" placeholder="搜索项目名称或目录" value={projectQuery} onChange={e=>setProjectQuery(e.target.value)} disabled={disabled||!!busy}/> }<label className="visually-hidden" htmlFor="workspace-choice">选择已有项目</label><select id="workspace-choice" aria-label="选择已有项目" value={selection} disabled={disabled || !!busy || loading} onChange={event => { setSelection(event.target.value); setSaved(false); }}><option value="">{loading ? "正在读取这台电脑的项目…" : "选择已有项目"}</option>{data.workspaces.length > 0 && <optgroup label="已接入项目">{data.workspaces.filter(w=>matches(w.name,w.root)||`workspace:${w.id}`===selection).map(workspace => <option key={workspace.id} value={`workspace:${workspace.id}`}>{projectName(workspace.name)}{data.workspaces.filter(w=>w.name===workspace.name).length>1 ? ` · ${workspace.root}` : ""}{workspace.status === "pending" ? " · 准备中" : workspace.status === "error" ? " · 需要处理" : ""}</option>)}</optgroup>}{data.discovered.length > 0 && <optgroup label="从电脑任务发现的项目">{data.discovered.filter(p=>matches(p.name,p.root)||`discovered:${p.sourceThreadId}`===selection).filter(project => !data.workspaces.some(workspace => workspace.root === project.root)).map(project => <option key={project.sourceThreadId} value={`discovered:${project.sourceThreadId}`}>{projectName(project.name)} · {project.threadCount} 个会话</option>)}</optgroup>}</select>{!loading && !data.workspaces.length && !data.discovered.length && <p className="field-hint">尚未发现项目。等待任务目录同步，或新建项目。</p>}</>}
    {kind === "existing" && discovered && <div className="project-selection"><div><strong>{projectName(discovered.name)}</strong><code>{discovered.root}</code></div><button type="button" className="button secondary small" disabled={disabled || !!busy || outdated} onClick={() => void create(discovered)}>{busy === "create" ? <Busy /> : "使用此项目"}</button></div>}
    {kind === "existing" && selected && <div className={`project-selection ${selected.status === "ready" ? "ready" : ""}`}><div><strong><FolderOpen size={15} />{projectName(selected.name)}</strong>{selected.root && <code>{selected.root}</code>}{selected.status === "pending" && <p><RefreshCw size={13} className="spin" />{node?.online ? "正在这台电脑上准备项目目录" : "等待电脑上线后准备项目"}</p>}{selected.status === "ready" && <p><Check size={13} />项目已就绪</p>}{selected.status === "error" && <p>{selected.error || "项目准备失败，请检查目标电脑。"}</p>}</div></div>}
    {selected?.status === "ready" && <details className="project-binding"><summary>总控对话与自动化对接</summary>{threadError && <Notice>{threadError}</Notice>}<label>项目总控对话<select aria-label="项目总控对话" value={controller} onChange={event => { setController(event.target.value); setSaved(false); }} disabled={disabled || !!busy}><option value="">暂不绑定</option>{controller && !threads.some(thread => thread.threadId === controller) && <option value={controller}>已绑定的总控对话</option>}{threads.map(thread => <option key={thread.threadId} value={thread.threadId}>{thread.title || "未命名对话"}{thread.archived ? " · 已归档" : ""}</option>)}</select></label><label>自动化对接说明<textarea rows={2} value={automation} maxLength={2000} placeholder="说明这个项目主要由谁协调、有哪些固定流程。" onChange={event => { setAutomation(event.target.value); setSaved(false); }} disabled={disabled || !!busy} /></label><div className="project-binding-actions"><span>{saved ? "已保存" : bindingChanged ? "修改后请保存" : "绑定后可从项目中找到总控对话"}</span><button type="button" className="button secondary small" disabled={disabled || !!busy || !bindingChanged} onClick={() => void saveBinding()}>{busy === "binding" ? <Busy /> : "保存对接设置"}</button></div></details>}
  </fieldset>;
}
