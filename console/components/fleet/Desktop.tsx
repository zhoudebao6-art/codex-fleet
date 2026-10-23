"use client";
import {RuntimeBadge} from "./RuntimeStatus";
import {nodeRuntime} from "../../lib/fleet/runtime-readiness.mjs";

import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, FileText, FolderOpen, Monitor, Pin, Power, RefreshCw, Search, Send, Settings2, Wrench } from "lucide-react";
import { api, bytes, errorText, mutation, taskTitle, time } from "./api";
import { currentActivity } from "./events";
import type { ComposerSeed, DeviceGroup, FleetEvent, FleetFile, FleetNode, FleetTask, ProjectPhase, ProjectRef, AttentionStats, TaskStats } from "./types";
import { deviceCode, deviceLabel, groupDevices } from "./device-utils";
import type { DesktopActivity, DesktopPage, DesktopSummary, DesktopThread } from "./desktop-types";
import { Busy, Empty, Modal, Notice, Section, Status } from "./ui";
import CodexThreadLink from "./CodexThreadLink";
import DetailTabs from "./DetailTabs";
import MessageFeed, { type ReadingEntry } from "./MessageFeed";
import DesktopContinuation from "./DesktopContinuation";

const EMPTY_SUMMARY: DesktopSummary = { nodes: [] };
const EMPTY_PAGE: DesktopPage = { threads: [], total: 0, inventories: [] };
const ACTIVE = new Set(["running", "claimed", "cancel_requested"]);

type TaskRuntime = { taskId: string; attemptId?: string; phase: string };
const RUNTIME_PHASES: Record<string, string> = { preparing: "正在准备任务", running: "正在执行任务", uploading: "正在上传结果" };
const NATIVE_STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "正在运行", tone: "green" }, waiting: { label: "等待处理", tone: "amber" },
  failed: { label: "执行失败", tone: "red" }, completed: { label: "已完成", tone: "neutral" },
  interrupted: { label: "已中断", tone: "amber" }, recent_activity: { label: "状态确认中", tone: "neutral" },
  unknown: { label: "状态待同步", tone: "neutral" },
};
function threadTime(thread: DesktopThread) { return thread.lastActivityAt || thread.recentActivityAt || thread.updatedAt; }
function messageText(thread: DesktopThread) {
  const message = thread.latestMessage;
  return message?.text ? `${message.role === "user" ? "用户" : "Codex"}：${message.text}` : thread.messageState === "empty" ? "暂无公开对话" : "最新对话待同步";
}
function messageTime(thread: DesktopThread) {
  const at = thread.latestMessage?.at;
  return [at ? time(at) : thread.latestMessage ? "消息时间未提供" : "", thread.messageState === "syncing" ? "更新中" : ""].filter(Boolean).join(" · ");
}
function threadKey(thread: DesktopThread) { return `${thread.nodeId}:${thread.threadId}`; }
function inventoryComplete(inventory: DesktopPage["inventories"][number]) { return inventory.complete && (inventory.storedCount ?? inventory.count ?? 0) >= (inventory.count ?? 0); }
function DesktopStatus({ thread, offline = false }: { thread: DesktopThread; offline?: boolean }) {
  const value = NATIVE_STATUS[thread.status || "unknown"] || NATIVE_STATUS.unknown;
  const stale = offline || thread.statusFreshness === "stale" || thread.freshness === "stale";
  return <span className={`status status-${stale ? "neutral" : value.tone}`}>{stale && ["running", "waiting"].includes(thread.status || "") ? `最后状态：${value.label}` : value.label}</span>;
}

export function useDesktopSummary(enabled: boolean, revision: number) {
  const [data, setData] = useState<DesktopSummary>(EMPTY_SUMMARY);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const next = await api<DesktopSummary>("/v1/desktop/summary"); if (alive) { setData(next); setError(""); } }
      catch (err) { if (alive) setError(errorText(err)); }
      if (alive) timer = setTimeout(load, document.hidden ? 30000 : 10000);
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [enabled, revision]);
  return { data, error };
}

