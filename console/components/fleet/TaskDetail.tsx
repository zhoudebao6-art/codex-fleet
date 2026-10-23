"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, FileText, MessageSquare, Send, Square, ArrowUpRight, Monitor } from "lucide-react";
import { api, bytes, errorText, mutation, taskTitle, time, uid } from "./api";
import type { ComposerSeed, FleetEvent, FleetMessage, FleetNode, FleetTask } from "./types";
import { Busy, Modal, Notice, Status } from "./ui";
import { actorName, currentActivity, describeEvent } from "./events";
import {RuntimeBadge} from "./RuntimeStatus";
import TaskInteractions from "./TaskInteractions";
import type { Workspace } from "./ProjectPicker";
import CodexThreadLink from "./CodexThreadLink";
import DetailTabs from "./DetailTabs";
import MessageFeed, { type ReadingEntry } from "./MessageFeed";

const TERMINAL = new Set(["submitted", "accepted", "failed", "cancelled", "blocked"]);
const CANCELLABLE = new Set(["queued", "claimed", "running", "blocked", "uncertain"]);
function messageActor(message: FleetMessage, nodes: FleetNode[]) {
  const sender = message.from || message.sender;
  const device = nodes.find(node => node.id === sender);
  if (device) return device.name;
  if (sender?.startsWith("member:")) return "协作成员";
  return actorName(sender && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sender) ? "未登记设备" : sender);
}

