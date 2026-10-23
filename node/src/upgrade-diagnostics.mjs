// Classify known failure conditions. Never publish arbitrary local exception text:
// it can contain command lines, URLs with tokens, or private filesystem paths.
export function upgradeFailure(detail) {
  const s=typeof detail==='string'?detail:'';
  if(/Upgrade wait expired/i.test(s))return {code:'WAIT_FOR_IDLE_TIMEOUT',message:'升级等待超时；仍有任务、传输或回执未完成，当前工作保留。'};
  if(/Queues changed during stop/i.test(s))return {code:'WORK_CHANGED_DURING_STOP',message:'停止前检测到新的未完成工作；已中止升级，未替换程序。'};
  if(/Upgrade guard failed|Fresh complete|Cannot prove/i.test(s))return {code:'IDLE_CHECK_UNAVAILABLE',message:'无法取得完整且新鲜的空闲证明；升级已安全中止，请检查连接。'};
  if(/正常停止|has not stopped|not stopped|not force-killed|still running/i.test(s))return {code:'WORKER_STOP_TIMEOUT',message:'节点未在期限内正常退出；未强制结束 Codex，请检查节点恢复状态。'};
  if(/拒绝访问|Access.*denied|EACCES|EPERM/i.test(s))return {code:'ACCESS_DENIED',message:'升级文件访问被拒绝；请检查文件占用和本安装目录权限。'};
  if(/SHA256|hash mismatch|integrity|manifest/i.test(s))return {code:'PACKAGE_INTEGRITY',message:'安装包完整性校验未通过；未使用未验证的程序。'};
  if(/version|版本/i.test(s))return {code:'VERSION_MISMATCH',message:'启动后的实际版本与目标不一致；升级未确认成功。'};
  return {code:'UPGRADE_FAILED',message:'升级失败；已尝试保留或恢复原安装，具体原因需检查本机升级日志。'};
}
