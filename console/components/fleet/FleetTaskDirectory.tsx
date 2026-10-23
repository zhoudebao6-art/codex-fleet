"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
import { api, errorText } from "./api";
import type { FleetNode, FleetTask, ProjectPhase, ProjectRef } from "./types";
import { Busy, Notice, Section } from "./ui";
import { TaskList } from "./Views";

type TaskPage = { tasks: FleetTask[]; nextCursor?: string | null; total: number };
const EMPTY: TaskPage = { tasks: [], total: 0 };
export default function FleetTaskDirectory({ nodes, onSelect, initialTarget = "", project, phase = "all", attention, targetValue, onTargetChange, onPhaseChange }: { nodes: FleetNode[]; onSelect: (task: FleetTask) => void; initialTarget?: string; project?: ProjectRef; phase?: ProjectPhase; attention?: "action" | "confirm"; targetValue?:string; onTargetChange?:(id:string)=>void; onPhaseChange?:(phase:ProjectPhase)=>void }) {
  const [query, setQuery] = useState(""); const [search, setSearch] = useState(""); const [localTarget, setLocalTarget] = useState(initialTarget); const [status, setStatus] = useState("");
  const target=targetValue ?? localTarget; const setTarget=(value:string)=>{setLocalTarget(value);onTargetChange?.(value);};
  const [pagination, setPagination] = useState<{ key: string; cursors: string[] }>({ key: "", cursors: [""] }); const [data, setData] = useState<TaskPage>(EMPTY); const [busy, setBusy] = useState(true); const [error, setError] = useState(""); const [revision, setRevision] = useState(0);
  const [loadedKey,setLoadedKey]=useState("");
  const key = JSON.stringify([search, target, status, project?.workspaceId, project?.root, project?.project, phase, attention]); const cursors = pagination.key === key ? pagination.cursors : [""]; const cursor = cursors[cursors.length - 1];
  const requestKey = JSON.stringify([key, cursor]);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>; setBusy(true);
    const parameters = new URLSearchParams({ limit: "50" }); if (search) parameters.set("q", search); if (target) parameters.set("target", target); if (status) parameters.set("status", status); if (cursor) parameters.set("cursor", cursor);
    if (project?.workspaceId) parameters.set("workspaceId", project.workspaceId); else if (project?.root) parameters.set("cwd", project.root);
    if (attention) parameters.set("attention", attention); else parameters.set("source","collaboration");
    if (project) parameters.set("project", project.project); if (phase !== "all") parameters.set("phase", phase);
    async function load() {
      try { const value = await api<TaskPage>(`/v1/tasks/page?${parameters}`); if (alive) { setData(value); setLoadedKey(requestKey); setError(""); } }
      catch (err) { if (alive) setError(errorText(err)); }
      finally { if (alive) { setBusy(false); timer = setTimeout(load, document.hidden ? 30000 : 5000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [search, target, status, cursor, revision, project?.workspaceId, project?.root, project?.project, phase, attention]);
  function clearFilters(){setQuery("");setSearch("");setTarget("");setStatus("");onPhaseChange?.("all");}
  const hasFilters=!!(query||target||status||phase!=="all");
  const visibleData=loadedKey===requestKey ? data : EMPTY;
  return <Section title={attention === "action" ? "待处理" : attention === "confirm" ? "待确认" : "协作任务"} action={<button className="text-button" aria-label="刷新协作任务" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={busy ? "spin" : ""} />刷新</button>}>
    {!attention && onPhaseChange && <div className="source-switcher" aria-label="协作任务范围">{([["all","全部历史"],["active","执行中"],["completed","已交付"]] as const).map(([value,label])=><button key={value} className={phase===value?"active":""} onClick={()=>onPhaseChange(value)}>{label}</button>)}</div>}
    <div className="filter-bar fleet-task-filters"><div className="search-field"><Search size={17} /><input aria-label="搜索协作任务" placeholder="搜索任务名称或内容" value={query} onChange={event => setQuery(event.target.value)} maxLength={300} /></div>{!project && <select aria-label="协作任务电脑" value={target} onChange={event => setTarget(event.target.value)}><option value="">全部电脑</option>{nodes.map(node => <option value={node.id} key={node.id}>{node.name}</option>)}</select>} {!project && !attention && <select aria-label="协作任务状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option><option value="queued">待发送</option><option value="claimed">已接收</option><option value="running">执行中</option><option value="blocked">需要处理</option><option value="uncertain">待核实</option><option value="submitted">待确认结果</option><option value="accepted">已确认结果</option><option value="failed">执行失败</option><option value="cancelled">已取消</option><option value="cancel_requested">正在取消</option></select>}</div>
    <div className="directory-coverage"><span>{loadedKey===requestKey ? `共 ${visibleData.total} 项` : error ? "读取失败，可重试" : "正在读取历史记录…"}</span>{!attention && !project && hasFilters && <button className="text-button" onClick={clearFilters}>清除筛选，查看全部</button>}</div>{error && <Notice>{error}</Notice>}
    {busy && !visibleData.tasks.length ? <div className="loading-inline"><Busy>正在读取协作任务</Busy></div> : <TaskList emptyLabel={attention ? "当前没有" + (attention === "action" ? "待处理事项" : "待确认结果") : undefined} tasks={visibleData.tasks} nodes={nodes} onSelect={onSelect} history={!!project} />}
    <div className="directory-pagination"><span>第 {cursors.length} 页 · 每页 50 项</span><div><button className="button secondary small" disabled={busy || cursors.length === 1} onClick={() => setPagination({ key, cursors: cursors.slice(0, -1) })}><ArrowLeft size={14} />上一页</button><button className="button secondary small" disabled={busy || !visibleData.nextCursor} onClick={() => { if (visibleData.nextCursor) setPagination({ key, cursors: [...cursors, visibleData.nextCursor] }); }}>下一页<ArrowRight size={14} /></button></div></div>
  </Section>;
}
