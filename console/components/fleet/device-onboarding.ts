import type { GroupAccess } from "./types";

export type Installer = { version: string; name: string; size: number; sha256: string; downloadUrl: string };
export type InvitationNode = { id: string; name: string; code?: string; displayName?: string; groupId?: string | null; groupName?: string | null; online: boolean; revoked?: boolean; lastSeen?: string; version?: string | null; desktopLinked?: boolean; desktopIssue?: string | null; workspaceState?: string | null; workspaceCount?: number | null; codexReady?: boolean | null };
export type DeviceInvitation = {
  id: string; name: string; displayName?: string; groupId?: string | null; groupName?: string | null;
  projects: string[]; accountGroup?: string; createdAt?: string | null; expires: string; usedAt?: string | null;
  revokedAt?: string | null; status: "pending" | "enrolled" | "expired" | "revoked"; usedBy?: string | null;
  consoleRole?: "operator" | "viewer"; consoleAccess?: GroupAccess; node?: InvitationNode | null;
};
export type InvitationPackage = DeviceInvitation & { token: string; hubUrl: string };
export type InvitationPage = { invites: DeviceInvitation[]; total: number; nextCursor?: string | null; suggestedCode?: string };

export function invitationState(invitation: DeviceInvitation) {
  if (invitation.status === "revoked") return { label: "已撤销", tone: "neutral", detail: "邀请已失效，不会删除已接入设备。", step: 0 };
  if (invitation.status === "expired" || invitation.status === "pending" && Date.parse(invitation.expires) <= Date.now()) return { label: "已过期", tone: "amber", detail: "请重新生成邀请后接入。", step: 0 };
  if (invitation.status !== "enrolled" && !invitation.usedBy) return { label: "等待接入", tone: "neutral", detail: "邀请已生成，等待目标电脑完成安装。", step: 1 };
  if (!invitation.node) return { label: "已登记，等待连接", tone: "blue", detail: "已收到登记，等待设备状态。", step: 2 };
  if (invitation.node.revoked) return { label: "设备已停用", tone: "amber", detail: "设备已登记，目前已被停用。", step: 2 };
  if (!invitation.node.online) return { label: "已登记，设备离线", tone: "amber", detail: "网络恢复或节点启动后会重新连接。", step: 2 };
  if (invitation.node.desktopIssue) return { label: "桌面接入待处理", tone: "amber", detail: invitation.node.desktopIssue, step: 3 };
  if (invitation.node.codexReady === true && invitation.node.desktopLinked && invitation.node.workspaceState === "synced") return { label: "已接入并联动", tone: "green", detail: "工作空间已同步，桌面共享执行器已连接。可发起短任务确认桌面显示。", step: 5 };
  if (invitation.node.codexReady === true) return { label: "Codex 已就绪", tone: "green", detail: "节点已就绪；请继续核实工作空间同步及桌面联动入口。", step: 4 };
  return { label: "已连接", tone: "blue", detail: invitation.node.codexReady === false ? "设备在线，Codex 执行中或待检查。" : "设备在线，等待 Codex 回报。", step: 3 };
}

