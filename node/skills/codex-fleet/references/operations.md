# 运行说明

安装后的本技能目录有 `installation.json`，记录安装根目录和节点配置文件。不要把配置中的 nodeToken、总控 adminToken 或邀请文件内容放进聊天、代码库、日志截图或产物。

默认安装根目录为 `D:\CodexFleet`：

- 启动节点：`powershell -NoProfile -ExecutionPolicy Bypass -File D:\CodexFleet\app\scripts\Start-Fleet.ps1 -Role Node`
- 本机诊断：同目录下 `Diagnose-Fleet.ps1 -Role Node`。
- 正常停机：同目录下 `Stop-Fleet.ps1 -Role Node`；它只请求本项目记录的进程停止，不结束其他 Codex。
- 总控诊断：在总控电脑使用 `Diagnose-Fleet.ps1 -Role Hub`。
- 总控菜单：`Console-Fleet.ps1`。

节点切换 Codex 账号后，空闲节点会重新探测账号指纹；任务启动时再次核对，身份变化时失败并要求显式重试。指纹使用该 Fleet 的随机盐与当地账号标识计算，不上传邮箱、登录凭据或 token。同账号在不同工作空间被保守合并为一个并发组。

网络断开时，不清除 SQLite、待发送队列、worktree、输出文件和身份文件。重新联网并启动同一个节点配置即可重传。运行中崩溃的任务进入 `uncertain`；确认旧执行进程已停止后，总控使用 CLI `resolve --task ID --confirmed-stopped --note "核实记录"` 结束旧尝试，再创建新任务。

出现异常时可运行 `app\scripts\Export-Diagnostics.ps1 -InstallDir D:\CodexFleet -OutputFile <诊断JSON路径>`，导出连接状态、任务状态和传输字节数，排除 nodeToken、sitesToken、提示词和文件内容。分享前仍核对设备名称和任务编号。备份使用 `Backup-Fleet.ps1`：先正常停止该 Fleet 节点，保留 data（SQLite、待发队列、输入 partial、结果快照）、config 和 app；该备份包含设备凭据，必须私密保存，不可复制到另一台电脑克隆身份。

当前默认单文件上限 512 MiB。上传采用总控声明的块大小，最大 8 MiB，下载仍按 1 MiB 续传；完成时校验整文件 SHA256。网页显示的字节进度与任务状态是实际回报，不把网络重连、文件已收完或模型自报等同于独立验收。离线恢复依赖本机持久盘和云存储仍完好，不代表无限容量或多区域高可用。

需要代码整合时，先核对候选任务验收状态、提交哈希、测试结果。使用包中的 `Prepare-Integration.ps1` 在独立 worktree 合并指定的完整提交，执行该项目真实测试。脚本不会自动推送或改写工作分支。发生冲突时在该 worktree 处理并重新验收。

Sites 版在每台要执行任务的电脑解压 v0.2.0 Windows 包，运行 `Install-Sites.ps1 -Invitation <网站下载的邀请文件路径>`；双击 `Setup-Sites.cmd` 可通过文件选择框选邀请。已有 pending 节点会保留 nodeId、队列、项目映射、Codex 登录和其他技能，升级前备份配置与程序。无需安装本地总控或额外 Tailscale。手机、平板和仅查看网站的电脑不需要节点安装包。

安装后桌面 `Codex Fleet Console` 快捷方式调用本机节点身份换取一次性、短期登录票据，再打开同一个总控网站；不会把长期 nodeToken 放入网址。设备网页会话仅限该设备项目的操作员范围，没有成员管理权限。普通手机浏览器使用网站的账号登录。

节点只主动发起 HTTPS 请求。可选 `sitesToken` 用于私有 Sites 平台服务访问，独立于 nodeToken，必须保存在受保护的本机配置或邀请中。`proxyUrl` 或进程 HTTP_PROXY / HTTPS_PROXY 可配置 HTTP CONNECT 代理，TLS 证书仍需正常验证。401、登录跳转和限流会保留队列等待修复；429、408、425 不会把待发事件判成永久失败。

完整旧式本地总控安装步骤见安装包的 `docs/部署使用指南.md`。