export function Workstations({ nodes, tasks, events, summary, taskStats, attentionStats, onAttentionNode, canWrite, onDevice, onTask, onThread, onCompose, onFleetNode, groups = [], onDetails }: {
  nodes: FleetNode[]; tasks: FleetTask[]; events: FleetEvent[]; summary: DesktopSummary; canWrite: boolean;
  attentionStats?: AttentionStats; onAttentionNode: (nodeId: string) => void; taskStats?: TaskStats; groups?: DeviceGroup[]; onDetails?: (nodeId: string) => void; onFleetNode: (nodeId: string) => void; onDevice: (nodeId: string) => void; onTask: (task: FleetTask) => void; onThread: (thread: DesktopThread) => void; onCompose: (seed: ComposerSeed) => void;
}) {
  const [query, setQuery] = useState(""); const [page, setPage] = useState(0); const [groupId, setGroupId] = useState("all");
  const sections = groupDevices(nodes, groups).filter(group=>group.nodes.length>0);
  const currentGroup = sections.some(group => group.id === groupId) ? groupId : "all";
  const matchingNodes = sections.filter(group => currentGroup === "all" || group.id === currentGroup).flatMap(group => group.nodes).filter(node => `${deviceLabel(node)} ${node.groupName || ""} ${node.projects?.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matchingNodes.length / 6) - 1));
  const shownNodes = matchingNodes.slice(currentPage * 6, (currentPage + 1) * 6);
  if (!nodes.length) return <Empty icon={<Monitor size={26} />} title="还没有接入的电脑" />;
  return <Section title="设备工作台" className="workstations-panel"><div className="workstations">{(nodes.length>6 || sections.length>1) && <div className="workstation-toolbar"><div className="search-field"><Search size={16} /><input aria-label="搜索电脑" placeholder="搜索名称、代号或项目" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></div><select aria-label="筛选设备业务分组" value={currentGroup} onChange={event => { setGroupId(event.target.value); setPage(0); }}><option value="all">全部分组</option>{sections.map(group => <option key={group.id || "ungrouped"} value={group.id}>{group.name}</option>)}</select><span>{matchingNodes.length} 台电脑</span><button className="icon-button" aria-label="上一页电脑" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} /></button><span>{currentPage + 1} / {Math.max(1, Math.ceil(matchingNodes.length / 6))}</span><button className="icon-button" aria-label="下一页电脑" disabled={(currentPage + 1) * 6 >= matchingNodes.length} onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} /></button></div>}<div className="workstation-table-head"><span>设备</span><span>当前工作</span><span>最近动作</span><span>状态</span><span /></div><div className="workstation-grid">{shownNodes.map((node, index) => {
    const own = summary.nodes.find(row => row.nodeId === node.id);
    const inventory = own?.inventory;
    const ownTasks = tasks.filter(task => task.target === node.id);
    const active = ownTasks.filter(task => ACTIVE.has(task.status)).sort((a, b) => Array.from(ACTIVE).indexOf(a.status) - Array.from(ACTIVE).indexOf(b.status) || new Date(b.updated || b.created || 0).getTime() - new Date(a.updated || a.created || 0).getTime());
    const runtime = node.online && Array.isArray(node.capabilities?.taskRuntime) ? (node.capabilities.taskRuntime as TaskRuntime[]).filter(item => item && typeof item.taskId === "string" && RUNTIME_PHASES[item.phase] && !ownTasks.some(task => task.id === item.taskId && (!ACTIVE.has(task.status) || task.attempt && task.attempt !== item.attemptId))) : [];
    const activeIds = node.online && Array.isArray(node.capabilities?.activeTasks) ? (node.capabilities.activeTasks as unknown[]).filter((id): id is string => typeof id === "string" && !ownTasks.some(task => task.id === id && !ACTIVE.has(task.status))) : [];
    const conversationIds=Array.isArray(node.capabilities?.activeConversations)?node.capabilities.activeConversations as string[]:[];
    const confirmedIds = [...new Set([...runtime.map(item => item.taskId), ...activeIds])].filter(id=>!conversationIds.includes(id));
    const confirmedCurrent = confirmedIds.map(id => active.find(task => task.id === id)).find(Boolean);
    const counts = taskStats?.byNode.find(row => row.nodeId === node.id)?.byStatus;
    const attentionCount = attentionStats?.byNode?.find(row=>row.nodeId===node.id)?.total || 0;
    const threads = own?.threads || [];
    const desktopCandidates = own?.latestThread ? [...threads, own.latestThread] : threads;
    const confirmedDesktop = node.online ? desktopCandidates.find(thread => thread.status === "running" && thread.statusSource === "app_server_runtime" && thread.statusFreshness === "fresh" && thread.freshness !== "stale" && !thread.archived) : undefined;
    const desktop = confirmedDesktop || own?.latestThread || threads[0];
    const idleReported = node.online && node.capabilities?.ready === true && Array.isArray(node.capabilities.activeTasks) && !node.capabilities.activeTasks.length && !runtime.length;
    const current = confirmedCurrent || (!confirmedIds.length && !confirmedDesktop && !idleReported ? active[0] : undefined);
    const hiddenActive = current ? 0 : confirmedIds.length || (!confirmedDesktop && !idleReported && counts ? Array.from(ACTIVE).reduce((sum, status) => sum + (counts[status] || 0), 0) : 0);
    const waiting = current && Array.isArray(node.capabilities?.waitingInteractions) && (node.capabilities.waitingInteractions as { taskId: string }[]).some(item => item.taskId === current.id);
    const currentRuntime = current && runtime.find(item => item.taskId === current.id);
    const activity = current ? currentActivity(events.filter(event => (event.taskId || event.task_id || event.task) === current.id && (event.sourceId || event.node) === node.id && (!current.attempt || !event.payload?.attemptId || event.payload.attemptId === current.attempt))) : null;
    const lastActivityAt = current ? activity?.event.created || current.updated || current.created : node.lastSeen || node.last_seen;
    return <Fragment key={node.id}>{(index === 0 || shownNodes[index - 1].groupId !== node.groupId) && <div className="workstation-group-heading"><FolderOpen size={13} /><span>{node.groupName || sections.find(group => group.id === node.groupId)?.name || "未分组"}</span></div>}<article className={`workstation ${node.online ? "" : "is-offline"}`}>
      <header><button onClick={() => onDevice(node.id)} className="workstation-code"><Monitor size={17} />{deviceCode(node)}</button>{node.displayName && node.displayName !== deviceCode(node) && <span className="workstation-display-name" title={node.displayName}>{node.displayName}</span>}<RuntimeBadge node={node}/></header>
      <div className="workstation-current">{current ? <button className="workstation-task" onClick={() => onTask(current)}>{taskTitle(current.spec.prompt)}</button> : hiddenActive ? <button className="workstation-task" onClick={() => onFleetNode(node.id)}>{hiddenActive} 项协作任务处理中</button> : desktop ? <button className="workstation-task" onClick={() => onThread(desktop)}>{desktop.title || "未命名任务"}</button> : <strong>{idleReported ? "协作执行器空闲" : inventory?.receivedAt ? "没有可展示的任务" : "等待同步任务目录"}</strong>}<span className="workstation-source">{current || hiddenActive ? "协作任务" : confirmedDesktop ? "电脑任务" : desktop ? "最近电脑任务" : "电脑任务"}{inventory?.receivedAt ? ` · ${inventoryComplete(inventory) ? inventory.count ?? 0 : `${inventory.storedCount ?? 0}/${inventory.count ?? 0}`} 项${inventoryComplete(inventory) ? "" : "同步中"}` : " · 目录尚未同步"}</span>{attentionCount > 0 && <button className="text-button workstation-attention" onClick={() => onAttentionNode(node.id)}>{attentionCount} 项待办</button>}{threads.some(thread => thread.pinned) && <div className="workstation-pins">{threads.filter(thread => thread.pinned).slice(0, 1).map(thread => <button key={threadKey(thread)} onClick={() => onThread(thread)}><Pin size={12} /><span>{thread.title}</span></button>)}</div>}</div>
      <div className="workstation-action">{nodeRuntime(node).reason&&<p className="workstation-readiness">{nodeRuntime(node).reason}</p>}<p>{current ? waiting ? "打开任务详情，处理这次请求" : activity?.headline || (currentRuntime ? RUNTIME_PHASES[currentRuntime.phase] : node.online ? "等待执行进展回报" : "等待设备恢复连接") : hiddenActive ? "打开协作任务查看最新进展" : desktop ? messageText(desktop) : inventory?.error ? "目录同步需要处理" : idleReported ? "当前没有正在执行的协作任务" : node.online ? "等待节点回报" : "电脑上线后更新"}</p><time>{!current && !hiddenActive && desktop ? messageTime(desktop) : time(lastActivityAt)}</time></div>
      <div className="workstation-state">{waiting ? <span className="status status-amber"><i />等待你回复</span> : current ? !node.online ? <span className="status status-neutral">执行状态待确认</span> : currentRuntime && current.status !== "cancel_requested" ? <span className="status status-green">{RUNTIME_PHASES[currentRuntime.phase]}</span> : <Status value={current.status} /> : hiddenActive ? <span className="status status-amber">待查看进展</span> : desktop ? <DesktopStatus thread={desktop} offline={!node.online} /> : <span className="status status-neutral">{idleReported ? "协作空闲" : "等待同步"}</span>}<span className="workstation-version" title={inventory?.error || ""}>节点 {String(node.capabilities?.version || "未知")}{String(node.capabilities?.version || "").startsWith("0.2.") ? " · 待升级" : inventory?.error ? " · 同步受阻" : inventory && inventoryComplete(inventory) ? " · 已同步" : " · 同步中"}</span></div>
      <footer><button className="text-button workstation-open" onClick={()=>onDevice(node.id)}>查看任务</button>{canWrite&&!node.online&&onDetails&&<button className="text-button" onClick={()=>onDetails(node.id)} aria-label={`唤醒 ${deviceCode(node)}`}><Power size={15}/>唤醒</button>}{canWrite && <button className="icon-button" aria-label={`向 ${node.name} 派任务`} title={nodeRuntime(node).canConverse?"新建对话":nodeRuntime(node).reason||"等待连接"} disabled={!nodeRuntime(node).canConverse} onClick={() => onCompose({ node })}><Send size={16} /><span className="mobile-action-label">新对话</span></button>}<button className="icon-button" aria-label={`${deviceCode(node)} ${onDetails ? "设备资料" : "全部任务"}`} title={onDetails ? "设备资料" : "全部任务"} onClick={() => onDetails ? onDetails(node.id) : onDevice(node.id)}>{onDetails ? <Settings2 size={16} /> : <ChevronRight size={17} />}</button></footer>
    </article></Fragment>;
  })}</div>{!matchingNodes.length && <div className="quiet-empty">没有找到这台电脑</div>}</div></Section>;
}

export function DesktopDirectory({ nodes, nodeId, onNode, canWrite, onSelect, revision, compact = false, onAll, selectedId = "", project, phase = "all" }: { nodes: FleetNode[]; nodeId: string; onNode: (id: string) => void; canWrite: boolean; onSelect: (thread: DesktopThread) => void; revision: number; compact?: boolean; onAll?: () => void; selectedId?: string; project?: ProjectRef; phase?: ProjectPhase }) {
  const [query, setQuery] = useState(""); const [debounced, setDebounced] = useState(""); const [archived, setArchived] = useState("all"); const [onlyPinned, setOnlyPinned] = useState(false);
  const [pagination, setPagination] = useState<{ key: string; cursors: string[] }>({ key: "", cursors: [""] }); const [page, setPage] = useState<DesktopPage>(EMPTY_PAGE);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(""); const [reload, setReload] = useState(0);
  const [loadedKey,setLoadedKey]=useState("");
  const filterKey = JSON.stringify([nodeId, debounced, archived, onlyPinned, project?.workspaceId, project?.root, project?.project, phase]);
  const cursors = pagination.key === filterKey ? pagination.cursors : [""];
  const cursor = cursors[cursors.length - 1];
  const requestKey = JSON.stringify([filterKey, cursor, compact]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const parameters = new URLSearchParams({ limit: compact ? "6" : "30", archived,source:"conversations" });
    if (nodeId) parameters.set("nodeId", nodeId); if (debounced) parameters.set("q", debounced); if (cursor) parameters.set("cursor", cursor); if (onlyPinned) parameters.set("pinned", "true");
    if (project?.workspaceId) parameters.set("workspaceId", project.workspaceId); else if (project?.root) parameters.set("cwd", project.root);
    if (project) parameters.set("project", project.project); if (phase !== "all") parameters.set("phase", phase);
    setBusy(true);
    async function load() {
      try { const next = await api<DesktopPage>(`/v1/desktop/threads?${parameters}`); if (alive) { setPage(next); setLoadedKey(requestKey); setError(""); } }
      catch (err) { if (alive) setError(errorText(err)); }
      finally { if (alive) { setBusy(false); timer = setTimeout(load, document.hidden ? 30000 : 10000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [nodeId, debounced, archived, onlyPinned, cursor, reload, revision, compact, project?.workspaceId, project?.root, project?.project, phase]);
  const visiblePage=loadedKey===requestKey ? page : EMPTY_PAGE;
  const inventories = visiblePage.inventories.filter(inventory => !nodeId || inventory.nodeId === nodeId);
  const node = nodes.find(item => item.id === nodeId);
  return <Section title={node ? `${node.name} · 电脑任务` : compact ? "最近任务" : "所有电脑的任务"} className={`desktop-directory ${compact ? "compact-directory" : ""}`} action={compact && onAll ? <button className="text-button" onClick={onAll}>查看全部<ChevronRight size={15}/></button> : <button className="text-button" onClick={() => setReload(value => value + 1)} aria-label="刷新电脑任务"><RefreshCw size={15} className={busy ? "spin" : ""} />刷新</button>}>
    {!compact && !project && <div className="device-switcher" aria-label="选择电脑"><button className={!nodeId ? "active" : ""} onClick={() => onNode("")}>全部电脑</button>{nodes.map(item => <button key={item.id} className={nodeId === item.id ? "active" : ""} onClick={() => onNode(item.id)}><i className={item.online ? "online-dot" : ""} />{item.name}</button>)}</div>}
    {!compact && <div className="filter-bar desktop-filters">{compact && <select aria-label="选择电脑" value={nodeId} onChange={event => onNode(event.target.value)}><option value="">全部电脑</option>{nodes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<div className="search-field"><Search size={17} /><input aria-label="搜索电脑任务" placeholder="搜索任务名称、内容或项目" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="任务归档筛选" value={archived} onChange={event => setArchived(event.target.value)}><option value="all">全部（含归档）</option><option value="false">未归档</option><option value="true">已归档</option></select><button className={`pin-filter ${onlyPinned ? "active" : ""}`} aria-pressed={onlyPinned} onClick={() => setOnlyPinned(value => !value)}><Pin size={15} />主要任务</button></div>}
    {!compact && <div className="directory-coverage"><span>{visiblePage.total} 项{onlyPinned ? "主要任务" : "电脑任务"}</span>{inventories.length ? inventories.map(inventory => <span key={inventory.nodeId} className={inventory.error || !inventoryComplete(inventory) ? "coverage-pending" : ""}>{nodes.find(item => item.id === inventory.nodeId)?.name || inventory.nodeName || "设备"} · {inventory.error ? "同步受阻" : !inventory.receivedAt ? "等待同步" : inventoryComplete(inventory) ? "目录已同步" : `同步中 ${inventory.storedCount ?? 0}/${inventory.count ?? 0}`} · {time(inventory.receivedAt)}</span>) : <span>等待节点同步目录</span>}</div>}
    {error && <Notice>{error}</Notice>}
    {compact && <div className="native-table-head"><span /><span>任务名称</span><span>电脑</span><span>来源</span><span>最新更新</span><span>状态</span><span /></div>}
    {busy && !visiblePage.threads.length ? <div className="loading-inline"><Busy>正在读取任务目录</Busy></div> : visiblePage.threads.length ? <div className="desktop-thread-list">{visiblePage.threads.map(thread => {
      const target = nodes.find(item => item.id === thread.nodeId);
      if (compact) return <button key={threadKey(thread)} className={`desktop-thread-row compact-native-row ${selectedId === threadKey(thread) ? "is-selected" : ""}`} aria-pressed={selectedId === threadKey(thread)} onClick={() => onSelect(thread)}><span className="native-icon">{thread.pinned ? <Pin size={15} /> : <FileText size={15} />}</span><div className="native-title"><strong>{thread.title || "未命名任务"}</strong>{thread.archived && <small>已归档</small>}<p className="native-message">{messageText(thread)}</p></div><span className="native-device">{target?.name || thread.nodeName || "设备"}</span><span className="native-source">{"桌面对话"}</span><time className="native-updated">{messageTime(thread)}</time><DesktopStatus thread={thread} offline={!target?.online} /><ChevronRight size={15} /></button>;
      return <button key={threadKey(thread)} className={`desktop-thread-row ${selectedId === threadKey(thread) ? "is-selected" : ""}`} aria-pressed={selectedId === threadKey(thread)} onClick={() => onSelect(thread)}><div className="desktop-thread-icon">{thread.pinned ? <Pin size={17} /> : <FileText size={17} />}</div><div className="desktop-thread-main"><strong>{thread.title || "未命名任务"}</strong><p>{messageText(thread)}</p><div className="thread-meta"><span>{target?.name || thread.nodeName || "设备"}</span><span>{thread.fleetTaskId ? "协作会话" : "电脑会话"}</span>{thread.project && thread.project !== "workspace" && <span>{thread.project}</span>}{thread.archived && <span>已归档</span>}<time>{messageTime(thread)}</time></div></div><DesktopStatus thread={thread} offline={!target?.online} /><ChevronRight size={17} /></button>;
    })}</div> : <Empty icon={<FileText size={27} />} title={debounced || onlyPinned || project || phase !== "all" ? "没有符合条件的任务" : "尚未同步到任务"}>{project ? "可切换任务阶段，或查看另一种任务来源。" : onlyPinned && canWrite ? "打开任务后，点“设为主要任务”。" : node?.online === false ? "电脑上线后继续同步。" : "同步后可查看各台电脑的任务和公开进展。"}</Empty>}
    {!compact && <div className="directory-pagination"><span>第 {cursors.length} 页 · 每页 {compact ? 6 : 30} 项</span><div><button className="button secondary small" disabled={busy || cursors.length === 1} onClick={() => setPagination({ key: filterKey, cursors: cursors.slice(0, -1) })}><ArrowLeft size={14} />上一页</button><button className="button secondary small" disabled={busy || !visiblePage.nextCursor} onClick={() => { if (visiblePage.nextCursor) setPagination({ key: filterKey, cursors: [...cursors, visiblePage.nextCursor] }); }}>下一页<ArrowRight size={14} /></button></div></div>}
  </Section>;
}

const TOOL_NAMES: Record<string, string> = { commandExecution: "执行命令", fileChange: "修改文件", mcpToolCall: "调用工具", webSearch: "搜索网页", imageView: "查看图片", imageGeneration: "生成图片" };
function toolActivityLabel(activity: DesktopActivity) {
  const label = TOOL_NAMES[activity.toolType || ""] || "调用工具";
  const state = activity.status === "running" || activity.status === "inProgress" ? "进行中" : ["failed", "error"].includes(activity.status || "") ? "失败" : activity.status === "completed" || activity.status === "complete" ? "完成" : activity.status || "最近记录";
  return `${label} · ${state}`;
}
export function DesktopThreadDetail({ initial, nodes, canWrite, localNodeId, onClose, onChanged, onFleetTask }: { initial: DesktopThread; nodes: FleetNode[]; canWrite: boolean; localNodeId?: string; onClose: () => void; onChanged: () => void; onFleetTask: (id: string) => void }) {
  const [thread, setThread] = useState(initial); const [error, setError] = useState(""); const [syncError, setSyncError] = useState(""); const [pinning, setPinning] = useState(false); const [loaded, setLoaded] = useState(false); const [reload, setReload] = useState(0);
  const [detailTab,setDetailTab] = useState("chat");
  const [messageFollow, setMessageFollow] = useState(0); const followNextRead = useRef(false);
  const [refreshingDetail, setRefreshingDetail] = useState(false); const refreshLock = useRef(false);
  const node = nodes.find(item => item.id === initial.nodeId);
  const endpoint = `/v1/desktop/threads/${encodeURIComponent(initial.nodeId)}/${encodeURIComponent(initial.threadId)}`;
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const value = await api<DesktopThread>(endpoint); if (alive) { setThread(value); setLoaded(true); setSyncError(""); if (followNextRead.current) { followNextRead.current = false; setMessageFollow(count => count + 1); } } }
      catch (err) { if (alive) setSyncError(errorText(err)); }
      if (alive) timer = setTimeout(load, document.hidden ? 30000 : 5000);
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [endpoint, reload]);
  async function pin() {
    setPinning(true); setError("");
    try { await mutation(`${endpoint}/pin`, { pinned: !thread.pinned }); setThread(previous => ({ ...previous, pinned: !previous.pinned })); onChanged(); }
    catch (err) { setError(errorText(err)); } finally { setPinning(false); }
  }
  async function refreshDetail() {
    if (refreshLock.current) return;
    refreshLock.current = true; setRefreshingDetail(true); setError("");
    try { const value = await mutation<DesktopThread>(`${endpoint}/refresh`, {}); setThread(value); setLoaded(true); }
    catch (err) { setError(errorText(err)); }
    finally { refreshLock.current = false; setRefreshingDetail(false); }
    setReload(value => value + 1);
  }
  const activities = thread.activities || [];
  const publicMessages = activities.filter(activity => ["user_message", "assistant_message"].includes(activity.type) && activity.text);
  const messages = thread.messages?.length ? thread.messages.map(message => ({ id: message.id || `${message.role}:${message.at || ""}:${message.text}`, type: message.role === "user" ? "user_message" : "assistant_message", text: message.text, at: message.at })) : publicMessages.length ? publicMessages : [{ id: "latest-user", type: "user_message", text: thread.latestUserMessage }, { id: "latest-assistant", type: "assistant_message", text: thread.latestAssistantMessage }].filter(message => message.text);
  const tools = activities.filter(activity => activity.type === "tool_activity");
  const readingEntries: ReadingEntry[] = [
    ...messages.map((message, index) => ({ id: message.id || `message-${index}`, role: message.type === "user_message" ? "user" as const : "assistant" as const, actor: node?.name || thread.nodeName || "设备", text: message.text || "", at: "at" in message ? message.at : undefined })),
    ...tools.map((activity, index) => ({ id: activity.id || `tool-${index}`, role: "tool" as const, actor: node?.name || thread.nodeName || "设备", label: toolActivityLabel(activity), text: activity.tool || activity.toolType || "", at: activity.at })),
  ].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  return <Modal title="电脑任务" wide inspector onClose={onClose} busy={pinning}><div className="detail-body desktop-detail">
    {syncError && <Notice>{syncError}</Notice>}{error && <Notice>{error}</Notice>}
    <div className="task-location"><div><Monitor size={22} /><strong>{node?.name || thread.nodeName || "设备"}</strong><RuntimeBadge node={node}/></div><DesktopStatus thread={thread} offline={!node?.online} /></div>
    <div className="desktop-title"><h3 title={thread.title}>{thread.title || "未命名任务"}</h3><button className="icon-button" aria-label="更新进展" title="更新进展" disabled={refreshingDetail || thread.detailPending} onClick={() => void refreshDetail()}><RefreshCw size={17} className={refreshingDetail ? "spin" : ""}/></button></div>
    <div className="conversation-observation"><span>状态依据：{thread.statusSource==="persisted_turn"?"已保存的执行结果":thread.statusSource==="app_server_runtime"&&thread.statusFreshness==="fresh"?"设备实时回报":"等待重新核实"}</span><span>内容同步 {time(thread.detailReceivedAt||thread.receivedAt)}</span></div>
    {thread.detailPending && <div className="desktop-read-state" role="status"><RefreshCw size={15} className={node?.online ? "spin" : ""} />{node?.online ? "正在读取这台电脑的最新进展" : "已请求更新，等待电脑上线"}</div>}
    {thread.status === "recent_activity" && <p className="quiet-hint">显示最近公开活动，当前是否仍在执行待设备确认。</p>}

    <DetailTabs value={detailTab} onChange={setDetailTab} items={[{id:"chat",label:"聊天记录",count:messages.length},{id:"info",label:"会话信息"}]} />
    <div className="detail-tab-panel" hidden={detailTab!=="chat"}>
    <section className="detail-section"><MessageFeed entries={readingEntries} followSignal={messageFollow} emptyText={!loaded || thread.detailPending ? "等待这台电脑返回会话内容…" : "尚无可读取的公开消息。"} /></section>
    <DesktopContinuation thread={thread} node={node} canWrite={canWrite} onTask={onFleetTask} onContinued={() => { followNextRead.current = true; setReload(value => value + 1); onChanged(); }} />
    </div>
    <div className="detail-tab-panel" hidden={detailTab!=="info"}>
    {canWrite && <button className={`button small ${thread.pinned ? "primary" : "secondary"}`} disabled={pinning} onClick={() => void pin()}>{pinning ? <Busy /> : <><Pin size={15} />{thread.pinned ? "已设为主要任务" : "设为主要任务"}</>}</button>}
    <div className="thread-meta"><span>{thread.archived ? "已归档" : "未归档"}</span><span>最近活动 {time(threadTime(thread))}</span><span>内容更新 {time(thread.detailUpdatedAt || thread.receivedAt)}</span></div>
    <CodexThreadLink localNodeId={localNodeId} nodeId={thread.nodeId} threadId={thread.threadId} deviceName={node?.code || node?.name || thread.nodeName} />
    {(thread.cwd || thread.workspace) && <details className="detail-disclosure"><summary><FolderOpen size={14} />工作目录</summary><code className="workspace-path">{thread.cwd || thread.workspace}</code></details>}
    <dl className="detail-facts"><div><dt>会话编号</dt><dd>{thread.threadId}</dd></div></dl>
    </div>
  </div></Modal>;
}

export function TransferOverview({ files, tasks, nodes, events, onTask, onFiles }: { files: FleetFile[]; tasks: FleetTask[]; nodes: FleetNode[]; events: FleetEvent[]; onTask: (task: FleetTask) => void; onFiles: () => void }) {
  const activeTasks = tasks.filter(task => (task.spec.inputs || task.inputs || []).length && ["queued", "claimed", "running", "blocked", "uncertain"].includes(task.status));
  const flows = activeTasks.slice(0, 4);
  const uploads = files.filter(file => file.status !== "complete").slice(0, 2);
  const nodeTransfers = nodes.flatMap(node => Array.isArray(node.capabilities?.transfers) ? (node.capabilities.transfers as { id: string; name: string; size: number; bytes: number; status: string; sourceNode?: string; targetNode?: string; error?: string }[]).filter(transfer => transfer.status !== "complete").map(transfer => ({ ...transfer, node })) : []).slice(0, 6);
  if (!flows.length && !uploads.length && !nodeTransfers.length) return null;
  return <Section title="文件传输" action={<button className="text-button" onClick={onFiles}>全部文件<ChevronRight size={15} /></button>}>
    {!flows.length && !uploads.length && !nodeTransfers.length ? <div className="quiet-empty">暂无文件传输</div> : <div className="transfer-overview">{nodeTransfers.map(transfer => <div className="transfer-item" key={`${transfer.node.id}:${transfer.id}`}><div className="transfer-direction"><span>{transfer.node.name}<ArrowRight size={13} />{nodes.find(node => node.id === transfer.targetNode)?.name || "协作台"}</span><span>{!transfer.node.online ? "离线 · 等待恢复" : transfer.error ? "等待重试" : transfer.status === "queued" ? "已排队" : `${Math.round((transfer.bytes || 0) / Math.max(transfer.size, 1) * 100)}%`}</span></div><strong><FileText size={15} />{transfer.name}</strong><progress value={transfer.bytes || 0} max={transfer.size || 1} /><small>{bytes(transfer.bytes || 0)} / {bytes(transfer.size)}{transfer.error ? " · 连接恢复后继续" : ""}</small></div>)}{uploads.map(file => <div className="transfer-item" key={`${file.project}:${file.sha}`}><div className="transfer-direction"><span>上传到协作台</span><span>{file.status === "corrupt" ? "校验失败" : `${Math.round((file.offset || 0) / Math.max(file.size, 1) * 100)}%`}</span></div><strong>{file.name}</strong><progress max={file.size || 1} value={file.offset || 0} /><small>{bytes(file.offset || 0)} / {bytes(file.size)}</small></div>)}{flows.map(task => {
      const inputs = task.inputs || task.spec.inputs || [];
      const matching = events.filter(event => (event.taskId || event.task_id || event.task) === task.id && ["input_transfer", "input_read_receipt"].includes(String(event.payload?.kind))).sort((a, b) => b.seq - a.seq);
      const latest = matching[0]?.payload; const received = latest?.kind === "input_read_receipt" || latest?.stage === "context_attached" || latest?.stage === "checksummed";
      const progress = typeof latest?.bytes === "number" && typeof latest?.size === "number" ? Math.min(100, Math.round(latest.bytes / Math.max(latest.size, 1) * 100)) : null;
      const source = nodes.find(node => node.id === task.creator)?.name || "协作台"; const target = nodes.find(node => node.id === task.target)?.name || "设备";
      return <button className="transfer-item transfer-button" key={task.id} onClick={() => onTask(task)}><div className="transfer-direction"><span>{source}<ArrowRight size={13} />{target}</span><span>{latest?.kind === "input_read_receipt" ? "已报告读取" : latest?.stage === "context_attached" ? "已交给 Codex" : latest?.stage === "checksummed" ? "文件校验通过" : latest?.stage === "retrying" ? "等待续传" : progress === 100 ? "已接收，待校验" : progress !== null ? `${progress}%` : task.status === "queued" ? "等待接收" : "查看记录"}</span></div><strong><FileText size={15} />{typeof latest?.name === "string" ? latest.name : inputs[0]?.name}{inputs.length > 1 ? ` · 共 ${inputs.length} 个文件` : ""}</strong>{progress !== null && !received && <progress value={progress} max={100} />}<small>{received ? <CheckCircle2 size={12} /> : null}{taskTitle(task.spec.prompt)}</small></button>;
    })}</div>}
  </Section>;
}
