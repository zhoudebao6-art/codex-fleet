"use client";
import {useEffect,useState} from 'react';
import {nodeRuntime} from '../../lib/fleet/runtime-readiness.mjs';
import {api,errorText,time} from './api';
import type {FleetNode} from './types';
export function RuntimeBadge({node}:{node?:FleetNode}){
 const state=nodeRuntime(node);return <span className={`runtime-badge runtime-${state.state}`} title={state.reason||'设备连接和执行器检查通过'}><i/>{state.label}</span>;
}
export function RuntimeDetails({node}:{node:FleetNode}){
 const state=nodeRuntime(node),[capacity,setCapacity]=useState<{nodeUsed:number;nodeLimit:number;accountUsed:number;accountLimit:number}|null>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;const read=()=>api<typeof capacity>(`/v1/nodes/${node.id}/capacity`).then(v=>{if(alive){setCapacity(v);setError('');}}).catch(e=>{if(alive)setError(errorText(e));});void read();const timer=setInterval(()=>{if(!document.hidden)void read();},15000);return()=>{alive=false;clearInterval(timer);};},[node.id]);
 return <section className="runtime-details"><div className="runtime-details-heading"><RuntimeBadge node={node}/><span>检查于 {time(state.checkedAt)}</span></div>{state.reason&&<p className="runtime-reason">{state.reason}</p>}<div className="runtime-metrics"><div><span>设备执行容量</span><strong>{capacity?`${capacity.nodeUsed} / ${capacity.nodeLimit}`:'—'}</strong></div><div><span>同账号执行容量</span><strong>{capacity?`${capacity.accountUsed} / ${capacity.accountLimit}`:'—'}</strong></div><div><span>原会话发送</span><strong>{state.canConverse?'可用':'等待恢复'}</strong></div></div>{error&&<p className="runtime-reason">容量读取失败：{error}</p>}</section>;
}
