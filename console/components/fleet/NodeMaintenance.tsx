"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { api, bytes, errorText, mutation, time, uid } from "./api";
import type { FleetNode } from "./types";
import { useInstaller } from "./DeviceInvite";
import { deviceLabel } from "./device-utils";
import { Busy, Notice } from "./ui";

type UpgradeAction = { id: string; nodeId: string; action: "upgrade"; status: "queued" | "downloading" | "waiting" | "installing" | "completed" | "failed"; installer: { version: string; sha256: string; size: number; name: string; project: string }; bytes?: number; detail?: string; createdAt: string; updatedAt: string };
const LABELS = { queued: "已排队", downloading: "下载安装包", waiting: "等待本机空闲", installing: "正在安装", completed: "升级完成", failed: "升级未完成" };
const ACTIVE = new Set(["queued", "downloading", "waiting", "installing"]);
function compareVersion(current: string, published: string) {
  if (!/^\d+\.\d+\.\d+$/.test(current) || !/^\d+\.\d+\.\d+$/.test(published)) return null;
  const a = current.split(".").map(Number), b = published.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export default function NodeMaintenance({ node, canAdmin }: { node: FleetNode; canAdmin: boolean }) {
  const { installer, error: installerError, loading } = useInstaller(); const [actions, setActions] = useState<UpgradeAction[]>([]); const [error, setError] = useState(""); const [syncError, setSyncError] = useState(""); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false); const [revision, setRevision] = useState(0); const requestId = useRef<string | null>(null);
  const supported = node.capabilities?.selfUpgrade === true; const currentVersion = String(node.capabilities?.version || "未知");
  const versionOrder = installer ? compareVersion(currentVersion, installer.version) : null;
  const active = actions.find(action => ACTIVE.has(action.status)); const latest = active || actions[0];
  useEffect(() => {
    if (!canAdmin) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() { try { const result = await api<{ actions: UpgradeAction[] }>(`/v1/nodes/${encodeURIComponent(node.id)}/actions`); if (alive) { setActions(result.actions); setSyncError(""); if (requestId.current && result.actions.some(action => action.id === requestId.current)) requestId.current = null; } } catch (err) { if (alive) setSyncError(errorText(err)); } finally { if (alive) timer = setTimeout(load, document.hidden ? 30000 : 5000); } }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [node.id, canAdmin, revision]);
  async function upgrade(repair = false) {
    if (!canAdmin || !supported || !installer || busy || active) return;
    if (versionOrder === 1 || (versionOrder === 0 && !repair)) return;
    if (!requestId.current) requestId.current = uid(); setBusy(true); setError("");
    try { const action = await mutation<UpgradeAction>(`/v1/nodes/${encodeURIComponent(node.id)}/upgrade`, { id: requestId.current }); requestId.current = null; setActions(previous => [action, ...previous.filter(item => item.id !== action.id)]); setRevision(value => value + 1); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function copy() {
    const text = `请为这台已接入 Codex Fleet 的 Windows 电脑启用自动维护。设备为 ${deviceLabel(node)}，协作台 ${window.location.origin}。使用我从本站下载的节点包${installer ? ` ${installer.name}，版本 ${installer.version}，SHA256 ${installer.sha256}` : ""}，先校验包并检查当前节点安装路径，再按包内 scripts\\Update-Fleet.ps1 的参数说明在原目录升级。保留节点身份、已登录的 Codex、技能、工具、项目与任务队列，不另装第二份，不重新生成邀请。若本机有执行中的任务，等节点空闲再升级。完成后检查网站节点上线、版本与 selfUpgrade 自动维护能力；不要把密钥或配置凭据贴到聊天。`;
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setError("复制失败，请重新尝试。"); }
  }
  return <section className="node-maintenance"><div className="node-maintenance-heading"><h3>节点维护</h3>{canAdmin && <button className="text-button" aria-label="刷新节点维护" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />刷新</button>}</div>
    <div className="maintenance-version"><span>本机 {currentVersion}</span><span>{installer ? `发布包 ${installer.version}` : loading ? "读取发布包…" : "暂无已登记安装包"}</span></div>
    {installerError && <Notice>{installerError}</Notice>}{syncError && <Notice>{syncError}</Notice>}{error && <Notice>{error}</Notice>}
    {supported ? <><p className="field-hint">{versionOrder === 0 ? "已是最新发布版本。" : versionOrder === 1 ? "当前版本高于发布包，保留当前版本。" : "节点将下载校验发布包，空闲时在原目录升级。"}</p>{canAdmin && <button className="button secondary small" disabled={busy || !!active || !installer || versionOrder === 0 || versionOrder === 1} onClick={() => void upgrade()}>{busy ? <Busy>提交升级</Busy> : active ? "升级请求处理中" : versionOrder === 0 ? "已是最新版本" : versionOrder === 1 ? "无需更新" : latest?.status === "failed" ? "重新发起升级" : "升级节点"}</button>}{canAdmin && versionOrder === 0 && <details className="advanced-options"><summary>修复安装</summary><p className="field-hint">仅在节点文件需要修复时，重新安装同一版本；保留身份和任务数据。</p><button className="button secondary small" disabled={busy || !!active} onClick={() => void upgrade(true)}>重新安装当前版本</button></details>}{!canAdmin && <p className="field-hint">由管理员发起节点升级。</p>}</> : <><p className="maintenance-first">首次接入自动维护需本地升级一次</p><div className="maintenance-downloads">{installer && <a className="button secondary small" href={installer.downloadUrl} download={installer.name}><Download size={15} />下载 {installer.version}</a>}{installer && <button className="button secondary small" onClick={() => void copy()}><Copy size={14} />{copied ? "已复制" : "复制升级命令词"}</button>}</div></>}
    {latest && <div className={`maintenance-action ${latest.status === "failed" ? "is-error" : ""}`} role="status"><div><strong>{LABELS[latest.status]}</strong><span>{latest.installer.version}</span></div><p>{latest.detail || (latest.status === "queued" && !node.online ? "设备离线，联网后处理。" : latest.status === "queued" ? "等待节点接收。" : latest.status === "completed" ? "新节点已回报匹配的版本和安装包。" : "等待节点回报。")}</p>{latest.status === "downloading" && typeof latest.bytes === "number" && latest.installer.size > 0 && <><progress value={Math.max(0, Math.min(latest.bytes, latest.installer.size))} max={latest.installer.size} /><small>{bytes(latest.bytes)} / {bytes(latest.installer.size)}</small></>}<time>{time(latest.updatedAt)}</time></div>}
  </section>;
}
