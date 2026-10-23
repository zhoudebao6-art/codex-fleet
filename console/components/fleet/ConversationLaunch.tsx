"use client";
import {useEffect,useState} from "react";
import {api,errorText,mutation} from "./api";
import {Busy,Modal,Notice} from "./ui";
import type {FleetTask} from "./types";
import type {DesktopThread} from "./desktop-types";
export default function ConversationLaunch({initial,onClose,onOpen}:{initial:FleetTask;onClose:()=>void;onOpen:(thread:DesktopThread)=>void}){
  const [task,setTask]=useState(initial),[error,setError]=useState(""),[cancelling,setCancelling]=useState(false);
  useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>;async function load(){
    try{const value=await api<FleetTask>(`/v1/tasks/${encodeURIComponent(initial.id)}`);if(!alive)return;setTask(value);setError("");
      const id=value.thread_id||value.threadId;
      if(id){try{const thread=await api<DesktopThread>(`/v1/desktop/threads/${encodeURIComponent(value.target)}/${encodeURIComponent(id)}`);if(alive){onOpen(thread);return;}}catch{/* The new desktop inventory may arrive just after the execution receipt. */}}
    }catch(e){if(alive)setError(errorText(e));}
    if(alive)timer=setTimeout(load,1500);
  }void load();return()=>{alive=false;clearTimeout(timer);};},[initial.id,onOpen]);
  const failed=["failed","blocked","uncertain","cancelled"].includes(task.status);
  async function cancel(){setCancelling(true);try{setTask(await mutation<FleetTask>(`/v1/tasks/${encodeURIComponent(task.id)}/cancel`,{}));}catch(e){setError(errorText(e));}finally{setCancelling(false);}}
  return <Modal title="新建桌面对话" onClose={onClose}><div className="form-body">{error&&<Notice>{error}</Notice>}
    <p className="prose-block">{task.spec.prompt}</p>
    {failed?<Notice>{task.result?.error||(task.status==="cancelled"?"本次请求已取消。":"本次请求未完成。")}</Notice>:task.waitReason?<Notice tone="info">{task.waitReason}</Notice>:<Busy>{task.thread_id?"正在同步这条桌面对话…":task.status==="queued"?"正在发送到指定电脑…":"正在指定项目中打开对话…"}</Busy>}
    {task.result?.summary&&<p className="prose-block">{task.result.summary}</p>}
    <footer className="modal-footer">{["queued","claimed","running"].includes(task.status)&&<button className="button secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?"正在取消":"取消本次请求"}</button>}<button className="button secondary" onClick={onClose}>关闭</button></footer>
  </div></Modal>;
}
