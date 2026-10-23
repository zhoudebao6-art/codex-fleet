"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Monitor, RefreshCw } from "lucide-react";
import { ApiError, api, bytes, errorText, mutation, time } from "./api";
import type { DeviceGroup, GroupAccess } from "./types";
import { Busy, Modal, Notice } from "./ui";
import GroupAccessEditor from "./GroupAccessEditor";
import { deploymentPrompt, downloadOnboardingFile, invitationState } from "./device-onboarding";
import type { DeviceInvitation, Installer, InvitationPackage, InvitationPage } from "./device-onboarding";
export type { Installer } from "./device-onboarding";

export function useInstaller() {
  const [installer, setInstaller] = useState<Installer | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  useEffect(() => { let alive = true; setLoading(true); setError(""); void api<Installer | null>("/api/console/installer").then(value => { if (alive) setInstaller(value); }).catch(err => { if (alive) setError(errorText(err)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [revision]);
  return { installer, error, loading, refresh: () => setRevision(value => value + 1) };
}

export default function DeviceInvite({ onClose, suggestedCode, groups, groupsError, onRecords, onCreated }: { onClose: () => void; suggestedCode: string; groups: DeviceGroup[]; groupsError: string; onRecords: () => void; onCreated: () => void }) {
  const [code, setCode] = useState(suggestedCode); const [name, setName] = useState(""); const [groupId, setGroupId] = useState(""); const [projects, setProjects] = useState("workspace");
  const [suggestionError, setSuggestionError] = useState(""); const [suggestionLoading, setSuggestionLoading] = useState(true); const [suggestionRevision, setSuggestionRevision] = useState(0); const codeEdited = useRef(false); const codeSubmitted = useRef(false);
  const [consoleRole, setConsoleRole] = useState<"operator" | "viewer">("operator"); const [consoleAccess, setConsoleAccess] = useState<GroupAccess>({ mode: "groups", groupIds: ["__ungrouped__"] }); const scopeEdited = useRef(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [uncertain, setUncertain] = useState(false); const [result, setResult] = useState<InvitationPackage | null>(null);
  const [installerSnapshot, setInstallerSnapshot] = useState<Installer | null>(null); const [stage, setStage] = useState(0); const [copied, setCopied] = useState(false); const [copyError, setCopyError] = useState(""); const [showPrompt, setShowPrompt] = useState(false);
  const [status, setStatus] = useState<DeviceInvitation | null>(null); const [statusError, setStatusError] = useState(""); const [statusTime, setStatusTime] = useState(""); const [statusRevision, setStatusRevision] = useState(0); const [statusLoading, setStatusLoading] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null); const createdRef = useRef(onCreated); createdRef.current = onCreated;
  const { installer, error: installerError, loading, refresh: refreshInstaller } = useInstaller();
  const validInstaller = !!installer && /^[a-f\d]{64}$/i.test(installer.sha256) && /^[\w.-]+\.zip$/i.test(installer.name) && /^\d+\.\d+\.\d+$/.test(installer.version);
  const tracked = status || result; const state = tracked ? invitationState(tracked) : null;
  const unusable = tracked && (["revoked", "expired"].includes(tracked.status) || tracked.status === "pending" && Date.parse(tracked.expires) <= Date.now());
  const prompt = result && installerSnapshot ? deploymentPrompt(status || result, installerSnapshot, result.hubUrl) : "";
  useEffect(() => {
    let alive = true; setSuggestionLoading(true); setSuggestionError("");
    void api<InvitationPage>("/api/console/invites?status=pending&limit=1").then(value => {
      if (!/^PC-\d{2,}$/.test(value.suggestedCode || "")) throw new Error("Invalid device code suggestion");
      if (alive && !codeEdited.current && !codeSubmitted.current) setCode(value.suggestedCode!);
    }).catch(() => { if (alive) setSuggestionError("设备代号建议读取失败，当前代号已保留。"); }).finally(() => { if (alive) setSuggestionLoading(false); });
    return () => { alive = false; };
  }, [suggestionRevision]);
  useEffect(() => {
    if (!result?.id) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setStatusLoading(true);
      try { const next = await api<DeviceInvitation>(`/api/console/invites/${encodeURIComponent(result!.id)}`); if (alive) { setStatus(next); setStatusError(""); setStatusTime(new Date().toISOString()); } }
      catch (err) { if (alive) setStatusError(err instanceof ApiError && err.status === 404 ? "这份邀请已不存在，请查看接入记录。" : errorText(err)); }
      finally { if (alive) { setStatusLoading(false); timer = setTimeout(load, document.hidden ? 20000 : 5000); } }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [result?.id, statusRevision]);
  function selectGroup(value: string) { setGroupId(value); if (!scopeEdited.current) setConsoleAccess({ mode: "groups", groupIds: [value || "__ungrouped__"] }); }
  async function create() {
    if (busy || uncertain || suggestionLoading || !validInstaller || groupsError) return;
    if (!/^PC-\d{2,}$/i.test(code.trim())) { setError("请使用 PC-01 这样的设备代号。"); return; }
    const allowedProjects = [...new Set(projects.split(/[,，\n]/).map(project => project.trim()).filter(Boolean))];
    if (!allowedProjects.length || allowedProjects.some(project => !/^[A-Za-z0-9_-]{1,80}$/.test(project))) { setError("项目代号仅支持字母、数字、下划线和短横线。"); return; }
    codeSubmitted.current = true; setBusy(true); setError("");
    try {
      const next = await mutation<InvitationPackage>("/api/console/invites", { name: code.trim().toUpperCase(), displayName: name.trim() || null, groupId: groupId || null, projects: allowedProjects, hours: 24, consoleRole, consoleAccess });
      if (!next.id || !next.token || !next.hubUrl || !next.name) throw new Error("邀请返回信息不完整，请先核实接入记录。");
      setResult({ ...next, status: next.status || "pending", groupName: next.groupName || groups.find(group => group.id === groupId)?.name || null }); setInstallerSnapshot(installer); setStage(1); createdRef.current();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) { setUncertain(true); setError("生成结果尚未确认，请先查看接入记录。若已存在同代号邀请，撤销后再重新生成。"); }
      else setError(err.code === "INVITATION_GROUP_CHANGED" ? "所选分组已发生变化，请关闭后重新选择分组。" : err.status === 409 ? "这个代号已有设备或有效邀请，请先查看接入记录。" : errorText(err));
    } finally { setBusy(false); }
  }
  async function copyPrompt() {
    if (!prompt) return; setCopied(false); setCopyError("");
    try { await navigator.clipboard.writeText(prompt); setCopied(true); }
    catch { setShowPrompt(true); setCopyError("自动复制不可用，请在下方选择全文复制，或下载命令词。"); }
  }
  function selectPrompt() { promptRef.current?.focus(); promptRef.current?.select(); }
  return <Modal title="添加电脑" onClose={onClose} busy={busy}><div className="form-body device-invite-form">
    <ol className="onboarding-steps" aria-label="接入步骤">{["设备与权限", "准备安装", "确认接入"].map((label, index) => <li key={label} className={stage === index ? "current" : stage > index ? "done" : ""} aria-current={stage === index ? "step" : undefined}><span>{stage > index ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol>
    {error && <Notice>{error}</Notice>}{groupsError && !result && <Notice>业务分组：{groupsError}</Notice>}
    {!result ? <>
      <div className="invite-step-heading"><Monitor size={19} /><span>新电脑将保留自己的 Codex 登录与技能</span><code>{code}</code></div>
      <label>业务分组<select aria-label="邀请业务分组" value={groupId} onChange={event => selectGroup(event.target.value)} disabled={busy || uncertain || !!groupsError}><option value="">未分组</option>{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
      <label>设备名称<input aria-label="新设备名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：异地设计电脑" maxLength={120} disabled={busy || uncertain} /><span className="field-hint">可填中文，稳定代号为 {code}。</span></label>
      <section className="invite-console-scope"><h3>免登录后的网页权限</h3><label>网页角色<select aria-label="新电脑网页角色" value={consoleRole} onChange={event => setConsoleRole(event.target.value as "operator" | "viewer")} disabled={busy || uncertain}><option value="operator">操作员 · 派任务、传文件</option><option value="viewer">只读成员 · 查看状态和结果</option></select></label><GroupAccessEditor label="免登录可见设备" value={consoleAccess} groups={groups} onChange={next => { scopeEdited.current = true; setConsoleAccess(next); }} disabled={busy || uncertain} error={groupsError} /></section>
      <details className="advanced-options"><summary>设备代号与项目权限</summary><label>设备代号<input aria-label="新设备代号" value={code} onChange={event => { codeEdited.current = true; setCode(event.target.value.toUpperCase()); }} placeholder="PC-04" maxLength={20} disabled={busy || uncertain} /></label><label>允许使用的项目<input value={projects} onChange={event => setProjects(event.target.value)} placeholder="workspace" disabled={busy || uncertain} /><span className="field-hint">多个项目用逗号分隔。</span></label></details>
      {suggestionError && <Notice>{suggestionError}<button className="inline-link" disabled={busy || uncertain || suggestionLoading} onClick={() => setSuggestionRevision(value => value + 1)}>重新读取代号</button></Notice>}
      {installerError && <Notice>安装包：{installerError}<button className="inline-link" onClick={refreshInstaller}>重新读取</button></Notice>}{!loading && !installerError && !validInstaller && <Notice>暂无有效安装包，请先登记节点包。</Notice>}
      <footer className="modal-footer"><button className="button secondary" onClick={uncertain || error ? onRecords : onClose} disabled={busy}>{uncertain || error ? "查看接入记录" : "取消"}</button><button className="button primary" disabled={!code.trim() || !projects.trim() || busy || uncertain || suggestionLoading || !!groupsError || !validInstaller || loading} onClick={() => void create()}>{busy ? <Busy /> : loading ? "读取安装包…" : suggestionLoading ? "读取设备代号…" : "生成接入邀请"}</button></footer>
    </> : <>
      <div className="onboarding-identity"><Monitor size={22} /><div><strong>{tracked?.displayName || result.name}</strong><small>{result.name} · {tracked?.groupName || "未分组"}</small></div><span className={`status status-${statusError ? "neutral" : state!.tone}`}>{statusError ? "状态待更新" : state!.label}</span></div>
      {stage === 1 && <>
        <p className="onboarding-lead">把节点包和独立邀请发到目标电脑，再把命令词交给那台电脑的 Codex。</p>
        <div className="installer-downloads">{installerSnapshot && <a className="button primary" href={installerSnapshot.downloadUrl} download={installerSnapshot.name}><Download size={15} />节点包 {installerSnapshot.version}</a>}<button className="button secondary" disabled={!!unusable} onClick={() => downloadOnboardingFile(`${result.name}.invite.json`, JSON.stringify(result, null, 2), "application/json")}><Download size={15} />独立邀请</button></div>
        <div className="onboarding-package"><span>{installerSnapshot?.name} · {bytes(installerSnapshot?.size || 0)}</span><details><summary>SHA256 校验值</summary><code>{installerSnapshot?.sha256}</code></details></div>
        <p className="field-hint">邀请有效至 {time(result.expires)}，仅本次可下载，离开前请保存。已有节点会保留原身份。</p>
        <div className="onboarding-prompt-actions"><button className="button primary" onClick={() => void copyPrompt()} disabled={!!unusable}><Copy size={15} />{copied ? "命令词已复制" : "复制 Codex 部署命令词"}</button><button className="button secondary" onClick={() => downloadOnboardingFile(`${result.name}-Codex部署命令词.txt`, prompt)} disabled={!!unusable}><Download size={15} />下载命令词</button></div>
        {copyError && <Notice>{copyError}</Notice>}<details className="onboarding-prompt" open={showPrompt} onToggle={event => setShowPrompt(event.currentTarget.open)}><summary>查看完整命令词</summary><textarea ref={promptRef} readOnly aria-label="完整 Codex 部署命令词" rows={12} value={prompt} /><button className="text-button" onClick={selectPrompt}>选择全文</button></details>
        {unusable && <Notice>这份邀请已失效，请在接入记录中核实后重新生成。</Notice>}
      </>}
      {stage === 2 && <div className="onboarding-status"><strong>{statusError ? "暂时无法确认最新状态" : state!.detail}</strong><ol>{["邀请已生成", "设备已登记", "设备已连接", "Codex 已就绪", "桌面联动与项目同步"].map((label, index) => <li key={label} className={!statusError && state!.step >= index + 1 ? "complete" : ""}>{!statusError && state!.step >= index + 1 ? <Check size={15} /> : <span className="status-step-dot" />}{label}</li>)}</ol>{tracked?.node?.version && <p>节点 {tracked.node.version} · 最近连接 {time(tracked.node.lastSeen)}</p>}{tracked?.node?.online && <p>项目同步：{tracked.node.workspaceState === "synced" ? `${tracked.node.workspaceCount ?? 0} 个工作空间` : "同步中或待检查"} · 桌面联动：{tracked.node.desktopLinked ? "已连接" : "待从联动入口启动"}</p>}{statusError && <Notice>{statusError}</Notice>}<div className="onboarding-sync"><span>{statusTime ? `最近核实 ${time(statusTime)}` : "等待读取状态"}</span><button className="text-button" disabled={statusLoading} onClick={() => setStatusRevision(value => value + 1)}><RefreshCw size={13} className={statusLoading ? "spin" : ""} />刷新状态</button></div><p className="field-hint">此状态每 5 秒更新。脚本结束后仍未连接，可把部署命令词交给目标电脑继续检查。</p></div>}
      <footer className="modal-footer"><button className="button secondary" onClick={stage === 2 ? () => setStage(1) : onRecords}>{stage === 2 ? "返回安装步骤" : "查看接入记录"}</button>{stage === 1 ? <button className="button primary" onClick={() => setStage(2)}>查看接入状态</button> : <button className="button primary" onClick={onClose}>{!statusError && state!.step === 5 ? "完成" : "稍后继续查看"}</button>}</footer>
    </>}
  </div></Modal>;
}
