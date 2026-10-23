"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowDownUp, ArrowUp, Bot, Check, Copy, MessageSquare, UserRound, Wrench } from "lucide-react";
import { time } from "./api";
import MessageText from "./MessageText";

export type ReadingEntry = { id: string; role: "user" | "assistant" | "tool" | "system"; actor: string; text: string; at?: string | number; label?: string };
const ROLE_LABELS = { user: "用户", assistant: "Codex", tool: "工具", system: "状态" };
type Position = { top: number; latest: boolean; anchor?: string; offset?: number };

function Message({ entry, expanded, newest, expansion }: { entry: ReadingEntry; expanded: boolean; newest: boolean; expansion: {open:boolean;version:number} }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [open, setOpen] = useState(expanded);
  useEffect(() => { if (expansion.version) setOpen(expansion.open); }, [expansion]);
  const Icon = entry.role === "tool" ? Wrench : entry.role === "assistant" ? Bot : entry.role === "user" ? UserRound : MessageSquare;
  const long = entry.text.length > (entry.role === "tool" ? 120 : 700) || entry.text.split("\n").length > 10;
  async function copy() {
    try { await navigator.clipboard.writeText(entry.text); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  return <article data-message-id={entry.id} className={`reading-entry reading-${entry.role}`}>
    <header><span className="reading-role"><Icon size={13} />{ROLE_LABELS[entry.role]}</span><strong>{entry.actor}</strong>{newest && <span className="reading-newest">最新</span>}<time title={entry.at ? new Date(entry.at).toLocaleString("zh-CN") : undefined}>{entry.at ? time(entry.at) : "时间未同步"}</time><button type="button" className="reading-copy" aria-label={copied ? "消息已复制" : "复制消息"} title={copied ? "已复制" : "复制消息"} onClick={() => void copy()} onBlur={() => setCopied(false)}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></header>
    {entry.label && <small className="reading-label">{entry.label}</small>}
    {long ? <details className="reading-long-content" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span>{open ? `${entry.text.length.toLocaleString()} 字符` : `${entry.text.slice(0, 180)}…`}</span><em>{open ? "收起" : "展开全文"}</em></summary>{open && <MessageText text={entry.text} />}</details> : <MessageText text={entry.text} />}
    {copyError && <small role="status" className="quiet-hint">浏览器未允许复制，可选择文字后复制。</small>}
  </article>;
}

export default function MessageFeed({ entries, followSignal = 0, emptyText = "尚无公开消息" }: { entries: ReadingEntry[]; followSignal?: number; emptyText?: string }) {
  const [filter, setFilter] = useState("conversation");
  const [newestFirst, setNewestFirst] = useState(false);
  const [query, setQuery] = useState("");
  const [expansion, setExpansion] = useState({open:false,version:0});
  const [unread, setUnread] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<Position>({ top: 0, latest: true });
  const followed = useRef(followSignal);
  const previous = useRef<Map<string, string> | null>(null);
  const selection = useRef("");
  const chronological = useMemo(() => entries.map((entry, index) => ({ entry, index, at: entry.at ? new Date(entry.at).getTime() : 0 }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0) || a.index - b.index).map(item => item.entry), [entries]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const values = chronological.filter(entry => (filter === "all" || filter === "conversation" && ["user", "assistant"].includes(entry.role) || filter === entry.role) && (!needle || `${entry.text} ${entry.actor} ${entry.label || ""}`.toLocaleLowerCase().includes(needle)));
    return newestFirst ? values.reverse() : values;
  }, [chronological, filter, newestFirst, query]);
  const newestId = newestFirst ? visible[0]?.id : visible.at(-1)?.id;
  const latestAnswer = [...chronological].reverse().find(entry => entry.role === "assistant")?.id;
  function remember() {
    const element = scroll.current; if (!element) return;
    const top = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find(item => item.getBoundingClientRect().bottom > top + 1);
    const latest = newestFirst ? element.scrollTop < 32 : element.scrollHeight - element.clientHeight - element.scrollTop < 32;
    position.current = { top: element.scrollTop, latest, anchor: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
    if (latest) setUnread(0);
  }
  function latest() {
    const element = scroll.current; if (!element) return;
    element.scrollTop = newestFirst ? 0 : element.scrollHeight;
    remember(); setUnread(0);
  }
  useLayoutEffect(() => {
    const element = scroll.current; if (!element) return;
    const currentSelection = `${filter}:${newestFirst}:${query}`;
    const changedSelection = selection.current !== currentSelection;
    const forced = followed.current !== followSignal;
    const updated = previous.current ? visible.filter(entry => previous.current!.get(entry.id) !== entry.text).length : 0;
    if (changedSelection) { element.scrollTop = query.trim() || newestFirst ? 0 : element.scrollHeight; setUnread(0); }
    else if (forced || position.current.latest) { element.scrollTop = newestFirst ? 0 : element.scrollHeight; setUnread(0); }
    else {
      const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find(item => item.dataset.messageId === position.current.anchor);
      element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - (position.current.offset || 0) : position.current.top;
      if (updated) setUnread(count => count + updated);
    }
    previous.current = new Map(visible.map(entry => [entry.id, entry.text]));
    selection.current = currentSelection; followed.current = followSignal;
    remember();
    // Keep the same visible message when a polling update prepends new content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, followSignal, filter, newestFirst, query]);
  return <div className="message-reader">
    <div className="message-reader-toolbar"><div role="group" aria-label="消息类型筛选">{[["conversation", "对话"], ["tool", "工具"], ["system", "状态"], ["all", "全部"]].map(([value, label]) => <button type="button" key={value} className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><button type="button" className="message-sort" aria-label="切换消息排序" onClick={() => setNewestFirst(value => !value)}><ArrowDownUp size={13} />{newestFirst ? "最新在前" : "时间正序"}</button></div>
    <div className="message-search"><input type="search" aria-label="搜索已同步消息" placeholder="搜索已同步消息" value={query} onChange={event=>setQuery(event.target.value)}/>{query && <button className="text-button" onClick={()=>setQuery("")}>清除搜索</button>}</div>
    <div className="message-reader-meta"><span>{query.trim() ? "匹配" : "已同步"} {visible.length} 条</span><button type="button" className="text-button" disabled={!visible.length} onClick={()=>setExpansion(value=>({open:!value.open,version:value.version+1}))}>{expansion.open ? "收起长消息" : "展开长消息"}</button><button type="button" className="text-button" onClick={latest} disabled={!visible.length}>{newestFirst ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{unread ? `${unread} 条更新` : "最新消息"}</button></div>
    <div className="message-stream" ref={scroll} onScroll={remember} role="region" aria-label="公开消息记录" tabIndex={0}>
      {visible.length ? visible.map(entry => <Message key={entry.id} entry={entry} newest={entry.id === newestId} expanded={entry.id === latestAnswer} expansion={expansion} />) : <p className="quiet-empty">{query.trim() ? "没有匹配的消息" : entries.length ? "此类暂无记录" : emptyText}</p>}
    </div>
  </div>;
}
