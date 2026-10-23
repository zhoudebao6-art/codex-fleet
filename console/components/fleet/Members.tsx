"use client";

import { useEffect, useState } from "react";
import { Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { api, errorText, mutation, time } from "./api";
import type { DeviceGroup, GroupAccess, Member, Role, User } from "./types";
import { Busy, Empty, Modal, Notice, Section } from "./ui";
import GroupAccessEditor, { accessLabel, effectiveAccess, emptyAccess } from "./GroupAccessEditor";

export const ROLES = { admin: "管理员", operator: "操作员", viewer: "只读成员" };

export default function Members({ user, groups, groupsError = "" }: { user: User; groups: DeviceGroup[]; groupsError?: string }) {
  const [members, setMembers] = useState<Member[]>([]); const [error, setError] = useState(""); const [success, setSuccess] = useState(""); const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false); const [editing, setEditing] = useState<Member | null>(null); const [email, setEmail] = useState(""); const [role, setRole] = useState<Role>("operator"); const [access, setAccess] = useState<GroupAccess>(emptyAccess); const [busy, setBusy] = useState(""); const [remove, setRemove] = useState<Member | null>(null);
  const isSelf = (member: Member) => member.id === user.memberId || `member:${member.id}` === user.id || !!member.userId && member.userId === user.id;
  async function load() { const response = await api<{ members: Member[] }>("/api/console/members"); setMembers(response.members); }
  useEffect(() => { let alive = true; if (user.role === "admin") void api<{ members: Member[] }>("/api/console/members").then(result => { if (alive) setMembers(result.members); }).catch(err => { if (alive) setError(errorText(err)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [user.role]);
  async function save() {
    if (busy) return; setBusy("save"); setError(""); setSuccess("");
    try { if (editing) { await mutation(`/api/console/members/${encodeURIComponent(editing.id)}`, { role, access: effectiveAccess(role, access) }, "PATCH"); if (isSelf(editing)) { window.location.reload(); return; } } else await mutation("/api/console/members", { email: email.trim(), role, access: effectiveAccess(role, access) }); await load(); setAdding(false); setEditing(null); setEmail(""); setSuccess(editing ? "成员权限已更新。" : "成员已添加，可使用对应邮箱的 ChatGPT 账号登录。"); } catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  async function removeMember() {
    if (!remove || busy) return; setBusy(remove.id); setError("");
    try { await mutation(`/api/console/members/${encodeURIComponent(remove.id)}`, {}, "DELETE"); if (isSelf(remove)) { window.location.reload(); return; } await load(); setRemove(null); setSuccess("成员访问权限已移除。"); } catch (err) { setError(errorText(err)); } finally { setBusy(""); }
  }
  if (user.role !== "admin") return <Section title="我的访问权限"><div className="permission-profile"><div className="identity-avatar large">{(user.name || user.email || "C").slice(0, 1).toUpperCase()}</div><div><h3>{user.name || user.email || "已接入的电脑"}</h3><p>{ROLES[user.role]} · {user.kind === "device" ? "设备自动登录" : "ChatGPT 账号登录"}</p><p>可见：{accessLabel(user.access, groups, user.role)}</p></div></div><div className="permission-explainer"><ShieldCheck size={22} /><div><h3>{user.role === "operator" ? "可在授权分组内派发任务并查看结果" : "可查看授权分组内的设备、任务和文件"}</h3><p>角色与可见分组由管理员管理。</p></div></div></Section>;
  return <><Section title="ChatGPT 成员" action={<button className="button primary" onClick={() => { setAdding(true); setEditing(null); setRole("operator"); setAccess(emptyAccess()); setError(""); }}><Plus size={18} />添加成员</button>}>
    {error && !adding && !editing && !remove && <Notice>{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}
    {loading ? <div className="loading-inline"><Busy>正在读取成员</Busy></div> : !members.length ? <Empty icon={<Users size={27} />} title="还没有 ChatGPT 成员">添加需要访问协作台的账号邮箱。</Empty> : <div className="member-list">{members.map(member => <div className="member-row access-account-row" key={member.id}><div className="identity-avatar">{member.email.slice(0, 1).toUpperCase()}</div><div className="member-name"><h3>{member.email}</h3><p>{ROLES[member.role]} · {accessLabel(member.access, groups, member.role)}</p><small>{member.userId ? "已绑定登录账号" : "等待首次登录"} · {time(member.created)}</small></div><div className="account-row-actions"><button className="text-button" aria-label={`设置 ${member.email} 的权限`} disabled={!!busy || !member.access} onClick={() => { setRole(member.role); setAccess(member.access || emptyAccess()); setEditing(member); setError(""); }}>权限</button><button className="icon-button danger-text" aria-label={`移除 ${member.email}`} disabled={!!busy} onClick={() => { setRemove(member); setError(""); }}><Trash2 size={17} /></button></div></div>)}</div>}
  </Section>
    {(adding || editing) && <Modal title={editing ? `${editing.email} · 权限` : "添加 ChatGPT 成员"} onClose={() => { setAdding(false); setEditing(null); }} busy={!!busy}><form className="form-body" onSubmit={e => { e.preventDefault(); void save(); }}>{error && <Notice>{error}</Notice>}{adding && <label>ChatGPT 账号邮箱<input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" /></label>}<label>角色<select aria-label="成员角色" value={role} onChange={e => setRole(e.target.value as Role)} disabled={!!busy}><option value="operator">操作员 · 可以派发任务</option><option value="viewer">只读成员 · 仅查看</option><option value="admin">管理员 · 管理成员和设备</option></select></label><GroupAccessEditor value={access} groups={groups} onChange={setAccess} role={role} disabled={!!busy} error={groupsError} /><footer className="modal-footer"><button type="button" className="button secondary" onClick={() => { setAdding(false); setEditing(null); }} disabled={!!busy}>取消</button><button className="button primary" type="submit" disabled={!!busy || !!groupsError || adding && !email.trim()}>{busy ? <Busy /> : editing ? "保存权限" : "添加成员"}</button></footer></form></Modal>}
    {remove && <Modal title="移除成员" onClose={() => setRemove(null)} busy={!!busy}><div className="form-body">{error && <Notice>{error}</Notice>}<p>移除 <strong>{remove.email}</strong> 的协作台访问权限？历史任务和结果会保留。</p><footer className="modal-footer"><button className="button secondary" onClick={() => setRemove(null)} disabled={!!busy}>保留成员</button><button className="button danger" onClick={removeMember} disabled={!!busy}>{busy ? <Busy /> : "移除访问权限"}</button></footer></div></Modal>}
  </>;
}