"use client";
import {nodeRuntime} from "../../lib/fleet/runtime-readiness.mjs";
import ConversationLaunch from "./ConversationLaunch";

import { useEffect, useState } from "react";
import { PackageCheck, Clock3, MoreHorizontal, Trash2, WifiOff, Activity, FileText, FolderOpen, House, Monitor, PanelRightOpen, Play, Plus, RefreshCw, Send, Users, Workflow } from "lucide-react";
import { api, errorText, time, resetReadBackoff } from "./api";
import type { ComposerSeed, FleetTask, ProjectRef, RunningProjectTask, Tab } from "./types";
import { useFleet } from "./useFleet";
import { Modal, Notice, Section, ViewAll } from "./ui";
import { AccessScreen, FilesView, NodeList, TaskList, Timeline } from "./Views";
import Members, { ROLES } from "./Members";
import TaskComposer, {type TaskDraft} from "./TaskComposer";
import TaskDetail from "./TaskDetail";
import Accounts from "./Accounts";
import { DesktopDirectory, DesktopThreadDetail, TransferOverview, Workstations, useDesktopSummary } from "./Desktop";
import type { DesktopThread } from "./desktop-types";
import Automations from "./Automations";
import DeliveryCenter from "./DeliveryCenter";
import FleetTaskDirectory from "./FleetTaskDirectory";
import CleanupHistory from "./CleanupHistory";

import { EMPTY_PROJECT_INDEX, ProjectCatalog, ProjectHistory, RunningProjects, workspaceRef } from "./Projects";
import type { ProjectIndex } from "./Projects";
import { DeviceDetails, DeviceGroupsManager, useDeviceGroups } from "./DeviceManagement";
import DeviceInvite from "./DeviceInvite";
import DeviceInvitations from "./DeviceInvitations";
import { deviceCode, deviceLabel, groupDevices } from "./device-utils";

const NAV = [{ key: "home" as Tab, label: "工作台", Icon: House }, { key: "attention" as Tab, label: "待办", Icon: Clock3 }, { key: "devices" as Tab, label: "设备", Icon: Monitor }, { key: "tasks" as Tab, label: "任务", Icon: FileText }, { key: "projects" as Tab, label: "项目", Icon: FolderOpen }, { key: "deliveries" as Tab, label: "自动交付", Icon: PackageCheck }, { key: "automations" as Tab, label: "流程", Icon: Workflow }, { key: "files" as Tab, label: "文件", Icon: FolderOpen }, { key: "members" as Tab, label: "成员", Icon: Users }];

export default function FleetConsole() {
  const fleet = useFleet();
  if (fleet.loading || fleet.access !== "ready" || !fleet.user) return <AccessScreen loading={fleet.loading} access={fleet.access} error={fleet.error} />;
  return <FleetWorkspace key={fleet.sessionScope} fleet={fleet} />;
}

