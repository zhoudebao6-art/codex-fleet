"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleHelp, RefreshCw, X } from "lucide-react";
import { api, errorText, mutation, time } from "./api";
import { Busy, Notice } from "./ui";

type SchemaProperty = { type?: string; title?: string; description?: string; enum?: (string | number | boolean)[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; format?: string; [key: string]: unknown };
type FormSchema = { type?: string; properties?: Record<string, SchemaProperty>; required?: string[]; [key: string]: unknown };
type Question = { id: string; header?: string; question?: string; isSecret?: boolean; isOther?: boolean; options?: { label: string; description?: string }[] };
type Interaction = { id: string; taskId: string; kind: string; method?: string; status: string; expiresAt?: string; createdAt?: string; request: { message?: string; requestedSchema?: FormSchema; questions?: Question[]; command?: string | string[]; reason?: string; cwd?: string; serverName?: string; mode?: string; url?: string; display?: string }; response?: unknown; answeredAt?: string; resolvedAt?: string };

function schemaFields(schema?: FormSchema) {
  if (!schema || schema.unsupported || schema.type !== "object" || !schema.properties || Array.isArray(schema.properties)) return null;
  if (Object.keys(schema).some(key => ["oneOf", "anyOf", "allOf", "$ref", "if", "then", "else", "dependentSchemas", "patternProperties"].includes(key))) return null;
  const fields = Object.entries(schema.properties);
  if (fields.length > 30 || fields.some(([name, value]) => !name || !value || value.unsupported || value.const !== undefined || !["string", "number", "integer", "boolean"].includes(value.type || "") || (value.format && !["email", "uri"].includes(value.format)) || Object.keys(value).some(key => ["oneOf", "anyOf", "allOf", "$ref", "pattern", "not"].includes(key)) || (value.enum && (!Array.isArray(value.enum) || value.enum.some(option => !["string", "number", "boolean"].includes(typeof option)))))) return null;
  return fields;
}
function safeExternalUrl(url?: string) { if (!url) return null; try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null; } catch { return null; } }

