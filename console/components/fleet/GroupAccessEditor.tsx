import type { DeviceGroup, GroupAccess, Role } from "./types";

export const emptyAccess = (): GroupAccess => ({ mode: "groups", groupIds: [] });
export const effectiveAccess = (role: Role, access: GroupAccess): GroupAccess => role === "admin" ? { mode: "all", groupIds: [] } : access;
export function accessLabel(access: GroupAccess | undefined, groups: DeviceGroup[], role?: Role) {
  if (role === "admin" || access?.mode === "all") return "全部设备（含今后新增）";
  if (!access) return "可见范围尚未读取";
  if (!access.groupIds.length) return "未授权任何设备";
  return access.groupIds.map(id => id === "__ungrouped__" ? "未分组" : groups.find(group => group.id === id)?.name || "已删除分组").join("、");
}

export default function GroupAccessEditor({ value, groups, onChange, role, disabled = false, error = "", label = "可见设备" }: { value: GroupAccess; groups: DeviceGroup[]; onChange: (access: GroupAccess) => void; role?: Role; disabled?: boolean; error?: string; label?: string }) {
  const choices = [{ id: "__ungrouped__", name: "未分组" }, ...groups];
  const missing = value.groupIds.filter(id => !choices.some(group => group.id === id));
  function toggle(id: string, checked: boolean) { onChange({ mode: "groups", groupIds: checked ? [...value.groupIds, id] : value.groupIds.filter(item => item !== id) }); }
  return <fieldset className="group-access-editor" disabled={disabled || !!error}><legend>{label}</legend>{role === "admin" ? <p className="field-hint">管理员可管理全部设备与分组。</p> : <><select aria-label={`${label}范围`} value={value.mode} onChange={event => onChange({ mode: event.target.value as GroupAccess["mode"], groupIds: [] })}><option value="groups">指定分组</option><option value="all">全部设备（含今后新增）</option></select>{value.mode === "groups" && <><div className="access-group-options">{choices.map(group => <label key={group.id}><input type="checkbox" checked={value.groupIds.includes(group.id)} onChange={event => toggle(group.id, event.target.checked)} /><span>{group.name}</span></label>)}{missing.map(id => <label key={id} className="access-missing-group"><input type="checkbox" checked onChange={() => toggle(id, false)} /><span>已删除分组 · 请取消此项</span></label>)}</div>{!value.groupIds.length && <p className="field-hint">尚未选择分组，该身份暂时看不到任何设备。</p>}</>}{value.mode === "all" && <p className="field-hint">包含未分组设备及今后新增的分组。</p>}</>}{error && <p className="field-hint danger-text">{error}</p>}</fieldset>;
}