export default function TaskDetail({ task: initialTask, nodes, canWrite, canAdmin, localNodeId, onClose, onChanged, onCompose, onDesktopThread }: { task: FleetTask; nodes: FleetNode[]; canWrite: boolean; canAdmin: boolean; localNodeId?: string; onClose: () => void; onChanged: () => void; onCompose: (seed: ComposerSeed) => void; onDesktopThread?: (nodeId: string, threadId: string) => void }) {
  const [task, setTask] = useState(initialTask);
  const [messages, setMessages] = useState<FleetMessage[]>([]);
  const [events, setEvents] = useState<FleetEvent[]>([]);
  const [progressLoaded, setProgressLoaded] = useState(false);
  const [text, setText] = useState("");
  const [operationError, setOperationError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmStopped, setConfirmStopped] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [detailTab, setDetailTab] = useState(["submitted","accepted"].includes(initialTask.status)?"result":"chat");
  const [messageFollow, setMessageFollow] = useState(0);
  const messageId = useRef(uid());
  const node = nodes.find(n => n.id === task.target);
  const workspaceId = typeof task.spec?.workspaceId === "string" ? task.spec.workspaceId : "";
  const threadId = [task.thread_id, task.threadId, task.result?.threadId].find(id => typeof id === "string" && id.trim());
  const nativeThreadId = typeof task.spec.desktopThreadId === "string" ? task.spec.desktopThreadId : "";
  const projectLabel = workspace?.name && workspace.name !== "workspace" ? workspace.name : workspaceId ? "已绑定项目" : task.project === "workspace" ? "默认工作目录" : task.project;
  const online = Boolean(node?.online && !node?.revoked);
  const titleCharacters = Array.from(taskTitle(task.spec?.prompt));
  const shortTitle = titleCharacters.length > 50 ? `${titleCharacters.slice(0, 50).join("")}…` : titleCharacters.join("");
  const artifacts = task.artifacts || task.result?.artifacts || [];
  const inputs = task.inputs || task.spec?.inputs || [];
  const deviceEvents = events.filter(event => (event.sourceId || event.node) === task.target && ["progress", "started", "finished"].includes(event.type || ""));
  const activity = currentActivity(deviceEvents);
  const lastDeviceEvent = [...deviceEvents].sort((a, b) => b.seq - a.seq)[0];
  const lastReport = lastDeviceEvent?.created ?? node?.lastSeen ?? node?.last_seen;
  const reportLabel = lastDeviceEvent ? online ? "最近动作" : "离线 · 最后回报" : online ? "最近连接" : "离线 · 最近连接";
  const contextStatus = task.status === "queued" ? "等待设备接收" : task.status === "submitted" ? "结果已提交，等待确认" : task.status === "accepted" ? "结果已确认" : task.status === "cancelled" ? "任务已取消" : task.status === "uncertain" ? "执行状态需要核实" : task.status === "failed" ? "执行失败" : task.status === "cancel_requested" ? "等待设备确认停止" : null;
  const entries: ReadingEntry[] = [
    ...events.filter(event => event.type !== "message").map(event => { const info = describeEvent(event); return { id: `event-${event.seq}`, at: event.created, actor: actorName(event.sourceName || event.nodeName || node?.name), role: /tool|command|filechange/.test(info.kind) ? "tool" as const : ["assistant_message", "agentMessage"].includes(info.kind) ? "assistant" as const : "system" as const, label: info.label, text: info.text }; }),
    ...messages.map(message => ({ id: `message-${message.id}`, at: message.created, actor: messageActor(message, nodes), text: message.text, role: nodes.some(item => item.id === (message.from || message.sender)) ? "assistant" as const : "user" as const })),
  ].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime()).slice(-200);

  useEffect(() => {
    setWorkspace(null); setWorkspaceError("");
    if (!workspaceId) return;
    let alive = true;
    void api<{ workspaces: Workspace[] }>(`/v1/workspaces?nodeId=${encodeURIComponent(task.target)}`).then(value => {
      if (!alive) return;
      const match = value.workspaces.find(item => item.id === workspaceId) || null;
      setWorkspace(match); if (!match) setWorkspaceError("项目目录信息暂不可用。");
    }).catch(err => { if (alive) setWorkspaceError(errorText(err)); });
    return () => { alive = false; };
  }, [task.target, workspaceId]);

  useEffect(() => {
    let alive = true;
    let initialized = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function readEvents() {
      let nextCursor = cursor;
      const rows: FleetEvent[] = [];
      for (let page = 0; page < (initialized ? 3 : 1); page++) {
        const incoming = await api<FleetEvent[]>(`/v1/tasks/${encodeURIComponent(initialTask.id)}/events?${initialized ? `after=${nextCursor}` : "tail=100"}&limit=100`);
        rows.push(...incoming);
        nextCursor = Math.max(nextCursor, ...incoming.map(event => event.seq));
        if (incoming.length < 100) break;
      }
      return { rows, nextCursor };
    }
    async function load() {
      const responses = await Promise.allSettled([
        api<FleetTask>(`/v1/tasks/${encodeURIComponent(initialTask.id)}`).then(value => { if (alive) setTask(value); }),
        api<FleetMessage[]>(`/v1/tasks/${encodeURIComponent(initialTask.id)}/messages`).then(value => { if (alive) setMessages(value); }),
        readEvents().then(({ rows, nextCursor }) => {
          if (!alive) return;
          setProgressLoaded(true);
          const wasInitialized = initialized;
          cursor = nextCursor; initialized = true;
          setEvents(previous => Array.from(new Map([...(wasInitialized ? previous : []), ...rows].map(event => [event.seq, event])).values()).sort((a, b) => a.seq - b.seq).slice(-200));
        }),
      ]);
      if (!alive) return;
      const sources = ["任务状态", "消息", "执行记录"];
      setSyncError(responses.flatMap((response, index) => response.status === "rejected" ? [`${sources[index]}：${errorText(response.reason)}`] : []).join("；"));
      timer = setTimeout(load, document.hidden ? 30000 : 5000);
    }
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [initialTask.id]);

  async function action(kind: "accept" | "cancel" | "resolve") {
    setBusy(kind); setOperationError(""); setSuccess("");
    try {
      const result = await mutation<FleetTask>(`/v1/tasks/${encodeURIComponent(task.id)}/${kind}`, kind === "accept" ? { note: "已在协作台检查并确认结果。" } : kind === "resolve" ? { confirmStopped, note: resolveNote.trim() } : {});
      setSuccess(kind === "accept" ? "结果已确认。" : kind === "resolve" ? "已记录核实说明并结束这次尝试，没有自动重新派发任务。" : result.status === "cancelled" ? "任务已取消，已有记录和文件已保留。" : "正在取消，等待目标电脑确认停止。"); setConfirmCancel(false); onChanged();
      try { setTask(await api<FleetTask>(`/v1/tasks/${encodeURIComponent(task.id)}`)); }
      catch (err) { setSyncError(`任务状态：${errorText(err)}`); }
    } catch (err) { setOperationError(errorText(err)); } finally { setBusy(""); }
  }
  async function sendMessage() {
    if (busy || !text.trim()) return;
    setBusy("message"); setOperationError(""); setSuccess("");
    try {
      await mutation(`/v1/tasks/${encodeURIComponent(task.id)}/messages`, { id: messageId.current, text: text.trim() });
      setText(""); messageId.current = uid(); setSuccess("补充说明已发送，等待目标电脑处理。");
      onChanged();
      try { setMessages(await api<FleetMessage[]>(`/v1/tasks/${encodeURIComponent(task.id)}/messages`)); setMessageFollow(value => value + 1); }
      catch (err) { setSyncError(`消息：${errorText(err)}`); }
    } catch (err) { setOperationError(errorText(err)); } finally { setBusy(""); }
  }
  return <Modal title="任务详情" wide inspector onClose={onClose} busy={!!busy}>
    <div className="detail-body">
      {operationError && <Notice>{operationError}</Notice>}{syncError && <Notice>{syncError}</Notice>}{success && <Notice tone="success">{success}</Notice>}
      <div className="task-location"><div><Monitor size={22} /><strong>{node?.name || "设备未登记"}</strong><RuntimeBadge node={node}/></div><Status value={task.status} verbose /></div>
      <div className="task-title-line"><h3 title={taskTitle(task.spec?.prompt)}>{shortTitle}</h3>{task.status==="submitted"&&<button className="button secondary small" onClick={()=>setDetailTab("result")}>检查结果</button>}</div>
      <div className={`current-action ${online ? "" : "offline"}`}><div><span>{reportLabel}</span><time>{time(lastReport)}</time></div><strong>{contextStatus || activity?.headline || (progressLoaded ? "尚未收到执行进展" : syncError ? "进展暂时未加载，正在重试" : "正在读取最新进展…")}</strong>{!contextStatus && activity?.detail && <details className="activity-more"><summary>查看动作详情</summary><p>{activity.detail}</p></details>}{!online && ["running", "claimed", "blocked"].includes(task.status) && <small>当前执行情况待设备恢复连接后确认。</small>}{task.status === "blocked" && <p>{task.result?.error || "等待补充信息或处理设备权限。"}</p>}</div>
      <div className="task-meta"><span>{projectLabel}</span><span>{task.spec?.mode === "question" ? "只读提问" : "执行任务"}</span><span>创建于 {time(task.created)}</span>{task.completedAt && <span>执行完成于 {time(task.completedAt)}</span>}</div>
      <TaskInteractions taskId={task.id} canWrite={canWrite} />
      <ol className="task-stage-strip" aria-label="任务阶段">{[["queued","排队"],["claimed","设备接收"],["running","执行"],["submitted","核验结果"],["accepted","已确认"]].map(([status,label],index)=>{const at=["queued","claimed","running","submitted","accepted"].indexOf(task.status);return <li key={status} className={at===index?"current":at>index?"passed":""} aria-current={at===index?"step":undefined}><i>{at>index?"✓":index+1}</i>{label}</li>;})}</ol>
      {task.waitReason && <Notice tone="info">{task.waitReason}</Notice>}
      {task.coordination && !task.coordination.complete && <Notice tone="info">分派尚未全部完成：{task.coordination.pendingFlows} 个流程、{task.coordination.pendingChildren} 项子任务待收尾。请在流程页查看进展。</Notice>}
      <DetailTabs value={detailTab} onChange={setDetailTab} items={[{id:"chat",label:"聊天记录",count:entries.filter(e=>e.role==="user"||e.role==="assistant").length},{id:"result",label:"结果与文件",count:artifacts.length},{id:"info",label:"任务信息"}]} />
      <div className="detail-tab-panel" hidden={detailTab!=="chat"}>
      <section className="detail-section"><MessageFeed entries={entries} followSignal={messageFollow} emptyText={progressLoaded ? "尚未收到进展。" : syncError ? "记录暂时未加载，正在重试。" : "正在读取消息…"} /></section>
      {canWrite && !TERMINAL.has(task.status) && task.status !== "cancel_requested" && <div className="reply-box"><label htmlFor="task-message"><MessageSquare size={17} />补充说明<textarea id="task-message" rows={3} value={text} maxLength={16000} onChange={e => setText(e.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder="告诉这台电脑需要补充什么，或说明新的要求。" /></label><button className="button primary" disabled={!!busy || !text.trim()} onClick={sendMessage}>{busy === "message" ? <Busy /> : <><Send size={16} />发送说明</>}</button></div>}
      </div>
      <div className="detail-tab-panel" hidden={detailTab!=="result"}>
      {(task.result?.summary || task.result?.error) && <section className="detail-section"><h4>执行结果</h4>{task.result.error && <Notice>{task.result.error}</Notice>}{task.result.summary && <div className="prose-block result-block">{task.result.summary}</div>}</section>}
      {artifacts.length > 0 && <section className="detail-section"><h4>交付文件</h4><div className="attachment-list">{artifacts.map(file => <div className="attachment" key={file.sha}><FileText size={19} /><span>{file.name}<small>{bytes(file.size)}</small></span><a className="icon-button" href={`/v1/artifacts/${encodeURIComponent(file.sha)}?task=${encodeURIComponent(task.id)}`} download={file.name} aria-label={`下载 ${file.name}`}><Download size={18} /></a>{canWrite && <button className="text-button" onClick={() => onCompose({ project: task.project, inputs: [{ ...file, project: task.project }] })}>转交<ArrowUpRight size={16} /></button>}</div>)}</div></section>}
      {!task.result?.summary&&!task.result?.error&&!artifacts.length&&<p className="detail-empty">尚未提交结果或文件</p>}
      </div>
      <div className="detail-tab-panel" hidden={detailTab!=="info"}>
      <details className="detail-disclosure" open><summary>完整任务要求</summary><div className="prose-block">{task.spec?.prompt}</div></details>
      {inputs.length > 0 && <section className="detail-section"><h4>输入文件</h4><div className="attachment-list">{inputs.map(file => <div className="attachment" key={file.sha}><FileText size={18} /><span>{file.name}<small>{bytes(file.size)}</small></span></div>)}</div></section>}
      <CodexThreadLink localNodeId={localNodeId} nodeId={task.target} busy={["claimed","running","uncertain","cancel_requested"].includes(task.status)} shared={node?.capabilities?.desktopSessionBridge === true} threadId={threadId} deviceName={node?.code || node?.name} />
      {workspaceId && <details className="detail-disclosure"><summary>项目工作目录</summary>{workspaceError ? <Notice>{workspaceError}</Notice> : workspace?.root || workspace?.path ? <div className="prose-block">{workspace.root || workspace.path}</div> : <p className="muted">正在读取项目目录…</p>}</details>}
      <dl className="detail-facts"><div><dt>任务编号</dt><dd>{task.id}</dd></div><div><dt>项目</dt><dd>{projectLabel}</dd></div></dl>
      </div>
      {confirmCancel && <Notice tone="info"><span>确定停止这项任务？已经产生的文件会保留。</span><div className="inline-actions"><button className="button danger" disabled={!!busy} onClick={() => void action("cancel")}>确认取消任务</button><button className="button secondary" onClick={() => setConfirmCancel(false)}>继续执行</button></div></Notice>}
      {canAdmin && ["uncertain", "cancel_requested"].includes(task.status) && <details className="resolve-box"><summary>核实并结束本次尝试</summary><p>确认设备上的原任务已停止后操作，不会自动重派。</p><label className="resolve-check"><input type="checkbox" checked={confirmStopped} onChange={e => setConfirmStopped(e.target.checked)} />我已确认原任务停止</label><label>核实说明<textarea rows={3} value={resolveNote} onChange={e => setResolveNote(e.target.value)} maxLength={16000} placeholder="检查方式、停止时间与保留的结果" /></label><button className="button secondary" disabled={!!busy || !confirmStopped || !resolveNote.trim()} onClick={() => void action("resolve")}>{busy === "resolve" ? <Busy /> : "保存并结束尝试"}</button></details>}
    </div>
    {canWrite && <footer className="modal-footer detail-footer">{task.actions?.cancel && CANCELLABLE.has(task.status) && <button className="button quiet danger-text" disabled={!!busy} onClick={() => setConfirmCancel(true)}><Square size={15} />取消任务</button>}<div className="spacer" />{TERMINAL.has(task.status) && (nativeThreadId ? onDesktopThread && <button className="button secondary" disabled={!!busy} onClick={() => onDesktopThread(task.target, nativeThreadId)}><MessageSquare size={17} />返回原会话</button> : <button className="button secondary" disabled={!!busy} onClick={() => onCompose({ node, resumeTask: task, project: task.project, mode: "question" })}><MessageSquare size={17} />继续追问</button>)}{task.actions?.accept && task.status === "submitted" && <button className="button primary" disabled={!!busy||task.coordination?.complete===false} onClick={() => void action("accept")}>{busy === "accept" ? <Busy /> : <><Check size={18} />确认结果</>}</button>}</footer>}
  </Modal>;
}
