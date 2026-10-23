"use client";
import {useEffect,useState} from "react";
import {ArchiveRestore,CheckCircle2,Trash2} from "lucide-react";
import {api,errorText,mutation,time} from "./api";
import {Busy,Empty,Modal,Notice} from "./ui";
type RecordItem={id:string;label:string;createdAt:string;status:string;items:{kind:string;label:string}[]};
export default function CleanupHistory({onClose,onChanged}:{onClose:()=>void;onChanged:()=>void}){
 const [records,setRecords]=useState<RecordItem[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(""),[confirm,setConfirm]=useState("");
 async function load(){try{const v=await api<{records:RecordItem[]}>("/api/console/cleanup");setRecords(v.records);setError("");}catch(e){setError(errorText(e));}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 async function restore(id:string){setBusy(id);setError("");try{await mutation(`/api/console/cleanup/${encodeURIComponent(id)}/restore`,{});setConfirm("");onChanged();await load();}catch(e){setError(errorText(e));}finally{setBusy("");}}
 return <Modal title="清理记录" onClose={onClose} busy={!!busy}><div className="detail-body cleanup-history">{error&&<Notice>{error}</Notice>}<p className="muted">已清理的记录可在这里恢复。</p>{loading?<Busy>正在读取</Busy>:!records.length?<Empty icon={<Trash2 size={24}/>} title="暂无清理记录"/>:records.map(r=><article className="cleanup-record" key={r.id}><header><div><strong>{r.label}</strong><small>{time(r.createdAt)} · {r.items.length} 项</small></div>{r.status==='restored'?<span className="status status-green"><CheckCircle2 size={15}/>已恢复</span>:<button className="button secondary small" onClick={()=>setConfirm(r.id)} disabled={!!busy}><ArchiveRestore size={16}/>恢复</button>}</header><details><summary>查看清理内容</summary><ul>{r.items.map((i,index)=><li key={index}>{i.label}</li>)}</ul></details>{confirm===r.id&&<div className="cleanup-confirm"><span>这些记录将重新显示在列表中。</span><button className="button secondary small" onClick={()=>setConfirm("")} disabled={!!busy}>取消</button><button className="button primary small" onClick={()=>void restore(r.id)} disabled={!!busy}>{busy?<Busy/>:'确认恢复'}</button></div>}</article>)}</div></Modal>;
}