function FleetWorkspace({ fleet }: { fleet: ReturnType<typeof useFleet> }) {
  const { user, loading, access, data, error, lastSync, refresh, networkOnline } = fleet;
  const [tab, setTab] = useState<Tab>("home");
  const [taskDraft,setTaskDraft]=useState<TaskDraft|null>(null);
  const [moreOpen,setMoreOpen]=useState(false); const [cleanupOpen,setCleanupOpen]=useState(false);
  useEffect(()=>{const update=()=>{const next=window.location.hash.slice(1);if(NAV.some(n=>n.key===next))setTab(next as Tab);};update();window.addEventListener("hashchange",update);return()=>window.removeEventListener("hashchange",update);},[]); const [composer, setComposer] = useState<ComposerSeed | null>(null); const [selected, setSelected] = useState<FleetTask | null>(null);
  const [invite, setInvite] = useState(false); const [inviteRecords, setInviteRecords] = useState(false); const [allEvents, setAllEvents] = useState(false); const [toast, setToast] = useState(""); const [actionError, setActionError] = useState(""); const [refreshing, setRefreshing] = useState(false);
  const [deviceFilter, setDeviceFilter] = useState(""); const [taskSource, setTaskSource] = useState<"desktop" | "fleet">("desktop"); const [desktopThread, setDesktopThread] = useState<DesktopThread | null>(null); const [desktopRevision, setDesktopRevision] = useState(0);
  const [projectIndex, setProjectIndex] = useState<ProjectIndex>(EMPTY_PROJECT_INDEX); const [projectsError, setProjectsError] = useState("");
  const [selectedProject, setSelectedProject] = useState<ProjectRef | null>(null); const [projectSource, setProjectSource] = useState<"desktop" | "fleet">("desktop");
  const projects = projectIndex.workspaces;
  const [fleetFilter, setFleetFilter] = useState("");
  const [attentionTarget, setAttentionTarget] = useState("");
  const [attentionCategory, setAttentionCategory] = useState<"action" | "confirm">("action");
  const [fleetPhase,setFleetPhase] = useState<"all" | "active" | "completed">("all");
  const [groupsOpen, setGroupsOpen] = useState(false); const [detailsNodeId, setDetailsNodeId] = useState(""); const [groupsRevision, setGroupsRevision] = useState(0);
  const deviceGroups = useDeviceGroups(access === "ready" && !!user, groupsRevision + desktopRevision);
  useEffect(() => {
    if (access !== "ready" || !user) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() { try { const value = await api<ProjectIndex>("/v1/workspaces"); if (alive) { setProjectIndex({ ...EMPTY_PROJECT_INDEX, ...value }); setProjectsError(""); } } catch (err) { if (alive) setProjectsError(errorText(err)); } finally { if (alive) timer = setTimeout(load, 30000); } }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [access, user?.id, desktopRevision]);
  const desktop = useDesktopSummary(access === "ready" && !!user, desktopRevision);
  const canWrite = !!user && user.role !== "viewer";
  const activeNodes = data.nodes.filter(n => !n.revoked).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })); const online = activeNodes.filter(n => n.online).length;
  const sidebarGroups = groupDevices(activeNodes, deviceGroups.groups); const detailsNode = data.nodes.find(node => node.id === detailsNodeId);
  const nextCode = `PC-${String(Math.max(0, ...data.nodes.map(node => Number(node.name.match(/^PC-(\d+)$/i)?.[1] || 0))) + 1).padStart(2, "0")}`;
  const running = data.runningProjects?.reduce((count,project)=>count+project.total,0);
  const pending = data.attentionStats?.total || 0;
  const runningWorkspaceIds=new Set(data.runningProjects?.map(p=>p.workspaceId));
  const sidebarProjectPriority=(p:typeof projects[number])=>selectedProject?.workspaceId===p.id ? 3 : runningWorkspaceIds.has(p.id) ? 2 : p.controllerThreadId ? 1 : 0;
  const sidebarProjects=projects.filter(p=>p.status==="ready").sort((a,b)=>sidebarProjectPriority(b)-sidebarProjectPriority(a)).slice(0,8);
  const attentionNode = user?.kind === "device" ? user.nodeId || "" : attentionTarget;
  const attentionCounts = attentionNode ? data.attentionStats?.byNode?.find(n=>n.nodeId===attentionNode) : data.attentionStats;
  const reading = !!selected || !!desktopThread;
  const showInspector = reading;
  const selectedThreadId = desktopThread ? `${desktopThread.nodeId}:${desktopThread.threadId}` : "";
  function openTask(task: FleetTask) { setDesktopThread(null); setSelected(task); }
  function openThread(thread: DesktopThread) { setSelected(null); setDesktopThread(thread); }
  function navigate(next: Tab) { setTab(next); setMoreOpen(false); setSelected(null); setDesktopThread(null); if(next!=="project" && window.location.hash!==`#${next}`) window.location.hash=next; window.scrollTo({ top: 0, behavior: "instant" }); }
  function openAttention(nodeId="") { setAttentionTarget(nodeId); const count=nodeId ? data.attentionStats?.byNode?.find(n=>n.nodeId===nodeId) : data.attentionStats; setAttentionCategory(count?.action ? "action" : "confirm"); navigate("attention"); }
  function openAllTasks(){setFleetPhase("all");setFleetFilter("");navigate("tasks");}
  function openDevice(nodeId: string) { setDeviceFilter(nodeId); setTaskSource("desktop"); navigate("tasks"); }
  function openFleetTasks(nodeId = "", phase: "all" | "active" = "all") { setFleetPhase(phase); setFleetFilter(nodeId); setTaskSource("fleet"); navigate("tasks"); }
  function openProject(project: ProjectRef, source: "desktop" | "fleet" = "desktop") {
    const registered = project.workspaceId ? projects.find(workspace => workspace.id === project.workspaceId) : null;
    setSelectedProject(registered ? { ...workspaceRef(registered), ...project, controllerThreadId: project.controllerThreadId || registered.controllerThreadId } : project); setProjectSource(source); setSelected(null); setDesktopThread(null); navigate("project");
  }
  async function readDesktop(nodeId: string, threadId: string) {
    try { openThread(await api<DesktopThread>(`/v1/desktop/threads/${encodeURIComponent(nodeId)}/${encodeURIComponent(threadId)}`)); } catch (err) { setActionError(errorText(err)); }
  }
  function openRunningTask(task: RunningProjectTask) {
    if (task.kind === "fleet") void selectTask(task.taskId || task.id);
    else void readDesktop(task.nodeId, task.threadId || task.id);
  }
  function compose(seed: ComposerSeed = {}) { setSelected(null); setDesktopThread(null); setComposer(seed); setActionError(""); }
  async function selectTask(id: string) {
    const existing = data.tasks.find(task => task.id === id);
    if (existing) openTask(existing);
    else { try { openTask(await api<FleetTask>(`/v1/tasks/${encodeURIComponent(id)}`)); } catch (err) { setActionError(errorText(err)); } }
    setAllEvents(false);
  }
  async function reload() { resetReadBackoff(); setRefreshing(true); setDesktopRevision(value => value + 1); try { await refresh(); } finally { setRefreshing(false); } }
  function created(task: FleetTask) { setTaskDraft(null); setComposer(null); setToast(task.spec.intent==="conversation"?"正在创建桌面对话。":"协作任务已派发。"); setSelected(task); void refresh(); }
  function changedDevices() { setGroupsRevision(value => value + 1); void refresh(); }
  if (loading || access !== "ready" || !user) return <AccessScreen loading={loading} access={access} error={error} />;

  return <div className={`fleet-shell pro-shell ${showInspector ? "with-inspector" : ""}`}>
    <header className="app-header"><button className="wordmark" onClick={() => navigate("home")} aria-label="协作台首页"><Monitor size={24} /><span className="brand-lines">协作台<small>Codex Fleet</small></span></button><div className="workspace-topbar"><h1>{tab === "projects" ? "项目" : tab === "project" ? "项目任务" : NAV.find(n => n.key === tab)?.label}</h1><div className="toolbar-actions"><button className={`text-button toolbar-sync ${error || !networkOnline ? "sync-delayed" : ""}`} aria-label="同步设备状态" disabled={refreshing} onClick={() => void reload()}><RefreshCw size={15} className={refreshing ? "spin" : ""} /><span>{!networkOnline ? "已离线" : error ? "同步延迟" : lastSync ? `已同步 ${new Date(lastSync).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "正在同步"}</span></button>{canWrite && tab !== "members" && tab !== "automations" && tab !== "deliveries" && <button className="button primary dispatch-main" onClick={() => compose()} disabled={!activeNodes.length}><Plus size={17} />{taskDraft?.prompt ? "继续草稿" : "新建对话"}</button>}</div></div></header>
    <aside className="sidebar"><nav aria-label="主导航">{NAV.map(({ key, label, Icon }) => <button key={key} className={tab === key ? "active" : ""} onClick={() => key === "attention" ? openAttention() : key === "tasks" ? openAllTasks() : navigate(key)} aria-current={tab === key ? "page" : undefined}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{key === "attention" && pending > 0 && <span className="nav-count">{pending}</span>}</button>)}</nav><div className="sidebar-devices"><div className="sidebar-caption"><span>设备</span>{user.role === "admin" && <button className="icon-button" aria-label="添加电脑" onClick={() => setInvite(true)}><Plus size={15} /></button>}</div><div className="sidebar-device-list">{sidebarGroups.map(group => <div className="sidebar-device-group" key={group.id || "ungrouped"}><div className="sidebar-group-name"><span>{group.name}</span><small>{group.nodes.length}</small></div>{group.nodes.map(node => <button key={node.id} title={`${deviceLabel(node)} · ${nodeRuntime(node).label}${nodeRuntime(node).reason?" · "+nodeRuntime(node).reason:""}`} className={deviceFilter === node.id ? "active" : ""} onClick={() => openDevice(node.id)}><Monitor size={14} /><span className="sidebar-node-label"><strong>{node.displayName || deviceCode(node)}</strong>{node.displayName && node.displayName !== deviceCode(node) && <small>{deviceCode(node)}</small>}</span><i className={nodeRuntime(node).state==="ready" ? "online" : node.online ? "runtime-dot-warning" : ""} /></button>)}</div>)}</div></div><div className="sidebar-projects"><div className="sidebar-caption"><span>项目</span><button className="text-button" onClick={() => navigate("projects")}>全部 {projects.length}</button></div>{sidebarProjects.map(project => <button key={project.id} title={`${project.nodeName || "设备"} · ${project.root || project.name}`} onClick={() => openProject(workspaceRef(project))}><FolderOpen size={14} /><span>{project.name === "workspace" ? "默认工作目录" : project.name}</span></button>)}</div><div className="sidebar-utilities"><button className="text-button" onClick={()=>setAllEvents(true)}><Activity size={15}/>协作动态</button>{user.role==='admin'&&<button className="text-button" onClick={()=>setCleanupOpen(true)}><Trash2 size={15}/>清理记录</button>}</div><div className="sidebar-identity"><div className="identity-avatar">{(user.name || user.email || "C").slice(0, 1).toUpperCase()}</div><div><strong>{user.name || user.email || "协作成员"}</strong><small>{user.kind === "device" ? "设备自动登录" : ROLES[user.role]}</small></div></div></aside>
    <main className="main-content">
      {!networkOnline && <Notice tone="info"><WifiOff size={16}/>网络已断开，正在显示上次内容。恢复连接后自动同步。</Notice>}
      {error && <Notice>{error} 当前保留上次同步的内容。<button className="inline-link" onClick={() => void reload()}>重新同步</button></Notice>}{actionError && <Notice>{actionError}</Notice>}
      {toast && <div className="toast" role="status"><span>{toast}</span><button className="text-button" onClick={() => setToast("")}>知道了</button></div>}
      {tab === "home" && <>
        <div className="summary-strip"><button onClick={() => navigate("devices")}><div className="summary-icon"><Monitor size={24} /></div><div><span>在线设备</span><strong>{online}<small> / {activeNodes.length}</small></strong></div></button><button onClick={() => document.getElementById("running-projects-overview")?.focus()}><div className="summary-icon"><Play size={23} /></div><div><span>进行中</span><strong>{running ?? "—"}</strong></div></button><button onClick={() => openAttention()}><div className="summary-icon amber"><Clock3 size={25} /></div><div><span>待处理</span><strong>{pending}</strong></div></button></div>
        <div id="running-projects-overview" tabIndex={-1} aria-label="正在进行的全部项目"><RunningProjects projects={data.runningProjects} nodes={activeNodes} onProject={openProject} onTask={openRunningTask} onHistory={() => navigate("projects")} /></div>
        {desktop.error && <Notice>电脑任务目录：{desktop.error}</Notice>}
        <Workstations nodes={activeNodes} groups={deviceGroups.groups} onDetails={setDetailsNodeId} tasks={data.tasks} events={data.events} summary={desktop.data} taskStats={data.taskStats} onFleetNode={openFleetTasks} attentionStats={data.attentionStats} onAttentionNode={openAttention} canWrite={canWrite} onDevice={openDevice} onTask={openTask} onThread={openThread} onCompose={compose} />
        {!activeNodes.length && user.role === "admin" && <div className="empty-action"><button className="button primary" onClick={() => setInvite(true)}><Plus size={17} />添加第一台电脑</button></div>}
        <DesktopDirectory nodes={activeNodes} nodeId={deviceFilter} onNode={setDeviceFilter} canWrite={canWrite} onSelect={openThread} revision={desktopRevision} compact onAll={() => { setTaskSource("desktop"); navigate("tasks"); }} selectedId={selectedThreadId} />
        <TransferOverview files={data.files} tasks={data.tasks} nodes={data.nodes} events={data.events} onTask={openTask} onFiles={() => navigate("files")} />
        <details className="home-collaboration"><summary>近期协作任务 · {data.tasks.length} 项记录</summary><Section title="协作任务" action={<ViewAll onClick={() => openFleetTasks()} />}><TaskList tasks={data.tasks.slice(0, 6)} nodes={data.nodes} onSelect={openTask} /></Section></details>
      </>}
      {tab === "attention" && <>{attentionNode && <div className="attention-heading"><span>{data.nodes.find(n=>n.id===attentionNode)?.name || "本机"} 的待办</span></div>}<div className="source-switcher" aria-label="待办分类"><button className={attentionCategory === "action" ? "active" : ""} onClick={()=>setAttentionCategory("action")}>待处理 <span>{attentionCounts?.action || 0}</span></button><button className={attentionCategory === "confirm" ? "active" : ""} onClick={()=>setAttentionCategory("confirm")}>待确认 <span>{attentionCounts?.confirm || 0}</span></button></div><FleetTaskDirectory key={`${attentionCategory}:${user.nodeId || "account"}`} attention={attentionCategory} nodes={user.kind === "device" ? activeNodes.filter(n=>n.id===user.nodeId) : activeNodes} targetValue={attentionNode} onTargetChange={setAttentionTarget} onSelect={openTask} /></>}
      {tab === "devices" && <><div className="device-page-heading"><span>{activeNodes.filter(n=>nodeRuntime(n).canExecute).length} 台可接任务 · {online} 台在线 · {activeNodes.length} 台已接入</span>{user.role === "admin" && <div className="device-page-actions"><button className="button secondary small" onClick={() => setGroupsOpen(true)}><FolderOpen size={15} />业务分组</button><button className="button secondary small" onClick={() => setInviteRecords(true)}>接入记录</button><button className="button primary small" onClick={() => setInvite(true)}><Plus size={16} />添加电脑</button></div>}</div>{deviceGroups.error && <Notice>业务分组：{deviceGroups.error}</Notice>}<Workstations nodes={activeNodes} groups={deviceGroups.groups} onDetails={setDetailsNodeId} tasks={data.tasks} events={data.events} summary={desktop.data} taskStats={data.taskStats} onFleetNode={openFleetTasks} attentionStats={data.attentionStats} onAttentionNode={openAttention} canWrite={canWrite} onDevice={openDevice} onTask={openTask} onThread={openThread} onCompose={compose} /><DesktopDirectory nodes={activeNodes} nodeId={deviceFilter} onNode={setDeviceFilter} canWrite={canWrite} onSelect={openThread} revision={desktopRevision} selectedId={selectedThreadId} /><details className="additional-members"><summary>设备项目、技能与账号</summary><Section title="设备资料"><NodeList nodes={data.nodes} tasks={data.tasks} canWrite={canWrite} onCompose={compose} detailed /></Section></details></>}
      {tab === "tasks" && <><div className="source-switcher" aria-label="任务来源"><button className={taskSource === "desktop" ? "active" : ""} onClick={() => setTaskSource("desktop")}><Monitor size={16} />本地对话</button><button className={taskSource === "fleet" ? "active" : ""} onClick={() => {setFleetPhase("all");setFleetFilter("");setTaskSource("fleet");}}><Send size={16} />协作任务</button></div>{taskSource === "desktop" ? <DesktopDirectory nodes={activeNodes} nodeId={deviceFilter} onNode={setDeviceFilter} canWrite={canWrite} onSelect={openThread} revision={desktopRevision} selectedId={selectedThreadId} /> : <FleetTaskDirectory phase={fleetPhase} onPhaseChange={setFleetPhase} key={`${fleetFilter}:${fleetPhase}`} initialTarget={fleetFilter} nodes={data.nodes} onSelect={openTask} />}</>}
      {tab === "projects" && <ProjectCatalog index={projectIndex} running={data.runningProjects} nodes={activeNodes} error={projectsError} onProject={openProject} />}
      {tab === "project" && selectedProject && <ProjectHistory key={selectedProject.id} project={selectedProject} nodes={activeNodes} initialSource={projectSource} canWrite={canWrite} revision={desktopRevision} selectedId={selectedThreadId} onBack={() => navigate("projects")} onTask={openTask} onThread={openThread} onController={() => { if (selectedProject.controllerThreadId) void readDesktop(selectedProject.nodeId, selectedProject.controllerThreadId); }} onCompose={compose} />}
      {tab === "files" && <FilesView files={data.files} groups={deviceGroups.groups} access={user.access} nodes={activeNodes} canWrite={canWrite} canAdmin={user.role === "admin"} refresh={() => void refresh()} onCompose={compose} onTask={id => void selectTask(id)} />}
      {tab === "deliveries" && <DeliveryCenter nodes={activeNodes} user={user} onTask={id => void selectTask(id)} />}
      {tab === "automations" && <Automations nodes={activeNodes} canWrite={canWrite} onTask={id => void selectTask(id)} />}
      {tab === "members" && <><Accounts user={user} groups={deviceGroups.groups} groupsError={deviceGroups.error} /><details className="additional-members"><summary>ChatGPT 账号授权与成员权限</summary><Members user={user} groups={deviceGroups.groups} groupsError={deviceGroups.error} /></details></>}
      <footer className="sync-footer"><span><i className={error ? "sync-error" : ""} />{lastSync ? `最近同步 ${time(lastSync)}` : "等待首次同步"} · 自动更新</span><button className="text-button" disabled={refreshing} onClick={() => void reload()}><RefreshCw size={14} className={refreshing ? "spin" : ""} />同步</button></footer>
    </main>
    {showInspector && !reading && <aside className="inspector-placeholder"><header><h2>任务详情</h2><PanelRightOpen size={17} /></header><div className="inspector-prompt"><FileText size={27} /><strong>选择任务，查看进展</strong></div><Section title="协作动态" action={<ViewAll onClick={() => setAllEvents(true)}>全部</ViewAll>}><Timeline events={data.events.slice(0, 8)} onTask={id => void selectTask(id)} /></Section></aside>}
    <nav className="mobile-nav" aria-label="移动导航">
      <button className={tab==='home'?'active':''} onClick={()=>navigate('home')} aria-current={tab==='home'?'page':undefined}><House size={21}/><span>工作台</span></button>
      <button className={tab==='devices'?'active':''} onClick={()=>navigate('devices')} aria-current={tab==='devices'?'page':undefined}><Monitor size={21}/><span>设备</span></button>
      {canWrite?<button className="mobile-dispatch" disabled={!activeNodes.length} onClick={()=>compose()} aria-label="新建对话"><span className="mobile-dispatch-icon"><Plus size={25}/></span><span>新对话</span></button>:<button className={tab==='projects'?'active':''} onClick={()=>navigate('projects')}><FolderOpen size={21}/><span>项目</span></button>}
      <button className={tab==='tasks'?'active':''} onClick={()=>navigate('tasks')} aria-current={tab==='tasks'?'page':undefined}><FileText size={21}/><span>任务</span></button>
      <button className={['projects','project','files','automations','members'].includes(tab)?'active':''} onClick={()=>setMoreOpen(true)} aria-expanded={moreOpen}><MoreHorizontal size={22}/><span>更多</span></button>
    </nav>
    {moreOpen && <Modal title="更多" onClose={()=>setMoreOpen(false)}><div className="more-menu">{NAV.filter(n=>['attention','projects','deliveries','automations','files','members'].includes(n.key)).map(({key,label,Icon})=><button key={key} onClick={()=>navigate(key)}><Icon size={20}/><span>{label}</span></button>)}<button onClick={()=>{setMoreOpen(false);setAllEvents(true);}}><Activity size={20}/><span>协作动态</span></button>{user.role==='admin'&&<button onClick={()=>{setMoreOpen(false);setCleanupOpen(true);}}><Trash2 size={20}/><span>清理记录</span></button>}</div></Modal>}
    {cleanupOpen && user.role==='admin' && <CleanupHistory onClose={()=>setCleanupOpen(false)} onChanged={()=>{setDesktopRevision(v=>v+1);void refresh();}}/>}
    {composer && <TaskComposer nodes={activeNodes} files={data.files} seed={composer} draft={!composer.resumeTask && !composer.inputs && (!composer.node || composer.node.id===taskDraft?.target) ? taskDraft : null} onDraft={setTaskDraft} onClose={() => setComposer(null)} onCreated={created} />}
    {selected?.spec.intent==="conversation"?<ConversationLaunch key={selected.id} initial={selected} onClose={()=>setSelected(null)} onOpen={thread=>{setSelected(null);openThread(thread);}}/>:selected && <TaskDetail localNodeId={user.kind === "device" ? user.nodeId : undefined} key={selected.id} task={selected} nodes={data.nodes} canWrite={canWrite} canAdmin={user.role === "admin"} onClose={() => setSelected(null)} onChanged={() => void refresh()} onCompose={compose} onDesktopThread={(nodeId, threadId) => { setSelected(null); void readDesktop(nodeId, threadId); }} />}
    {desktopThread && <DesktopThreadDetail localNodeId={user.kind === "device" ? user.nodeId : undefined} key={`${desktopThread.nodeId}:${desktopThread.threadId}`} initial={desktopThread} nodes={data.nodes} canWrite={canWrite} onClose={() => setDesktopThread(null)} onChanged={() => setDesktopRevision(value => value + 1)} onFleetTask={id => { setDesktopThread(null); void selectTask(id); }} />}
    {invite && <DeviceInvite onClose={() => setInvite(false)} suggestedCode={nextCode} groups={deviceGroups.groups} groupsError={deviceGroups.error} onCreated={changedDevices} onRecords={() => { setInvite(false); setInviteRecords(true); }} />}
    {inviteRecords && user.role === "admin" && <DeviceInvitations onClose={() => setInviteRecords(false)} onAdd={() => { setInviteRecords(false); setInvite(true); }} onChanged={changedDevices} />}
    {groupsOpen && user.role === "admin" && <DeviceGroupsManager groups={deviceGroups.groups} nodes={data.nodes} onClose={() => setGroupsOpen(false)} onChanged={changedDevices} />}
    {detailsNode && <DeviceDetails key={detailsNode.id} node={detailsNode} groups={deviceGroups.groups} groupsError={deviceGroups.error} canAdmin={user.role === "admin"} canWrite={canWrite} onClose={() => setDetailsNodeId("")} onSaved={() => { setDetailsNodeId(""); setToast("设备资料已保存。"); changedDevices(); }} />}
    {allEvents && <Modal title="协作动态" onClose={() => setAllEvents(false)} wide><div className="detail-body"><Timeline events={data.events} expanded onTask={id => void selectTask(id)} /></div></Modal>}
  </div>;
}
