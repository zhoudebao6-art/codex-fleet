# 案件与自动化接入合同

`GET /v1/case-flows` 返回当前允许新建的流程。内置 `auto20`、`software` 使用 `delivery-v1`，保留原交付调度、技能版本核验、独立审核和主控收据。注册新流程不会改动旧交付或技能安装。

管理员通过 `POST /v1/case-flows` 登记不可变版本：

```json
{"id":"explanation","version":1,"name":"技术说明","description":"按材料生成技术说明","adapter":"desktop-evidence-v1","taskPrompt":"实际读取材料，按当前案件需求输出准确说明。","outputs":["explanation.txt"],"requiredSkills":[]}
```

同一 ID/版本只能重试相同合同；改动须提交更高版本。案件创建时冻结完整流程快照。`PATCH /v1/case-flows/explanation {"enabled":false}` 关闭后续新建并隐藏选择项，已创建案件继续按冻结快照执行。注册接口仅支持服务端已实现的适配器，不执行上传的服务器脚本，也不绕过原业务技能门禁。技能可以使用 `plugin:skill` 名称。

`desktop-evidence-v1` 通过现有 Fleet 桌面任务通道执行三个独立步骤：生产、独立审核、主控归集。生产任务在本机现有工作目录的案件独立输出目录读取附件；审核任务使用另一真实会话；归集任务在配置主控的新会话实际保存并校验全部文件。任务均通过现有上传及 `sync` 回传，不需要节点新增 CLI。每一份 JSON 收据都绑定 `caseId / versionId / revision / requestHash`；审核须绑定生产任务及真实独立会话和精确产物哈希；归集须绑定这份审核、完整文件列表与实际保存目录。只有三步全部通过后，新版本才标记 verified。

创建档案 `POST /v1/cases`：

```json
{"id":"case-001","name":"示例案件","project":"workspace","flowId":"explanation","mode":"new","nodeIds":["worker-node-id","review-node-id"],"inputs":[{"name":"材料.txt","sha":"64位SHA256","size":123}],"notes":"本次具体要求"}
```

`nodeIds=[]` 仅创建草稿；`POST /v1/cases/case-001/resume` 带 `{id,expectedRevision:1,nodeIds:[...]}` 开始制作。`mode:link` 关联同项目、同内置流程的既有 `batchId`，不重写原声明；一个批次只能归属一个档案版本。`mode:import` 必须带 `history:{description,sourceLocation,files:[...]}`，历史文件始终是未经核验的参照，不因导入或后续新成果通过而被追认证实。历史补充只制作本次要求的新成果，不重做未要求的原系统。

新建可选 `collectionRoot` 为本机已配置的绝对交付根目录，默认 `E:/研发自动化/交付成果`，冻结在声明 JSON 中。新归集任务另行冻结该值，实际保存到 `collectionRoot/case-<id>/revision-<n>`，服务器核验收据目录与此一致；缺少 E 盘、配置差异或写入失败必须报告，不能静默退回 D 盘。旧归集任务没有这一字段时沿用原冻结合同，其实际收据不重写，之后的文件迁移须另外记录。

`POST /v1/cases/:id/requirements` 带 `{id,expectedRevision,text,attachments:[],nodeIds?:[],itemIndex?:0}`。需求收据立即持久化，要求编号、文本、附件与哈希不可变。运行中任务的提示词、文件和已冻结审核标准不会修改。旧版本必须完成原审核及归集后，后续需求才生成单独版本；多个新增要求按顺序各自完成，不让旧版本完成状态冒充新要求完成。新版本携带原材料、历代成果、附件哈希、前驱版本与原工作目录。需要选择原材料批次中的特定材料时显式提供 `itemIndex`。

现有节点的 `/v1/sync` 与主控 `/v1/delivery/tick` 自动推进；`POST /v1/cases/:id/reconcile {}` 仅供创建者/管理员主动重查。GET 只读。暂停的内置批次继续原批次。明确终止的桌面失败可通过 resume 的 `note` 记录处理依据后在原任务上下文接续，新尝试使用单独输出目录；运行、未确定和待取消任务不能重复启动，最多显式接续三次。审核否决不能靠改收据通过，须先实际解决所指出问题。

创建、修订、继续均要求操作员权限及项目和设备组授权。每次调度重新核对创建者与主控归属；节点领取时再次检查授权及案件状态。设备权限涵盖档案历次涉及的设备。`id` 是请求幂等键，内容变化必须新 ID；`expectedRevision` 使用数据库 CAS 拒绝过时写入。每个档案的推进有租约与写入围栏，过期执行者不能迟到提交。导入、旧版本、失败尝试、审核与归集收据保留以供追溯。

新内置交付存在补充要求时，声明另行冻结 `supplemental-delivery` v1.1.0，仓库 `zhoudebao6-art/software-system-delivery`，目录 `skills/supplemental-delivery`，提交 `661b18140f4831c0d4db6f2e418cc88110e53d20`，`versionDirectoryHint` 为 `skill-versions/661b18140f4831c0d4db6f2e418cc88110e53d20/supplemental-delivery`，优先在当地研发自动化配置根目录下核验和调用隔离快照，不能覆盖或替代为活动全局技能。仅适用于生产案件；短流程 probe 不制作业务补充包。设备必须实际报告技能可用；缺项返回 `SUPPLEMENTAL_SKILL_REQUIRED`，持久案件需求保留等待配置。准备阶段只核验真实本机入口和固定版本；制作阶段按需求从准备、计算、录制环节协作，保留单一主技能，最终正常材料与必要补充汇为一个新 ZIP。`feedbackPack` 保存实际 `pack_feedback.py` 原始收据及其 SHA256，绑定批次、发布 run、父 sourceHash、输出 ZIP 和需求 ID/member 覆盖；允许正常材料满足要求的 normal-only 包，不为通过验证虚构额外材料。打包收据不能代替主流程质量门禁或独立内容审核。纯代码Word或源码替代仅按明确授权执行；仅在明确给出体积上限时传 `--max-bytes` 并核实际ZIP大小，未要求限额不默认20MB。未声明该新契约的旧批次和已运行任务保持原冻结要求，包括旧1.0固定提交及既有入口。
