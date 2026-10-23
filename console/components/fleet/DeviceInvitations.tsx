"use client";

import { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw, X } from "lucide-react";
import { ApiError, api, errorText, mutation, time } from "./api";
import { invitationState } from "./device-onboarding";
import type { DeviceInvitation, InvitationPage } from "./device-onboarding";
import { Busy, Modal, Notice } from "./ui";

export default function DeviceInvitations({ onClose, onAdd, onChanged }: { onClose: () => void; onAdd: () => void; onChanged: () => void }) {
  const [filter, setFilter] = useState("pending"); const [items, setItems] = useState<DeviceInvitation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [mutationError, setMutationError] = useState(""); const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(""); const [revision, setRevision] = useState(0); const generation = useRef(0);
  const pageDepth = useRef(1); const loadingMore = useRef(false);
  useEffect(() => {
    const current = ++generation.current; let alive = true; let timer: ReturnType<typeof setTimeout>;
    setItems([]); setCursor(null); pageDepth.current = 1; setTotal(0); setLoading(true); setError(""); setConfirm("");
    async function load() {
      try {
        if (loadingMore.current) return;
        const depth = pageDepth.current; let result: InvitationPage = { invites: [], total: 0 }; const collected: DeviceInvitation[] = []; let next: string | null = null;
        for (let page = 0; page < depth; page++) {
          result = await api<InvitationPage>(`/api/console/invites?status=${filter}&limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
          collected.push(...result.invites); next = result.nextCursor || null; if (!next) break;
        }
        if (!alive || current !== generation.current) return;
        if (!loadingMore.current && depth === pageDepth.current) { setItems(collected); setCursor(next); setTotal(result.total); setError(""); }
      } catch (err) { if (alive) setError(errorText(err)); }
      finally { if (alive) { setLoading(false); timer = setTimeout(load, document.hidden ? 30000 : 10000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [filter, revision]);
  async function more() {
    if (!cursor || loadingMore.current) return;
    const current = generation.current; loadingMore.current = true; setLoading(true); setError("");
    try {
      const result = await api<InvitationPage>(`/api/console/invites?status=${filter}&limit=30&cursor=${encodeURIComponent(cursor)}`);
      if (current !== generation.current) return;
      setItems(previous => [...previous, ...result.invites.filter(item => !previous.some(old => old.id === item.id))]); setCursor(result.nextCursor || null); pageDepth.current += 1; setTotal(result.total);
    } catch (err) { if (current === generation.current) setError(errorText(err)); }
    finally { loadingMore.current = false; if (current === generation.current) setLoading(false); }
  }
  async function revoke(item: DeviceInvitation) {
    if (busy) return; setBusy(item.id); setMutationError("");
    try { await mutation(`/api/console/invites/${encodeURIComponent(item.id)}`, {}, "DELETE"); setConfirm(""); setRevision(value => value + 1); onChanged(); }
    catch (err) { setMutationError(err instanceof ApiError && err.status === 404 ? "这份邀请已不存在，请刷新接入记录。" : err instanceof ApiError && err.code === "INVITATION_ALREADY_USED" ? "邀请已接入设备，不能撤销；请在设备资料中管理这台电脑。" : errorText(err)); setRevision(value => value + 1); }
    finally { setBusy(""); }
  }
  return <Modal title="电脑接入记录" onClose={onClose} busy={!!busy} wide><div className="form-body invitation-manager">
    <div className="invitation-list-toolbar"><label>接入状态<select aria-label="邀请状态筛选" value={filter} onChange={event => { setMutationError(""); setFilter(event.target.value); }} disabled={!!busy}><option value="pending">等待接入</option><option value="enrolled">已接入</option><option value="expired">已过期</option><option value="revoked">已撤销</option><option value="all">全部记录</option></select></label><button className="text-button" onClick={() => { setMutationError(""); setRevision(value => value + 1); }} disabled={!!busy}><RefreshCw size={14} />刷新</button><button className="button primary small" onClick={onAdd} disabled={!!busy}>添加电脑</button></div>
    {error && <Notice>{error}</Notice>}{mutationError && <Notice>{mutationError}</Notice>}
    <div className="invitation-records">{items.map(item => { const state = invitationState(item); return <article className="invitation-record" key={item.id}><div className="invitation-record-heading"><Monitor size={18} /><div><strong>{item.displayName || item.name}</strong><small>{item.name} · {(item.status === "enrolled" && item.node ? item.node.groupName : item.groupName) || "未分组"}</small></div><span className={`status status-${state.tone}`}>{state.label}</span></div><div className="invitation-record-meta"><span>{item.status === "enrolled" ? (item.usedAt ? `接入于 ${time(item.usedAt)}` : "接入时间未记录") : `有效期至 ${time(item.expires)}`}</span>{item.node?.version && <span>节点 {item.node.version}</span>}</div>{confirm === item.id ? <div className="invitation-revoke-confirm"><p>撤销 {item.name} 的邀请？仅使这份邀请失效，不会删除设备。</p><div><button className="text-button" onClick={() => setConfirm("")} disabled={!!busy}>保留邀请</button><button className="button secondary small danger-text" disabled={!!busy} onClick={() => void revoke(item)}>{busy === item.id ? <Busy /> : "确认撤销邀请"}</button></div></div> : ["pending", "expired"].includes(item.status) && <button className="text-button invitation-revoke" aria-label={`撤销 ${item.name} 邀请`} disabled={!!busy} onClick={() => setConfirm(item.id)}><X size={13} />撤销邀请</button>}</article>; })}</div>
    {!items.length && <div className="quiet-empty">{loading ? "正在读取接入记录" : error ? "接入记录尚未读取" : "此状态下暂无接入记录"}</div>}<div className="invitation-list-footer"><span>{items.length} / {total} 条记录</span>{cursor && <button className="button secondary small" onClick={() => void more()} disabled={loading || !!busy}>{loading ? <Busy /> : "加载更多"}</button>}</div><p className="field-hint">邀请文件仅在生成时提供；已接入电脑的在线状态以节点回报为准。</p>
  </div></Modal>;
}
