# 部署与验证

## 公开仓库与现有部署

本仓库不连接原发布者站点。`console/.openai/hosting.json` 只有 DB/BUCKET 绑定名，没有项目 ID。需要在自己的 Sites 项目创建数据库、文件存储及认证设置。未附站点管理凭据、邀请文件、运行库二进制和安装成品 ZIP。

### A. Windows 节点与旧版私网 Hub

1. 安装 Node.js 22.13+、Git、Codex，并在工作电脑正常登录 Codex。
2. 构建安装包时显式提供本机 Node.exe 和 LICENSE；不要采用脚本内发布者机器的默认路径。

```powershell
$env:TEMP = 'E:\codex+\temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
& .\node\scripts\Build-Package.ps1 -OutputDirectory 'E:\FleetPackages\build-01' -NodeExecutable 'C:\Program Files\nodejs\node.exe' -NodeLicense 'C:\Program Files\nodejs\LICENSE'
```

检查 `node/scripts/Windows-Common.ps1` 中缓存路径设置。历史安装脚本仍有 D 盘约定，E 盘环境需先调整部署副本并验证，不能仅设置 TEMP 就声称所有缓存均迁移。不要直接运行未知安装包，不修改 Windows 信任策略。

3. 无网站需求可参照 [旧版私网部署指南](../node/docs/旧版私网部署指南.md) 创建 Hub、Tailscale Serve 和独立节点邀请。该 Hub 是兼容旧协议的队列服务，不包含新版完整网页功能。
4. 桌面信任限制参见 [桌面启动器签名与受控设备接入](../node/docs/桌面启动器签名与受控设备接入.md)。只接受系统允许的启动方式；普通节点与桌面联动分开验收。

### B. 网页总控

网站源码在 `console/`。在自己的 Sites 项目中导入源码并按该平台配置 DB、BUCKET、管理员初始化变量、认证及 HTTPS。不要复制生产数据库或项目 ID。bootstrap 变量见 `console/lib/fleet/accounts.mjs` 的 `ensureBootstrap`；口令仅配置到服务端秘密存储，不放 Git。

开发安装：

```powershell
cd console
$env:npm_config_cache = 'E:\codex+\cache\npm'
npm ci
npm run dev
```

开发模式含本地 mockAuth 支持，只允许本机预览，不能将开发服务器直接暴露公网。上线需使用真实认证和最小权限，核对账号、设备组、文件下载及项目访问。

框架依赖版本来自原部署锁文件，公共注册表是否提供同版需在目标环境核验。若版本不可取得，保持原快照并单独升级依赖测试，不凭空替换后声称等价。

### C. 最小业务验收

1. 接入两台空闲测试设备，确认不同节点 ID、在线心跳与明确项目权限。
2. 绑定每台电脑已有技能总控 threadId；派发一条只回复固定标记的请求，确认网页与原桌面对话均可见。
3. 上传小文件，由目标电脑读取、生成新文件并回传；核对 SHA256 和内容。
4. 仅断开测试节点连接，再恢复；同一任务不能重复执行，文件应续传而非重复创建。
5. 取消短测试，确认执行停止；再测试空闲升级恢复。不要用正在制作的业务案件试断网或强制退出。

通过这些步骤才记录设备可用，不能将“安装成功”当成整条链路验收成功。
