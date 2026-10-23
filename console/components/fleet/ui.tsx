"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronRight, LoaderCircle, X } from "lucide-react";

export const STATUS: Record<string, { label: string; tone: string; description: string }> = {
  queued: { label: "待发送", tone: "neutral", description: "任务已保存，等待目标电脑接收。离线电脑上线后会继续接收。" },
  claimed: { label: "已接收", tone: "blue", description: "目标电脑已接收，正在准备文件与运行环境。" },
  running: { label: "执行中", tone: "green", description: "目标电脑的 Codex 正在执行。" },
  submitted: { label: "待确认", tone: "amber", description: "Codex 已提交执行结果，请检查结果后确认完成。" },
  accepted: { label: "已确认", tone: "green", description: "执行结果已经人工确认。" },
  failed: { label: "执行失败", tone: "red", description: "本次执行失败，请查看说明后决定是否继续。" },
  blocked: { label: "需要处理", tone: "amber", description: "执行需要补充信息或处理本机权限，请查看任务说明。" },
  uncertain: { label: "待核实", tone: "amber", description: "执行状态无法确认。请检查目标电脑，避免重复执行。" },
  cancel_requested: { label: "正在取消", tone: "amber", description: "取消指令已发送，等待目标电脑确认停止。" },
  cancelled: { label: "已取消", tone: "neutral", description: "本次任务已经取消。" },
};

export function Status({ value, verbose = false }: { value: string; verbose?: boolean }) {
  const state = STATUS[value] || { label: value || "状态未知", tone: "neutral", description: "" };
  return <span className={`status status-${state.tone}`} title={state.description}><i />{verbose && value === "submitted" ? "执行完成，待确认" : state.label}</span>;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export function Notice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "success" | "info" }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<span>{children}</span></div>;
}

export function Busy({ children = "处理中" }: { children?: ReactNode }) { return <><LoaderCircle className="spin" size={16} />{children}</>; }

export function Section({ title, subtitle, action, children, className = "" }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>;
}

export function ViewAll({ onClick, children = "查看全部" }: { onClick: () => void; children?: ReactNode }) { return <button className="text-button" onClick={onClick}>{children}<ChevronRight size={15} /></button>; }

export function Modal({ title, subtitle, onClose, children, wide = false, busy = false, inspector = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean; busy?: boolean; inspector?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const [modalMode, setModalMode] = useState(!inspector);
  const [closing, setClosing] = useState(false);
  const backRequested = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function requestClose() {
    if (busy || closing || closeTimer.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    setClosing(true); closeTimer.current = setTimeout(onClose, 180);
  }
  useEffect(() => { onCloseRef.current = requestClose; busyRef.current = busy || closing; });
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const marker = `fleet-dialog-${crypto.randomUUID()}`;
    backRequested.current = false;
    // A dialog-to-dialog transition owns one history entry. Defer the previous
    // dialog's rollback so the new dialog can take ownership in this render.
    const nextState = { ...window.history.state, fleetDialog: marker };
    if (window.history.state?.fleetDialog) window.history.replaceState(nextState, "");
    else window.history.pushState(nextState, "");
    const pop = () => {
      if (window.history.state?.fleetDialog === marker) return;
      if (busyRef.current) { window.history.pushState({ ...window.history.state, fleetDialog: marker }, ""); return; }
      backRequested.current = true; onCloseRef.current();
    };
    const viewport = window.visualViewport;
    const size = () => { if (viewport) ref.current?.style.setProperty("--fleet-viewport-height", `${viewport.height}px`); };
    size(); viewport?.addEventListener("resize", size); window.addEventListener("popstate", pop);
    return () => { viewport?.removeEventListener("resize", size); window.removeEventListener("popstate", pop); if (!backRequested.current) setTimeout(() => { if (window.history.state?.fleetDialog === marker) window.history.back(); }, 0); };
  }, [titleId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    const media = window.matchMedia("(max-width: 1100px)");
    let isModal = !inspector || media.matches;
    const updateMode = () => { isModal = !inspector || media.matches; setModalMode(isModal); document.body.style.overflow = isModal ? "hidden" : previousOverflow; };
    updateMode(); media.addEventListener("change", updateMode);
    ref.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
      if (event.key !== "Tab" || !ref.current || !isModal) return;
      const elements = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(e => e.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; media.removeEventListener("change", updateMode); document.removeEventListener("keydown", keydown); previous?.focus({ preventScroll: true }); };
  }, [inspector]);
  return <div className={`modal-backdrop ${inspector ? "inspector-backdrop" : ""} ${closing ? "is-closing" : ""}`} onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal={modalMode || undefined} aria-labelledby={titleId} className={`modal ${wide ? "modal-wide" : ""} ${inspector ? "reading-inspector" : ""}`}><header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className={`icon-button ${inspector ? "inspector-back" : ""}`} aria-label={inspector ? "返回任务列表" : "关闭"} onClick={requestClose} disabled={busy || closing}>{inspector ? <ArrowLeft size={21}/> : <X size={21} />}</button></header>{children}</div></div>;
}
