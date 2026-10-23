import { ArrowUpRight } from "lucide-react";

export default function CodexThreadLink({ threadId, deviceName, localNodeId, nodeId, busy = false, shared = false }: { threadId: unknown; deviceName?: string; localNodeId?: string; nodeId?: string; busy?: boolean; shared?: boolean }) {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id) return null;
  if (!localNodeId || localNodeId !== nodeId) return <div className="codex-thread-link"><small>会话保存在 {deviceName || "目标电脑"} · 可在网页查看进展</small></div>;
  if (busy && !shared) return <div className="codex-thread-link"><small>后台正在执行 · 结束后可在本机 Codex 打开记录</small></div>;
  return <div className="codex-thread-link">
    <a className="text-button" href={`codex://threads/${encodeURIComponent(id)}`}><ArrowUpRight size={14} />在对应电脑的 Codex 打开</a>
    <small>{deviceName || "本机"} 的同一会话</small>
  </div>;
}
