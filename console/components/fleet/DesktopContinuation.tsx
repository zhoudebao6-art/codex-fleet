"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Send } from "lucide-react";
import { ApiError, api, errorText, mutation, uid } from "./api";
import type { DesktopThread } from "./desktop-types";
import type { FleetNode, FleetTask } from "./types";
import { Busy, Notice } from "./ui";
import { desktopLaunchIssue,nodeRuntime } from "../../lib/fleet/runtime-readiness.mjs";

const FINISHED = new Set(["submitted", "accepted", "blocked", "failed", "cancelled"]);
const ERRORS: Record<string, string> = { NATIVE_THREAD_ARCHIVED: "请先在对应电脑恢复这条归档会话。", NODE_OFFLINE: "电脑已离线，恢复连接后再试。", NATIVE_CONTINUATION_UNSUPPORTED: "这台电脑尚未开放网页续接，请在对应 Codex 中继续。", NATIVE_DIRECTORY_UNAVAILABLE: "原会话工作目录尚未同步，请稍后更新进展。", NATIVE_CONTINUATION_PENDING: "这条会话已有续接请求，请等待当前请求结束。", GROUP_ACCESS_DENIED: "当前身份没有这台电脑的访问权限。" };

export default function DesktopContinuation({ thread, node, canWrite, onTask, onContinued }: { thread: DesktopThread; node?: FleetNode; canWrite: boolean; onTask: (id: string) => void; onContinued: () => void }) {
  const [draft, setDraft] = useState(""); const [task, setTask] = useState<FleetTask | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [checkingLinked, setCheckingLinked] = useState(Boolean(thread.fleetTaskNative && thread.fleetTaskId));
  const [linkedRevision, setLinkedRevision] = useState(0);
  const request = useRef<{ id: string; prompt: string } | null>(null); const completed = useRef(""); const onContinuedRef = useRef(onContinued); onContinuedRef.current = onContinued;
  const desktopResult = task?.result?.desktop as { state?: string; reason?: string } | undefined;
  const pending = checkingLinked || !!task && (!(node?.capabilities?.conversationDispatch===true&&task.status==="running")&&!FINISHED.has(task.status) || desktopResult?.state === "uncertain");
  const uncertainSubmission = !!request.current && !task && !busy;
  const available = node?.capabilities?.desktopContinuation === true && nodeRuntime(node).canConverse && node.online && !node.revoked && !thread.archived && !!(thread.cwd || thread.workspace);
  useEffect(() => {
    if (!thread.fleetTaskNative || !thread.fleetTaskId) { setCheckingLinked(false); return; }
    let alive = true; setCheckingLinked(true); setError("");
    void api<FleetTask>(`/v1/tasks/${encodeURIComponent(thread.fleetTaskId)}`).then(linked => {
      if (!alive) return;
      const result = linked.result?.desktop as { state?: string } | undefined;
      if (!FINISHED.has(linked.status) || result?.state === "uncertain") setTask(linked);
      setCheckingLinked(false);
    }).catch(err => { if (alive) setError(errorText(err)); });
    return () => { alive = false; };
  }, [thread.fleetTaskId, thread.fleetTaskNative, linkedRevision]);
  function receive(next: FleetTask) {
    setTask(next);
    if (["submitted", "accepted"].includes(next.status) && completed.current !== next.id) { completed.current = next.id; setDraft(""); request.current = null; onContinuedRef.current(); }
  }
  useEffect(() => {
    if (!task?.id || FINISHED.has(task.status)) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await api<FleetTask>(`/v1/tasks/${encodeURIComponent(task!.id)}`); if (!alive) return; receive(next); setError("");
        if (FINISHED.has(next.status)) return;
      } catch (err) { if (alive) setError(errorText(err)); }
      if (alive) timer = setTimeout(load, document.hidden ? 15000 : 4000);
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [task?.id, task?.status]);
  async function send() {
    if (!available || !canWrite || pending || busy || !draft.trim()) return;
    if (!request.current || task && (FINISHED.has(task.status)||task.status==="running")) request.current = { id: uid(), prompt: draft.trim() };
    setBusy(true); setError(""); setTask(null);
    try { const next = await mutation<FleetTask>(`/v1/desktop/threads/${encodeURIComponent(thread.nodeId)}/${encodeURIComponent(thread.threadId)}/message`, request.current); receive(next); }
    catch (err) { if (err instanceof ApiError && err.status >= 400 && err.status < 500) request.current = null; setError(err instanceof ApiError && err.code && ERRORS[err.code] || errorText(err)); }
    finally { setBusy(false); }
  }

  if (!canWrite) return <p className="quiet-hint">当前身份可阅读这条会话。</p>;
  if (node?.capabilities?.parallelExecution===true && node.capabilities.conversationDispatch!==true) return <p className="quiet-hint">{desktopLaunchIssue(node.capabilities)||'节点已更新，桌面联动尚未激活。当前工作结束后，从“Codex Fleet 联动”重新打开，即可发送到原对话。'}</p>;
  if (node?.capabilities?.desktopContinuation !== true) return <p className="quiet-hint">这台电脑尚未开放网页续接，请在对应 Codex 中继续。</p>;
  const state = desktopResult?.state === "uncertain" ? "续接是否生效尚未确认，请先在原电脑核实，暂不重复提交。" : desktopResult?.state === "busy" ? "会话正被对应电脑的 Codex 占用，本次未续接。草稿已保留。" : desktopResult?.state === "unsupported" ? "这条会话暂不支持网页续接，草稿已保留。" : task?.status === "queued" ? task.waitReason||"正在发送到原对话。" : task?.status === "claimed" ? "电脑已接收，正在检查原会话。" : task?.status === "running" ? "正在原会话中处理这条消息。" : task?.status === "uncertain" ? "执行状态待核实，请查看协作记录。" : task?.status === "cancel_requested" ? "正在等待电脑确认停止。" : ["submitted", "accepted"].includes(task?.status || "") ? task?.result?.deliveryOnly?"消息已追加，原会话仍在执行。":"本次消息处理已结束，可查看原会话结果。" : task ? "本次续接未完成，草稿已保留。" : checkingLinked ? "正在检查这条会话的上次续接状态。" : "";
  return <section className="native-continuation"><h4>发送到原对话</h4>{!nodeRuntime(node).canConverse&&<p className="runtime-reason">{nodeRuntime(node).reason}</p>}{error && <Notice>{error}</Notice>}{error && checkingLinked && <button className="text-button" onClick={() => setLinkedRevision(value => value + 1)}>重新检查续接状态</button>}{state && <Notice tone={FINISHED.has(task?.status || "") && !["submitted", "accepted"].includes(task?.status || "") ? "error" : "info"}>{state}</Notice>}{task && <button className="text-button" onClick={() => onTask(task.id)}>查看这次续接记录<ArrowUpRight size={13} /></button>}{!node.online && <p className="field-hint">电脑离线，恢复连接后可提交。</p>}{thread.archived && <p className="field-hint">请先在对应电脑恢复归档会话。</p>}<label>发给这条会话<textarea rows={3} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} maxLength={64000} disabled={busy || pending || uncertainSubmission} placeholder="补充要求或继续提问" /></label>{uncertainSubmission && <p className="field-hint">提交结果待确认，重试会沿用同一请求。</p>}<button className="button primary small" disabled={!available || busy || pending || !draft.trim()} onClick={() => void send()}>{busy ? <Busy /> : <><Send size={14} />{uncertainSubmission ? "确认提交结果" : "发送消息"}</>}</button><p className="field-hint">消息将继续原会话。Ctrl / ⌘ + Enter 发送。</p></section>;
}
