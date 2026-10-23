// Shared by the form and server. A reachable node is not necessarily a usable
// desktop executor. This does not attest installed skill file hashes.
export function desktopLaunchIssue(caps) {
  if(!caps||caps.desktopSessionBridge===true)return null;
  const launch=caps.desktopLaunch;
  if(launch?.state!=='failed')return null;
  return ({
    DESKTOP_TRUST_REQUIRED:'桌面启动器需要可信代码签名，安装正式签名包后可连接',
    DESKTOP_SIGNED_RELEASE_REQUIRED:'需要与当前 Fleet 版本匹配的正式签名启动器',
    DESKTOP_APPLICATION_CONTROL_BLOCKED:'Windows 应用控制阻止了启动器，需要符合本机信任要求的正式签名包',
    DESKTOP_SIGNATURE_INVALID:'启动器签名校验未通过，请更换经过验证的正式发布包',
    DESKTOP_RELEASE_MISMATCH:'启动器与当前版本不匹配，请使用同一版本的完整安装包'
  })[launch.errorCode]||null;
}
export function runtimeIssue(node,{parallel=false,requireDesktop=true,clock=Date.now()}={}) {
  if(!node||node.revoked)return '设备已停用或不存在';
  const seen=Date.parse(node.lastSeen||node.last_seen||'');
  if(node.online===false||!Number.isFinite(seen)||clock-seen>60000||seen-clock>300000)return '设备离线或心跳已过期';
  let caps;try{caps=typeof node.capabilities==='string'?JSON.parse(node.capabilities):node.capabilities;}catch{return '设备能力记录无效，等待重新同步';}
  if(!caps||typeof caps!=='object'||Array.isArray(caps))return '设备能力尚未同步';
  if(node.maintenance?.enabled===true||Date.parse(node.maintenance_expires||'')>clock||caps.maintenance===true||caps.maintenance?.enabled===true)return '设备正在维护，完成后可启动';
  if(parallel&&caps.parallelExecution!==true)return '节点版本不支持并行流程，需要升级';
  if(requireDesktop&&!Object.hasOwn(caps,'conversationDispatch'))return '节点尚未支持原对话发送，需要升级';
  if(requireDesktop&&desktopLaunchIssue(caps))return desktopLaunchIssue(caps);
  if(requireDesktop&&caps.desktopSessionBridge!==true)return '桌面联动未连接';
  if(requireDesktop&&caps.conversationDispatch!==true)return '桌面消息组件未激活，保存工作后从联动入口重新打开';
  const health=caps.desktopBridgeHealth;
  if(requireDesktop&&health?.ready===false)return '桌面连接检查失败，等待连接恢复';
  const healthAt=caps.desktopHealthReceivedAt||health?.checkedAt;
  if(requireDesktop&&healthAt&&(!Number.isFinite(Date.parse(healthAt))||clock-Date.parse(healthAt)>120000))return '桌面连接检查已过期，等待重新检查';
  if(caps.executorState==='blocked')return '执行器连接异常，等待恢复';
  if(caps.executorState==='checking')return '正在检查执行器连接';
  if(caps.ready!==true)return '执行器尚未就绪或并发已满，稍后再试';
  return null;
}

// Recompute from observation times; never trust an old ready flag after disconnect.
export function nodeRuntime(node,{clock=Date.now()}={}) {
  let caps;try{caps=typeof node?.capabilities==='string'?JSON.parse(node.capabilities):node?.capabilities;}catch{}
  const seen=Date.parse(node?.lastSeen||node?.last_seen||'');
  const online=!!node&&!node.revoked&&node.online!==false&&Number.isFinite(seen)&&clock-seen<=60000&&seen-clock<=300000;
  const reason=runtimeIssue(node,{clock});
  let state=!node||node.revoked?'disabled':!online?'offline':node.maintenance?.enabled||Date.parse(node.maintenance_expires||'')>clock||caps?.maintenance===true||caps?.maintenance?.enabled?'maintenance':!caps?'unknown':!reason?'ready':caps.executorState==='checking'?'checking':caps.ready===false&&caps.executorState==='ready'&&reason?.includes('并发已满')?'busy':'blocked';
  const conversationReason=runtimeIssue({...node,capabilities:{...caps,ready:caps?.conversationReady??caps?.ready}},{clock});
  return {state,label:({disabled:'已停用',offline:'离线',maintenance:'维护中',unknown:'待同步',ready:'可接任务',checking:'检查中',busy:'容量已满',blocked:'连接异常'})[state],reason:reason||null,online,
    canExecute:!reason,canConverse:!conversationReason,checkedAt:node?.lastSeen||node?.last_seen||null,healthCheckedAt:caps?.desktopBridgeHealth?.checkedAt||null};
}
