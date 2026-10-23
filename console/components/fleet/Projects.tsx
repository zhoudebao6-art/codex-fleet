"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, FileText, FolderOpen, Monitor, Search, Send } from "lucide-react";
import { time } from "./api";
import type { ComposerSeed, FleetNode, FleetTask, ProjectPhase, ProjectRef, RunningProject, RunningProjectTask } from "./types";
import type { DesktopThread } from "./desktop-types";
import { DesktopDirectory } from "./Desktop";
import FleetTaskDirectory from "./FleetTaskDirectory";
import { Empty, Notice, Section } from "./ui";
import type { Workspace } from "./ProjectPicker";

export type DiscoveredProject = { nodeId: string; nodeName?: string; project: string; name: string; root: string; sourceThreadId: string; threadCount: number };
export type ProjectIndex = { workspaces: Workspace[]; discovered: DiscoveredProject[]; discoveredHasMore?: boolean };
export const EMPTY_PROJECT_INDEX: ProjectIndex = { workspaces: [], discovered: [] };
const PHASES: Record<string, string> = { preparing: "准备中", running: "执行中", uploading: "回传文件", waiting: "等待处理", cancel_requested: "正在停止" };
export function projectName(project: ProjectRef) { return project.name && project.name !== "workspace" ? project.name : project.root?.split(/[\\/]/).filter(Boolean).at(-1) || "默认工作目录"; }
export function workspaceRef(workspace: Workspace): ProjectRef { return { id: workspace.id, nodeId: workspace.nodeId, nodeName: workspace.nodeName, project: workspace.project, name: workspace.name, workspaceId: workspace.id, root: workspace.root || workspace.path, controllerThreadId: workspace.controllerThreadId }; }
function projectKey(project: ProjectRef) { return `${project.nodeId}:${project.project}:${project.root?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || project.workspaceId || project.id}`; }

export function RunningProjects({ projects, nodes, onProject, onTask, onHistory }: { projects?: RunningProject[]; nodes: FleetNode[]; onProject: (project: ProjectRef, source?: "desktop" | "fleet") => void; onTask: (task: RunningProjectTask) => void; onHistory: () => void }) {
  const [query, setQuery] = useState("");
  const rows = (projects || []).filter(project => `${projectName(project)} ${project.nodeName || ""} ${project.root || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const grouped = Array.from(new Set(rows.map(project => project.nodeId))).sort((a, b) => (nodes.find(node => node.id === a)?.name || a).localeCompare(nodes.find(node => node.id === b)?.name || b, "zh-CN", { numeric: true }));
  const oldNodes = nodes.filter(node => String(node.capabilities?.version || "").startsWith("0.2."));
  return <Section title="运行中的项目" className="running-projects" action={<button className="text-button" onClick={onHistory}>项目历史<ChevronRight size={14} /></button>}>
    {!!projects?.length && <div className="running-projects-summary"><span>{projects.length} 个项目 · {projects.reduce((count, project) => count + project.total, 0)} 项执行</span>{projects.length > 6 && <div className="search-field"><Search size={15} /><input aria-label="搜索运行项目" placeholder="搜索项目或电脑" value={query} onChange={event => setQuery(event.target.value)} /></div>}</div>}
    {projects === undefined ? <div className="quiet-empty">等待同步项目运行状态</div> : !projects.length ? <div className="quiet-empty"><FolderOpen size={19} />暂无已确认运行的项目</div> : !rows.length ? <div className="quiet-empty">没有符合条件的项目</div> : <div className="running-project-list">{grouped.map(nodeId => {
      const nodeProjects = rows.filter(project => project.nodeId === nodeId);
      return <div className="running-device-group" key={nodeId}><div className="running-device-heading"><Monitor size={14} /><strong>{nodes.find(node => node.id === nodeId)?.name || nodeProjects[0].nodeName || "设备"}</strong><span>{nodeProjects.length} 个项目</span></div>{nodeProjects.map(project => <article className="running-project-row" key={project.id}>
        <div className="running-project-name"><button onClick={() => onProject(project, project.fleetCount ? "fleet" : "desktop")}><FolderOpen size={16} /><strong>{projectName(project)}</strong><ChevronRight size={14} /></button><span>{project.total} 项执行{!project.root && !project.workspaceId ? " · 目录未上报" : ""}</span></div>
        <div className="running-project-tasks">{project.currentTasks.map(task => <button key={`${task.kind}:${task.id}`} onClick={() => onTask(task)}><span className={`status status-${task.phase === "waiting" || task.phase === "cancel_requested" ? "amber" : "green"}`}>{PHASES[task.phase] || "执行中"}</span><span>{task.title || "未命名任务"}</span></button>)}{project.total > project.currentTasks.length && <button className="more-project-tasks" onClick={() => onProject(project, project.fleetCount ? "fleet" : "desktop")}>另 {project.total - project.currentTasks.length} 项 · 查看项目</button>}</div>
        <div className="running-project-activity"><p>{project.latestActivity || "等待下一条执行进展"}</p><time>{time(project.latestActivityAt || undefined)}</time></div>
      </article>)}</div>; })}</div>}
    {!!oldNodes.length && <div className="project-coverage-hint">{oldNodes.map(node => node.name).join("、")} 待升级后同步原生项目</div>}
  </Section>;
}

export function ProjectCatalog({ index, running, nodes, error, onProject }: { index: ProjectIndex; running?: RunningProject[]; nodes: FleetNode[]; error: string; onProject: (project: ProjectRef) => void }) {
  const [query, setQuery] = useState(""); const [nodeId, setNodeId] = useState(""); const [page, setPage] = useState(0);
  const collected = new Map<string, ProjectRef>();
  for (const project of index.discovered) { const item: ProjectRef = { ...project, id: `discovered:${project.nodeId}:${project.sourceThreadId}` }; collected.set(projectKey(item), item); }
  for (const workspace of index.workspaces.filter(item => item.status === "ready")) { const item = workspaceRef(workspace); collected.set(projectKey(item), item); }
  for (const project of running || []) if (!collected.has(projectKey(project))) collected.set(projectKey(project), project);
  const rows = Array.from(collected.values()).filter(project => (!nodeId || project.nodeId === nodeId) && `${projectName(project)} ${project.root || ""} ${project.nodeName || nodes.find(node => node.id === project.nodeId)?.name || ""}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => (nodes.find(node => node.id === a.nodeId)?.name || a.nodeId).localeCompare(nodes.find(node => node.id === b.nodeId)?.name || b.nodeId, "zh-CN", { numeric: true }) || projectName(a).localeCompare(projectName(b), "zh-CN"));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 30) - 1));
  return <Section title="项目历史" className="project-catalog">
    <div className="filter-bar"><div className="search-field"><Search size={17} /><input aria-label="搜索项目历史" placeholder="搜索项目、目录或电脑" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></div><select aria-label="项目所在电脑" value={nodeId} onChange={event => { setNodeId(event.target.value); setPage(0); }}><option value="">全部电脑</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></div>
    {error && <Notice>{error}</Notice>}<div className="directory-coverage">已同步 {rows.length} 个项目 · 含历史与归档任务</div>
    {rows.length ? <div className="project-catalog-list">{rows.slice(currentPage * 30, (currentPage + 1) * 30).map(project => <button className="project-catalog-row" key={projectKey(project)} onClick={() => onProject(project)}><FolderOpen size={18} /><span><strong>{projectName(project)}</strong><small>{project.root || "目录未上报，查看此电脑项目域内的任务"}</small></span><em>{nodes.find(node => node.id === project.nodeId)?.name || project.nodeName || "设备"}</em><ChevronRight size={16} /></button>)}</div> : <Empty icon={<FolderOpen size={24} />} title={query || nodeId ? "没有符合条件的项目" : "等待电脑同步项目目录"} />}
    {index.discoveredHasMore && <div className="project-coverage-hint">这里只显示已同步的部分项目；更早记录仍可在“任务”中搜索。</div>}
    {rows.length > 30 && <div className="directory-pagination"><span>第 {currentPage + 1} 页 · 每页 30 项</span><div><button className="button secondary small" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={14} />上一页</button><button className="button secondary small" disabled={(currentPage + 1) * 30 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页<ArrowRight size={14} /></button></div></div>}
  </Section>;
}