export function deploymentPrompt(invitation: Pick<DeviceInvitation, "name" | "displayName" | "groupName" | "projects">, installer: Installer, origin: string) {
  return `请将这台 Windows 电脑接入 Codex Fleet 协作台 ${origin}。设备代号 ${invitation.name}${invitation.displayName && invitation.displayName !== invitation.name ? `，显示名称“${invitation.displayName}”` : ""}，业务分组“${invitation.groupName || "未分组"}”。这是实际安装任务，请执行并验证。

我会提供这两份文件：${installer.name} 和 ${invitation.name}.invite.json。安装包版本 ${installer.version}，SHA256 必须为 ${installer.sha256}。请先在我附加的文件、下载目录或桌面定位真实文件；不要猜测路径，不要把邀请内容、令牌或登录凭据输出到聊天。若缺少文件，明确告诉我缺少哪一份。

保留这台电脑现有 Codex 登录、技能、MCP、工具、项目和任务队列，不复制其他电脑的登录资料。仅为当前进程设置 TEMP、TMP、TMPDIR 为 D:\\codex+\\temp，缓存放在 D:\\codex+\\cache，备份放在 D:\\codex+\\backups；不改系统代理、网络配置或其他程序的环境变量。

先检查现有 Fleet 安装：读取已有技能 installation.json、节点配置或启动项定位真实安装目录，检查 D 盘和本机 Codex 状态。没有 D 盘时先报告环境不满足，不擅自改装到 C 盘。如果站点或 Windows 用户/Codex 身份不一致，停止并说明冲突，不覆盖身份。若正在执行任务，等待空闲，不强停任务。

无论新装或升级，都必须先使用 Get-FileHash -Algorithm SHA256 校验安装 ZIP，与上述值一致后才解压到 D:\\codex+\\temp 下独立目录。将 $fleetZipPath、$fleetPackageRoot、$fleetInvitationPath、$fleetInstallRoot 分别设为 ZIP 文件、解压目录、邀请文件、目标安装目录的真实绝对路径；在执行下面任何命令前核验这四个路径。新安装使用 D:\\CodexFleet；已有安装使用刚核实的原目录。解压目录与安装目录必须不同。

分支一：若已 enrolled 且属于同一协作台，保留原节点身份与代号，不消费这份新电脑邀请，不安装第二份。只按需在原目录升级，使用：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fleetPackageRoot 'scripts\\Update-Fleet.ps1') -PackagePath $fleetZipPath -Sha256 '${installer.sha256}' -ExpectedVersion '${installer.version}' -InstallDir $fleetInstallRoot -Queue

随后报告实际已有代号并做末尾验证，不执行新设备登记。若无需升级，直接验证原节点状态。

分支二：仅全新或 pending 待接入节点使用以下非交互安装命令：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fleetPackageRoot 'Install-Sites.ps1') -Invitation $fleetInvitationPath -InstallDir $fleetInstallRoot

必须显式传入 -Invitation，不运行会弹文件选择器的 Setup-Sites.cmd，不省略邀请参数。保留已有项目映射；只安装节点，不另建总控，不需要 Tailscale 或开放入站端口。

本版默认自动接入该电脑全部有效的 Codex 工作空间，包括已登记但尚未创建对话的项目、已有任务目录和原配置目录；以后新增的工作空间也自动同步。不把所有磁盘根目录设为项目，不逐个手工重复创建。安装后检查节点 capabilities.workspaceCatalog 和网站项目列表：state=synced 表示同步成功；partial/retrying 需报告具体未同步原因，不能用单个 workspace 目录代替全部工作空间验收。保留原账号、分组权限以及项目的执行权限。

安装后检查本机节点已启动、enrollmentState=enrolled、云连接在线，确认 Codex 登录可用、原有技能/MCP保留，并验证“Codex Fleet Console”桌面入口。读取实际自启配置，报告是计划任务还是当前用户登录启动项；核实它指向本次真实安装路径且采用隐藏启动。当前节点在线不代表下次登录自启已验证；未实际重新登录时明确写“自启已配置，登录触发尚未实测”，不要为验收强制注销或重启。

0.3.9 及以后的新装会同时准备“Codex Fleet 联动”桌面入口。核对 desktop-bridge\\preparation-status.json；旧节点升级后若尚未准备，使用本次安装目录 app\\scripts\\Prepare-DesktopBridge.ps1 准备入口。此步骤只准备入口，不等于桌面执行已启用。让用户结束当前工作、正常退出全部 Codex 窗口后，从“Codex Fleet 联动”打开一次；不要由当前会话强杀或关闭自己。启动器会按当前 Windows 应用清单选择入口，并处理完整信任应用包直接启动被拒绝的兼容情况。失败时读取 desktop-bridge\\launch-status.json 的阶段和错误，保留原节点连接，不修改 WindowsApps ACL、全局环境或安全设置。桌面共享执行器上线后，再发起一个短测试，实际确认同一任务在 Codex 桌面可见并由网页停止；不能用打开链接成功代替可见验收。

安装包已整合防休眠与唤醒助手：核对电源助手已启动、防休眠状态、系统睡眠能力、网卡唤醒能力和同局域网中继检测；硬件或 BIOS 不支持时报告限制，不修改全局电源计划或强制休眠验收。桌面联动需回报 conversationDispatch=true，才能使用新版普通对话入口；文件更新不能代替新桥接代码已激活。协作任务默认允许并发 4 项，管理员可在设备资料调整。

最后报告真实设备代号、安装路径、节点版本、连接状态、Codex 是否就绪、工作空间数量、联动入口准备/激活状态、自启配置和未解决的问题。邀请生成、脚本退出或网页排队都不算接入成功；以节点及网站真实回报为准。`;
}

export function downloadOnboardingFile(name: string, text: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
