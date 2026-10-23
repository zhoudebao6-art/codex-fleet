import type { DeviceGroup, FleetNode } from "./types";

export function deviceCode(node: FleetNode) { return node.code || node.name; }
export function deviceLabel(node: FleetNode) { const code = deviceCode(node); return node.displayName && node.displayName !== code ? `${node.displayName} · ${code}` : code; }
export function groupDevices(nodes: FleetNode[], groups: DeviceGroup[]) {
  const definitions = new Map(groups.map(group => [group.id, group]));
  for (const node of nodes) if (node.groupId && !definitions.has(node.groupId)) definitions.set(node.groupId, { id: node.groupId, name: node.groupName || "业务分组", sortOrder: 0, nodeCount: 0 });
  const ordered = Array.from(definitions.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh-CN"));
  return [...ordered.map(group => ({ id: group.id, name: group.name, nodes: nodes.filter(node => node.groupId === group.id) })), { id: "", name: "未分组", nodes: nodes.filter(node => !node.groupId) }].map(group => ({ ...group, nodes: group.nodes.sort((a, b) => deviceCode(a).localeCompare(deviceCode(b), "zh-CN", { numeric: true })) }));
}
