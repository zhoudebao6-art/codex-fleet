"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, Download, FileText, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { api, bytes, errorText, taskTitle, time } from "./api";
import type { ComposerSeed, FleetFile, FleetNode } from "./types";
import { Busy, Empty, Notice } from "./ui";

type Page = { files: FleetFile[]; total: number; nextCursor: string | null };
export function FileCatalog({ nodes, revision, canWrite, canAdmin, onCompose, onReset, onTask }: { nodes: FleetNode[]; revision: string; canWrite: boolean; canAdmin: boolean; onCompose: (seed: ComposerSeed) => void; onReset: (file: FleetFile) => void; onTask: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [node, setNode] = useState(""); const [kind, setKind] = useState(""); const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([""]); const [page, setPage] = useState<Page | null>(null); const [loadedKey, setLoadedKey] = useState("");
  const [busy, setBusy] = useState(true); const [error, setError] = useState(""); const [reload, setReload] = useState(0);
  const key = new URLSearchParams({ q: query.trim(), node, kind, status, cursor: cursors.at(-1) || "", limit: "30" }).toString();
  const current = loadedKey === key ? page : null;
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError("");
    const timer = setTimeout(() => { void api<Page>(`/api/console/files/page?${key}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setPage(result); setLoadedKey(key); }
    }).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, revision, reload]);
  function change(set: (value: string) => void, value: string) { set(value); setCursors([""]); }
  function clear() { setQuery(""); setNode(""); setKind(""); setStatus(""); setCursors([""]); }
  const filtered = !!(query || node || kind || status);
  return <div className="file-catalog" aria-busy={busy}>
    <div className="file-search-tools"><div className="search-field"><Search size={17} /><input aria-label="搜索文件、任务或项目" placeholder="搜索文件、任务或项目" value={query} maxLength={300} onChange={e => change(setQuery, e.target.value)} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => change(setQuery, "")}><X size={16} /></button>}</div>
      <select aria-label="按来源电脑筛选" value={node} onChange={e => change(setNode, e.target.value)}><option value="">所有电脑</option>{[...nodes].sort((a,b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })).map(n => <option value={n.id} key={n.id}>{n.name}</option>)}</select>
      <select aria-label="按文件类型筛选" value={kind} onChange={e => change(setKind, e.target.value)}><option value="">所有类型</option><option value="document">文档</option><option value="archive">压缩包</option><option value="video">视频</option><option value="data">数据</option><option value="image">图片</option></select>
      <select aria-label="按传输状态筛选" value={status} onChange={e => change(setStatus, e.target.value)}><option value="">所有状态</option><option value="complete">已完成</option><option value="uploading">待续传</option><option value="corrupt">校验失败</option></select>
    </div>
    <div className="file-result-bar"><span role="status">{busy ? "正在检索…" : current ? `找到 ${current.total} 个文件` : "文件检索"}</span><div>{filtered && <button className="text-button" onClick={clear}>清除筛选</button>}<button className="icon-button" aria-label="刷新文件" disabled={busy} onClick={() => setReload(x => x + 1)}><RefreshCw size={16} /></button></div></div>
    {error && <Notice>{error}</Notice>}
    {!current && busy ? <div className="file-loading"><Busy>正在读取文件</Busy></div> : current && current.files.length === 0 ? <Empty icon={<FolderOpen size={28} />} title={filtered ? "没有匹配的文件" : "还没有交接文件"}>{filtered ? "调整关键词或清除筛选。" : "任务产物和上传文件会集中显示在这里。"}</Empty> : current && <div className="file-list">{current.files.map(file => {
      const complete = file.status === "complete";
      const displayName = file.name.split(/[\\/]/).pop() || file.name;
      return <article className="file-row" key={`${file.project}:${file.sha}`}><div className="file-symbol"><FileText size={21} /></div><div className="file-name"><h3 title={file.name}>{displayName}</h3><p>{file.sourceNodeName || "共享文件"} · {bytes(file.size)} · {time(file.created)}</p>{file.taskId ? <button className="file-task-link" onClick={() => onTask(file.taskId!)} title={file.taskTitle || file.taskId}>{taskTitle(file.taskTitle || file.taskId)}<ArrowUpRight size={13} /></button> : <small className="muted">{file.project === "workspace" ? "协作文件" : file.project}</small>}</div><span className={`file-state ${complete ? "complete" : ""}`}>{complete ? <><CheckCircle2 size={15} />已完成</> : file.status === "corrupt" ? "校验失败" : `${Math.round((file.offset || 0) / Math.max(file.size, 1) * 100)}% · 待续传`}</span><div className="file-actions">{file.status === "corrupt" && canAdmin && <button className="text-button danger-text" onClick={() => onReset(file)}>重置上传</button>}{complete && <a className="icon-button" aria-label={`下载 ${file.name}`} href={`/api/console/files/${file.sha}?project=${encodeURIComponent(file.project)}`} download={displayName}><Download size={18} /></a>}{complete && canWrite && <button className="button outline small" onClick={() => onCompose({ project: file.project, inputs: [file] })}>交给设备<ArrowUpRight size={16} /></button>}</div></article>;
    })}</div>}
    <div className="file-pagination"><span>第 {cursors.length} 页{current ? ` · 共 ${current.total} 个文件` : ""}</span><div><button className="button outline small" disabled={busy || cursors.length === 1} onClick={() => setCursors(x => x.slice(0, -1))}><ChevronLeft size={16} />上一页</button><button className="button outline small" disabled={busy || !current?.nextCursor} onClick={() => current?.nextCursor && setCursors(x => [...x, current.nextCursor!])}>下一页<ChevronRight size={16} /></button></div></div>
  </div>;
}