export function ProjectHistory({ project, nodes, initialSource, canWrite, revision, selectedId, onBack, onTask, onThread, onController, onCompose }: { project: ProjectRef; nodes: FleetNode[]; initialSource: "desktop" | "fleet"; canWrite: boolean; revision: number; selectedId: string; onBack: () => void; onTask: (task: FleetTask) => void; onThread: (thread: DesktopThread) => void; onController: () => void; onCompose: (seed: ComposerSeed) => void }) {
  const [source, setSource] = useState(initialSource); const [phase, setPhase] = useState<ProjectPhase>("all");
  const node = nodes.find(item => item.id === project.nodeId);
  return <><section className="project-history-heading"><button className="text-button" onClick={onBack}><ArrowLeft size={15} />项目历史</button><div><div><h2><FolderOpen size={20} />{projectName(project)}</h2><p>{node?.name || project.nodeName || "设备"}{project.root ? ` · ${project.root}` : " · 目录未上报，按此电脑的项目域查看"}</p></div><div className="project-history-actions">{project.controllerThreadId && <button className="button secondary small" onClick={onController}><FileText size={15} />总控对话</button>}{canWrite && project.workspaceId && node && <button className="button secondary small" onClick={() => onCompose({ node, project: project.project, workspaceId: project.workspaceId || undefined })}><Send size={14} />派发任务</button>}</div></div></section>
    <div className="project-history-filters"><div className="source-switcher" aria-label="项目任务来源"><button className={source === "desktop" ? "active" : ""} onClick={() => setSource("desktop")}><Monitor size={15} />电脑任务</button><button className={source === "fleet" ? "active" : ""} onClick={() => setSource("fleet")}><Send size={15} />协作任务</button></div><div className="project-phase-switcher" role="group" aria-label="项目任务阶段">{([{ value: "all", label: "全部" }, { value: "active", label: "进行中" }, { value: "completed", label: "已完成" }] as const).map(item => <button key={item.value} className={phase === item.value ? "active" : ""} aria-pressed={phase === item.value} onClick={() => setPhase(item.value)}>{item.label}</button>)}</div></div>
    {source === "desktop" ? <DesktopDirectory nodes={nodes} nodeId={project.nodeId} onNode={() => {}} canWrite={canWrite} onSelect={onThread} revision={revision} selectedId={selectedId} project={project} phase={phase} /> : <FleetTaskDirectory initialTarget={project.nodeId} nodes={nodes} onSelect={onTask} project={project} phase={phase} />}
  </>;
}
