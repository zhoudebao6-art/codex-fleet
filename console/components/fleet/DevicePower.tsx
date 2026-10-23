"use client";
import { useEffect, useRef, useState } from "react";
import { Power, Radio, ShieldCheck } from "lucide-react";
import { api, errorText, mutation, time, uid } from "./api";
import { Busy, Notice } from "./ui";
import type { FleetNode } from "./types";
type Wake = { id: string; status: string; detail: string; updatedAt: string; probe: boolean };
type PowerState = { agentOnline: boolean; guardFresh: boolean; reportedAt?: string; policy: { mode: string }; guard?: { active: boolean; apiOk: boolean; at: string }; wakeAvailable: boolean; reason?: string; relays: { nodeId: string; name: string }[]; inventory?: { sleep: { s3: boolean; s4: boolean; hibernateEnabled: boolean; summary: string }; adapters: { name: string; description: string; wakeOnMagicPacket: string; wakeArmed: boolean; configuration: string; error?: string }[]; errors: string[] }; actions: Wake[] };
const labels: Record<string,string> = { queued:"等待中转",sent:"等待设备上线",online:"节点已上线",ready:"唤醒完成",packet_sent:"链路发送通过",failed:"发送失败",uncertain:"发送结果待确认",timeout:"等待超时" };
export default function DevicePower({node,canWrite,canAdmin}:{node:FleetNode;canWrite:boolean;canAdmin:boolean}) {
 const [state,setState]=useState<PowerState|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
 const request=useRef<{id:string;probe:boolean}|null>(null);
 useEffect(()=>{let alive=true;let timer:ReturnType<typeof setTimeout>;async function load(){try{const s=await api<PowerState>(`/v1/nodes/${node.id}/power`);if(alive)setState(s);}catch(e){if(alive)setError(errorText(e));}finally{if(alive)timer=setTimeout(load,document.hidden?30000:5000);}}void load();return()=>{alive=false;clearTimeout(timer);};},[node.id,revision]);
 async function wake(){if(busy)return;setBusy(true);setError("");request.current??={id:uid(),probe:node.online};try{await mutation(`/v1/nodes/${node.id}/wake`,request.current);request.current=null;setRevision(r=>r+1);}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function mode(value:string){setBusy(true);setError("");try{setState(await mutation<PowerState>(`/v1/nodes/${node.id}/power`,{mode:value},"PATCH"));}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 const latest=state?.actions[0],active=latest&&["queued","sent","online"].includes(latest.status);
 const guardFresh=state?.guardFresh;
 return <section className="node-maintenance device-power"><div className="node-maintenance-heading"><h3><Power size={16}/> 电源与唤醒</h3><span className={`connection ${state?.agentOnline?"online":"offline"}`}><i/>{state?.agentOnline?"守护在线":"守护未连接"}</span></div>
 {error&&<Notice>{error}</Notice>}
 {!state?<Busy>读取电源状态</Busy>:<><div className="maintenance-version"><span><ShieldCheck size={15}/>{guardFresh&&state.guard?.active?"正在防止自动休眠":guardFresh?"允许空闲休眠":"等待电源状态"}</span><span>屏幕可正常关闭</span></div>
 {canAdmin&&state.reportedAt&&<label>防休眠策略<select aria-label="防休眠策略" value={state.policy.mode} disabled={busy} onChange={e=>void mode(e.target.value)}><option value="available">接电时保持可调度</option><option value="working">仅工作和传输期间</option><option value="off">关闭防休眠</option></select></label>}
 <div className="maintenance-downloads">{canWrite&&<button className="button secondary small" disabled={busy||!!active||!state.wakeAvailable} onClick={()=>void wake()}><Power size={15}/>{busy?<Busy/>:active?"唤醒请求处理中":node.online?"检测唤醒链路":"唤醒电脑"}</button>}<span className="field-hint">{state.relays.length?<><Radio size={14}/> 中转：{state.relays.map(r=>r.name).join("、")}</>:state.reason}</span></div>
 {latest&&<div className={`maintenance-action ${["failed","timeout"].includes(latest.status)?"is-error":""}`} role="status"><strong>{labels[latest.status]||latest.status}</strong><p>{latest.detail}</p><time>{time(latest.updatedAt)}</time></div>}
 <details className="advanced-options"><summary>检测结果与接入说明</summary><p className="field-hint">新电脑自动检测网卡并尝试启用魔术包唤醒。异地需目标局域网内有在线 Fleet 电脑；单台离线电脑无法自行接收网站指令。手动睡眠和合盖仍遵循 Windows 设置。</p>
 {state.inventory?.adapters.map((a,i)=><p className="field-hint" key={i}>{a.description}：{a.wakeOnMagicPacket==="Enabled"&&a.wakeArmed?"网卡唤醒已启用":a.configuration==="needs_local_permission"?"需要本机权限或驱动设置":"尚未确认支持"}{a.error?` · ${a.error}`:""}</p>)}
 {state.inventory?.sleep.summary&&<pre style={{whiteSpace:"pre-wrap",fontSize:12}}>{state.inventory.sleep.summary}</pre>}
 {state.inventory?.errors.map((e,i)=><p className="field-hint" key={i}>{e}</p>)}<small>最近检测上报 {time(state.reportedAt)}</small></details></>}
 </section>;
}
