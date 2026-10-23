"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Monitor, Pencil, Plus, Trash2 } from "lucide-react";
import { ApiError, api, errorText, mutation, time, uid } from "./api";
import type { DeviceGroup, FleetNode, GroupAccess } from "./types";
import { deviceCode, deviceLabel } from "./device-utils";
import { runtimeIssue } from "../../lib/fleet/runtime-readiness.mjs";
import { Busy, Modal, Notice } from "./ui";
import {RuntimeDetails} from "./RuntimeStatus";
import NodeMaintenance from "./NodeMaintenance";
import DevicePower from "./DevicePower";
import GroupAccessEditor, { emptyAccess } from "./GroupAccessEditor";

export function useDeviceGroups(enabled: boolean, revision: number) {
  const [groups, setGroups] = useState<DeviceGroup[]>([]); const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const result = await api<{ groups: DeviceGroup[] }>("/v1/device-groups"); if (alive) { setGroups(result.groups); setError(""); } }
      catch (err) { if (alive) setError(errorText(err)); }
      finally { if (alive) timer = setTimeout(load, document.hidden ? 60000 : 30000); }
    }
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [enabled, revision]);
  return { groups, error };
}

export function DeviceDetails({ node, groups, groupsError, canAdmin, canWrite=false, onClose, onSaved }: { node: FleetNode; groups: DeviceGroup[]; groupsError: string; canAdmin: boolean; canWrite?: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(node.displayName === deviceCode(node) ? "" : node.displayName || ""); const [groupId, setGroupId] = useState(node.groupId || ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [parallelLimit,setParallelLimit]=useState(node.parallelLimit||4);
  const [consoleRole, setConsoleRole] = useState<"operator" | "viewer">(node.consoleRole || "operator"); const [consoleAccess, setConsoleAccess] = useState<GroupAccess>(node.consoleAccess || emptyAccess());
  const desktop = node.capabilities?.desktop as { enabled?: boolean; at?: string; scannedAt?: string; publishedAt?: string; complete?: boolean; count?: number; error?: string; pending?: number } | undefined;
  const version = String(node.capabilities?.version || "未知"); const old = version.startsWith("0.2.");
  const accessChanged = !!node.consoleAccess && (consoleRole !== node.consoleRole || JSON.stringify(consoleAccess) !== JSON.stringify(node.consoleAccess));
  const changed = parallelLimit!==(node.parallelLimit||4) || name.trim() !== (node.displayName === deviceCode(node) ? "" : node.displayName || "") || groupId !== (node.groupId || "") || accessChanged;
  async function save() { if (!canAdmin || busy) return; setBusy(true); setError(""); try { await mutation(`/v1/nodes/${encodeURIComponent(node.id)}`, { parallelLimit,displayName: name.trim() || null, groupId: groupId || null, ...(accessChanged ? { consoleRole, consoleAccess } : {}) }, "PATCH"); onSaved(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  return <Modal title="设备资料" onClose={onClose} busy={busy}><div className="form-body device-details-form"><div className="device-detail-identity"><Monitor size={24} /><div><strong>{deviceLabel(node)}</strong></div><code>{deviceCode(node)}</code></div>
    {error && <Notice>{error}</Notice>}{groupsError && <Notice>业务分组：{groupsError}</Notice>}
    <RuntimeDetails node={node}/>
    {canAdmin ? <><label>显示名称<input aria-label="设备显示名称" placeholder="例如：研发主机" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} /><span className="field-hint">留空时显示设备代号。</span></label><label>业务分组<select aria-label="设备业务分组" value={groupId} onChange={event => setGroupId(event.target.value)} disabled={busy || !!groupsError}><option value="">未分组</option>{node.groupId && !groups.some(group => group.id === node.groupId) && <option value={node.groupId}>{node.groupName || "当前分组"}</option>}{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label></> : <div className="device-readonly-meta"><span>业务分组</span><strong>{node.groupName || "未分组"}</strong></div>}
    {canAdmin&&<label>设备执行容量<select value={parallelLimit} onChange={e=>setParallelLimit(Number(e.target.value))} disabled={busy}>{[1,2,3,4,6,8,12,16].map(n=><option key={n} value={n}>{n} 项</option>)}</select></label>}
    {canAdmin && <section className="device-console-access"><h3>免登录网页权限</h3>{node.consoleAccess && node.consoleRole ? <><label>网页角色<select aria-label="设备网页角色" value={consoleRole} onChange={event => setConsoleRole(event.target.value as "operator" | "viewer")} disabled={busy}><option value="operator">操作员 · 派任务、传文件</option><option value="viewer">只读成员 · 查看状态和结果</option></select></label><GroupAccessEditor label="免登录可见设备" value={consoleAccess} groups={groups} onChange={setConsoleAccess} disabled={busy} error={groupsError} /><p className="field-hint">决定从这台电脑免登录后可查看和操作的范围。</p></> : <p className="field-hint">网页权限尚未读取，请刷新设备资料。</p>}</section>}
    <dl className="device-health"><div><dt>节点版本</dt><dd>{version}{old && <span className="status status-amber">待升级</span>}</dd></div><div><dt>Codex</dt><dd>{runtimeIssue(node)||"已就绪"}</dd></div><div><dt>任务目录</dt><dd>{old ? "升级后同步" : desktop?.error ? "同步受阻" : desktop?.complete ? `已读取 ${desktop.count || 0} 项` : desktop?.enabled ? "同步中" : "尚未回报"}</dd></div><div><dt>最近连接</dt><dd>{time(node.lastSeen || node.last_seen)}</dd></div><div><dt>最近目录同步</dt><dd>{time(desktop?.publishedAt || desktop?.scannedAt || desktop?.at)}</dd></div></dl>
    {desktop?.error && <Notice>{desktop.error}</Notice>}<DevicePower node={node} canAdmin={canAdmin} canWrite={canWrite||canAdmin}/><NodeMaintenance node={node} canAdmin={canAdmin} />
    <footer className="modal-footer"><button className="button secondary" onClick={onClose} disabled={busy}>{canAdmin ? "取消" : "关闭"}</button>{canAdmin && <button className="button primary" onClick={() => void save()} disabled={!changed || busy}>{busy ? <Busy /> : <><Check size={15} />保存</>}</button>}</footer>
  </div></Modal>;
}

function GroupRow({ group, busy, onSave, onDelete }: { group: DeviceGroup; busy: string; onSave: (id: string, name: string) => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false); const [name, setName] = useState(group.name); const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(group.name); setEditing(false); }, [group.name]);
  return <div className="device-group-row"><FolderOpen size={18} /><div className="device-group-content">{editing ? <input aria-label={`修改 ${group.name} 分组名称`} value={name} maxLength={80} disabled={!!busy} onChange={event => setName(event.target.value)} /> : <strong>{group.name}</strong>}<small>{group.nodeCount} 台设备</small>{confirmDelete && <div className="group-delete-confirm"><span>删除分组后，设备移至“未分组”，原分组授权将移除。</span><div><button className="text-button" disabled={!!busy} onClick={() => setConfirmDelete(false)}>保留</button><button className="text-button danger-text" disabled={!!busy} onClick={() => onDelete(group.id)}>删除分组</button></div></div>}</div><div className="device-group-actions">{editing ? <><button className="text-button" disabled={!!busy} onClick={() => { setEditing(false); setName(group.name); }}>取消</button><button className="button secondary small" disabled={!!busy || !name.trim() || name.trim() === group.name} onClick={() => onSave(group.id, name.trim())}>{busy === group.id ? <Busy /> : "保存"}</button></> : <><button className="icon-button" aria-label={`重命名分组 ${group.name}`} onClick={() => { setEditing(true); setConfirmDelete(false); }} disabled={!!busy}><Pencil size={15} /></button><button className="icon-button danger-text" aria-label={`删除分组 ${group.name}`} onClick={() => setConfirmDelete(true)} disabled={!!busy}><Trash2 size={15} /></button></>}</div></div>;
}

export function DeviceGroupsManager({ groups, nodes, onClose, onChanged }: { groups: DeviceGroup[]; nodes: FleetNode[]; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState(groups); const [name, setName] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const creation = useRef<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [destination, setDestination] = useState("__choose__"); const [search, setSearch] = useState(""); const [assignmentNote, setAssignmentNote] = useState("");
  const availableNodes = nodes.filter(node => !node.revoked); const filteredNodes = availableNodes.filter(node => deviceLabel(node).toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { setItems(groups); }, [groups]);
  async function assign() {
    if (busy || !selected.length || destination === "__choose__") return;
    setBusy("assign"); setError(""); setAssignmentNote(""); const moved: string[] = [], failed: string[] = [];
    for (const id of selected) { const node = availableNodes.find(item => item.id === id); if (!node) continue; try { await mutation(`/v1/nodes/${encodeURIComponent(id)}`, { groupId: destination || null }, "PATCH"); moved.push(id); } catch (err) { failed.push(`${deviceCode(node)}：${errorText(err)}`); } }
    setSelected(previous => previous.filter(id => !moved.includes(id))); if (moved.length) { setAssignmentNote(`已调整 ${moved.length} 台电脑的分组。`); onChanged(); } if (failed.length) setError(failed.join("；")); setBusy("");
  }
  async function create() {
    if (!name.trim() || busy) return;
    if (creation.current && creation.current.name !== name.trim()) { setError("上次创建结果尚未确认，请保留原名称重试。"); return; }
    if (!creation.current) creation.current = { id: uid(), name: name.trim() };
    setBusy("create"); setError("");
    try { const group = await mutation<DeviceGroup>("/v1/device-groups", { ...creation.current, sortOrder: items.length }); setItems(previous => [...previous.filter(item => item.id !== group.id), group]); creation.current = null; setName(""); onChanged(); } catch (err) { if (err instanceof ApiError && err.status >= 400 && err.status < 500) creation.current = null; setError(errorText(err)); } finally { setBusy(""); }
  }
  async function save(id: string, nextName: string) { setBusy(id); setError(""); try { const group = await mutation<DeviceGroup>(`/v1/device-groups/${encodeURIComponent(id)}`, { name: nextName }, "PATCH"); setItems(previous => previous.map(item => item.id === id ? group : item)); onChanged(); } catch (err) { setError(errorText(err)); } finally { setBusy(""); } }
  async function remove(id: string) { setBusy(id); setError(""); try { await mutation(`/v1/device-groups/${encodeURIComponent(id)}`, {}, "DELETE"); setItems(previous => previous.filter(group => group.id !== id)); if (destination === id) setDestination("__choose__"); onChanged(); } catch (err) { setError(errorText(err)); } finally { setBusy(""); } }
  return <Modal title="业务分组" onClose={onClose} busy={!!busy}><div className="form-body"><div className="device-group-create"><label>新建分组<input aria-label="新分组名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="例如：研发、异地协作" disabled={!!busy} /></label><button className="button primary" disabled={!name.trim() || !!busy} onClick={() => void create()}>{busy === "create" ? <Busy /> : <><Plus size={15} />添加</>}</button></div>{error && <Notice>{error}</Notice>}<div className="device-group-list">{items.map(group => <GroupRow group={{ ...group, nodeCount: nodes.filter(node => !node.revoked && node.groupId === group.id).length }} busy={busy} onSave={(id, next) => void save(id, next)} onDelete={id => void remove(id)} key={group.id} />)}{!items.length && <div className="quiet-empty">还没有业务分组</div>}<div className="device-ungrouped"><span>未分组</span><span>{nodes.filter(node => !node.revoked && !node.groupId).length} 台设备</span></div></div><section className="group-device-assignment"><h3>调整已有电脑的分组</h3><input aria-label="搜索待归组电脑" placeholder="搜索名称或代号" value={search} onChange={event => setSearch(event.target.value)} disabled={!!busy} /><div className="assignment-devices">{filteredNodes.map(node => <label key={node.id}><input type="checkbox" checked={selected.includes(node.id)} disabled={!!busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, node.id] : previous.filter(id => id !== node.id))} /><span>{deviceLabel(node)}<small>{items.find(group => group.id === node.groupId)?.name || "未分组"}</small></span></label>)}{!filteredNodes.length && <p className="field-hint">没有符合条件的电脑</p>}</div><div className="assignment-controls"><select aria-label="移动到业务分组" value={destination} onChange={event => setDestination(event.target.value)} disabled={!!busy}><option value="__choose__">选择目标分组</option><option value="">未分组</option>{items.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select><button className="button primary" onClick={() => void assign()} disabled={!!busy || !selected.length || destination === "__choose__"}>{busy === "assign" ? <Busy /> : `移动 ${selected.length} 台`}</button></div>{assignmentNote && <p className="field-hint" role="status">{assignmentNote}</p>}</section></div></Modal>;
}