function InteractionCard({ item, canWrite, onChanged }: { item: Interaction; canWrite: boolean; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({}); const [answers, setAnswers] = useState<Record<string, string>>({});
  const [visited, setVisited] = useState(false); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(""); const [sent, setSent] = useState(false); const [error, setError] = useState(""); const [uncertain, setUncertain] = useState(false);
  const fields = schemaFields(item.request.requestedSchema); const url = safeExternalUrl(item.request.url);
  const urlMode = item.request.mode === "url" || Boolean(item.request.url);
  const pending = item.status === "pending" && !sent;
  const title = item.kind === "approval" ? "确认这次操作" : item.kind === "questions" ? "补充任务信息" : "工具需要你的回复";
  const labels: Record<string, string> = { pending: "等待你处理", answered: "已发送，等待电脑确认", resolved: "电脑已处理", expired: "请求已过期", cancelled: "请求已取消" };
  const unknown = !["approval", "questions", "elicitation"].includes(item.kind);
  const unsupported = unknown || (item.kind === "elicitation" && !urlMode && !fields);
  const fieldMissing = fields?.some(([name]) => item.request.requestedSchema?.required?.includes(name) && (values[name] === undefined || values[name] === ""));
  const questions = item.request.questions || [];
  const questionMissing = !questions.length || questions.some(question => !answers[question.id]?.trim());
  const canSubmit = !unsupported && !(item.kind === "elicitation" && (urlMode ? !url || !visited || !confirmed : fieldMissing)) && !(item.kind === "questions" && questionMissing);
  function answerPayload(action: string) {
    if (item.kind === "approval") return { decision: action };
    if (item.kind === "questions") return { answers: Object.fromEntries(questions.map(question => [question.id, { answers: action === "accept" ? [answers[question.id].trim()] : [] }])) };
    if (action !== "accept" || urlMode) return { action };
    const content: Record<string, unknown> = Object.create(null);
    for (const [name, schema] of fields || []) {
      const value = values[name]; if (value === undefined || value === "") continue;
      content[name] = schema.type === "boolean" ? value === "true" : schema.type === "number" || schema.type === "integer" ? Number(value) : value;
    }
    return { action, content };
  }
  async function respond(action: string) {
    if (busy || sent || !pending || uncertain) return;
    setBusy(action); setError("");
    try { await mutation(`/v1/tasks/${encodeURIComponent(item.taskId)}/interactions/${encodeURIComponent(item.id)}/respond`, { response: answerPayload(action) }); setSent(true); onChanged(); }
    catch (err) {
      setError(errorText(err));
      // A response can reach the server even when its acknowledgement is lost.
      // Re-read the stored request before exposing another send action.
      setUncertain(true);
      try { const latest = await api<{ interactions: Interaction[] }>(`/v1/tasks/${encodeURIComponent(item.taskId)}/interactions`); const current = latest.interactions.find(value => value.id === item.id); if (current && current.status !== "pending") { setSent(true); setError(""); } else if (current?.status === "pending") setUncertain(false); onChanged(); } catch { /* The explicit refresh below retains the unsent form. */ }
    } finally { setBusy(""); }
  }
  async function recheck() {
    setBusy("refresh"); setError("");
    try { const latest = await api<{ interactions: Interaction[] }>(`/v1/tasks/${encodeURIComponent(item.taskId)}/interactions`); const current = latest.interactions.find(value => value.id === item.id); if (current) { setUncertain(false); if (current.status !== "pending") setSent(true); } onChanged(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  return <article className={`interaction-card ${pending ? "pending" : "settled"}`}><header><div><CircleHelp size={18} /><strong>{title}</strong></div><span>{sent && item.status === "pending" ? labels.answered : labels[item.status] || item.status}</span></header>
    {item.request.message && <p className="interaction-message">{item.request.message}</p>}{item.request.reason && <p className="interaction-message">{item.request.reason}</p>}
    {item.request.display && item.request.display !== item.request.message && <p className="interaction-message">{item.request.display}</p>}
    {!pending && questions.length > 0 && <div className="interaction-question-summary">{questions.map(question => <p className="interaction-message" key={question.id}>{question.question || question.header}</p>)}</div>}
    {item.request.command && <pre className="interaction-command">{Array.isArray(item.request.command) ? item.request.command.join(" ") : item.request.command}</pre>}
    {item.request.cwd && <div className="interaction-directory">执行目录：{item.request.cwd}</div>}
    {error && <Notice>{error}</Notice>}
    {pending && canWrite ? <form onSubmit={event => { event.preventDefault(); if (canSubmit) void respond("accept"); }}>
      {unsupported && <p className="interaction-help">此请求包含网站暂不支持的表单，请在该电脑上处理，或取消此请求。</p>}
      {item.kind === "elicitation" && urlMode && <div className="interaction-url">{url ? <><a className="button secondary" href={url.href} target="_blank" rel="noopener noreferrer" onClick={() => setVisited(true)}>前往 {url.hostname}<ArrowUpRight size={15} /></a><label className="interaction-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已在打开的页面完成操作</label></> : <p className="interaction-help">此链接不支持在网站中打开，请在目标电脑上处理。</p>}</div>}
      {item.kind === "elicitation" && !urlMode && fields && <div className="interaction-fields">{fields.map(([name, field]) => <label key={name}>{field.title || name}{item.request.requestedSchema?.required?.includes(name) ? " *" : ""}{field.enum ? <select value={values[name] ?? ""} required={item.request.requestedSchema?.required?.includes(name)} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))}><option value="">请选择</option>{field.enum.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : field.type === "boolean" ? <select value={values[name] ?? ""} required={item.request.requestedSchema?.required?.includes(name)} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : <input value={values[name] ?? ""} type={field.type === "number" || field.type === "integer" ? "number" : field.format === "email" ? "email" : field.format === "uri" ? "url" : "text"} required={item.request.requestedSchema?.required?.includes(name)} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength || 16000} step={field.type === "integer" ? 1 : "any"} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />}{field.description && <small>{field.description}</small>}</label>)}</div>}
      {item.kind === "questions" && <div className="interaction-fields">{questions.map(question => <fieldset key={question.id}><legend>{question.question || question.header || "请补充信息"}</legend>{question.options?.length ? <div className="interaction-options">{question.options.map(option => <label key={option.label}><input type="radio" name={`${item.id}-${question.id}`} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}</div> : null}<label><span className="visually-hidden">{question.options?.length ? "自填答案" : question.question || question.header || "答案"}</span><input type={question.isSecret ? "password" : "text"} aria-label={question.options?.length ? `自填答案：${question.question || question.header || question.id}` : question.question || question.header || "答案"} value={question.options?.some(option => option.label === answers[question.id]) ? "" : answers[question.id] || ""} maxLength={16000} placeholder={question.options?.length ? "或输入自己的答案" : "输入回答"} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></label></fieldset>)}</div>}
      {uncertain ? <div className="interaction-pending"><span>正在核实上一条回复是否送达。</span><button type="button" className="button secondary small" disabled={!!busy} onClick={() => void recheck()}><RefreshCw size={14} />核实状态</button></div> : <div className="interaction-actions"><button type="button" className="button secondary small" disabled={!!busy} onClick={() => void respond("cancel")}><X size={14} />{item.kind === "questions" ? "跳过问题" : "取消请求"}</button>{item.kind !== "questions" && <button type="button" className="button secondary small" disabled={!!busy} onClick={() => void respond("decline")}>拒绝</button>}{!unsupported && <button type="submit" className="button primary small" disabled={!!busy || !canSubmit}>{busy === "accept" ? <Busy /> : <><Check size={15} />{item.kind === "approval" ? "仅同意这一次" : item.kind === "elicitation" && urlMode ? "已完成，继续" : "发送回复"}</>}</button>}</div>}
    </form> : pending ? <p className="interaction-help">需要有操作权限的账号回复。</p> : null}
    <footer>{item.request.serverName && <span>{item.request.serverName}</span>}<time>{time(item.createdAt)}</time>{pending && item.expiresAt && <span>有效至 {time(item.expiresAt)}</span>}</footer>
  </article>;
}

export default function TaskInteractions({ taskId, canWrite }: { taskId: string; canWrite: boolean }) {
  const [items, setItems] = useState<Interaction[]>([]); const [error, setError] = useState(""); const [revision, setRevision] = useState(0); const lastTask = useRef(taskId);
  useEffect(() => {
    if (lastTask.current !== taskId) { setItems([]); lastTask.current = taskId; }
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const result = await api<{ interactions: Interaction[] }>(`/v1/tasks/${encodeURIComponent(taskId)}/interactions`); if (alive) { setItems(result.interactions); setError(""); } }
      catch (err) { if (alive) setError(errorText(err)); }
      if (alive) timer = setTimeout(load, document.hidden ? 30000 : 5000);
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [taskId, revision]);
  if (!items.length && !error) return null;
  return <section className="detail-section task-interactions"><h4>{items.some(item => item.status === "pending") ? "等待你处理" : "交互记录"}</h4>{error && <Notice>交互状态：{error}</Notice>}{items.map(item => <InteractionCard key={item.id} item={item} canWrite={canWrite} onChanged={() => setRevision(value => value + 1)} />)}</section>;
}
