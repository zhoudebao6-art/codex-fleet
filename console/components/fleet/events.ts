import type { FleetEvent } from "./types";
import { bytes } from "./api";

const LABELS: Record<string, string> = { submitted: "派发了任务", assign: "派发了任务", assigned: "派发了任务", task_created: "派发了任务", claimed: "接收了任务", started: "开始执行任务", progress: "更新了执行进展", message: "发送了补充说明", finished: "提交了执行结果", accepted: "确认了任务结果", cancel: "请求取消任务", cancel_requested: "请求取消任务", cancelled: "取消了任务", uncertain: "需要核实执行状态", resolved: "核实了执行状态", enrolled: "设备已接入", heartbeat: "设备已连接", file_uploaded: "上传了文件" };
export function describeEvent(event: FleetEvent) {
  const payload = event.payload || {};
  const type = event.type || event.kind || "progress";
  const kind = typeof payload.kind === "string" ? payload.kind : type;
  let label = LABELS[type] || "更新了协作记录";
  let text = [payload.text, payload.summary, payload.message, payload.note, payload.error].find(v => typeof v === "string") as string | undefined;
  const name = typeof payload.name === "string" ? payload.name : "";
  if (kind === "input_transfer" || kind === "output_transfer") {
    const completed = Number(payload.bytes) >= Number(payload.size) && typeof payload.size === "number";
    label = kind === "output_transfer" ? payload.stage === "checksummed" ? "结果文件已上传" : "正在上传结果文件" : payload.stage === "received" ? completed ? "已收到文件" : "正在接收文件" : payload.stage === "checksummed" ? "文件校验通过" : payload.stage === "context_attached" ? "文件已交给 Codex" : payload.stage === "retrying" ? "等待恢复文件传输" : "正在接收文件";
    text = [name, typeof payload.bytes === "number" && typeof payload.size === "number" ? `${bytes(payload.bytes)} / ${bytes(payload.size)}` : ""].filter(Boolean).join(" · ");
  } else if (kind === "input_read_receipt") {
    label = "Codex 报告已读取文件";
    text = [name, text].filter(Boolean).join(" · ");
  } else if (["assistant_message", "agentMessage"].includes(kind)) {
    label = "Codex 的回复";
  } else if (["tool_activity", "tool_start", "tool_complete", "command", "filechange"].includes(kind)) {
    const toolNames: Record<string, string> = { commandExecution: "命令执行", fileChange: "文件修改", mcpToolCall: "工具调用", webSearch: "网页检索", imageView: "查看图片", imageGeneration: "生成图片" };
    const toolType = String(payload.toolType || (kind === "command" ? "commandExecution" : kind === "filechange" ? "fileChange" : ""));
    const running = payload.status === "running" || kind === "tool_start";
    const failed = ["failed", "error"].includes(String(payload.status));
    label = `${toolNames[toolType] || "工具调用"}${running ? "开始" : failed ? "失败" : "完成"}`;
    text = typeof payload.tool === "string" ? payload.tool.slice(0, 100) : "";
  } else if (kind === "plan") {
    label = "更新了计划";
    const steps = Array.isArray(payload.plan) ? payload.plan as { step?: string; status?: string }[] : [];
    const active = steps.find(step => step.status === "in_progress");
    text = active?.step ? active.step : steps.filter(step => step.status === "completed").length === steps.length && steps.length ? "计划步骤已完成" : steps.map(step => step.step || "").filter(Boolean).slice(0, 3).join("；");
  } else if (kind === "interaction_pending" || type === "interaction_requested") {
    label = "等待你的回复";
    text = "在任务详情中处理这次请求。";
  } else if (kind === "interaction_resolved" || type === "interaction_resolved") {
    label = "交互已处理";
  } else if (type === "interaction_answered") {
    label = "回复已发送，等待设备确认";
  } else if (kind === "attention") {
    label = "需要处理";
  }
  return { kind, label, text: text || "" };
}

export function actorName(value?: string) { return !value ? "协作台" : value === "admin" ? "管理员" : value === "hub" ? "协作台" : value.startsWith("member:") ? "协作成员" : value; }

export function currentActivity(events: FleetEvent[]) {
  const latest = [...events].sort((a, b) => b.seq - a.seq);
  const tools = latest.filter(event => ["tool_activity", "tool_start", "tool_complete"].includes(String(event.payload?.kind)));
  const activeTool = tools.find((event, index) => (event.payload?.status === "running" || event.payload?.kind === "tool_start") && !tools.slice(0, index).some(later => event.payload?.itemId ? later.payload?.itemId === event.payload.itemId : later.payload?.toolType === event.payload?.toolType && later.payload?.tool === event.payload?.tool));
  const plan = latest.find(event => event.payload?.kind === "plan");
  const hasActivePlan = plan && Array.isArray(plan.payload?.plan) && (plan.payload.plan as { status?: string }[]).some(step => step.status === "in_progress");
  const useful = latest.find(event => event.type === "progress" && (event.payload?.kind || event.payload?.message));
  const publicUpdate = latest.find(event => ["assistant_message", "agentMessage", "attention"].includes(String(event.payload?.kind)));
  const awaiting = latest.find((event, index) => event.payload?.kind === "interaction_pending" && !latest.slice(0, index).some(later => (later.payload?.kind === "interaction_resolved" || later.type === "interaction_resolved") && later.payload?.interactionId === event.payload?.interactionId));
  const selected = awaiting || (hasActivePlan ? plan : publicUpdate) || activeTool || useful || latest[0];
  if (!selected) return null;
  const description = describeEvent(selected);
  const toolDescription = activeTool && describeEvent(activeTool);
  const purpose = ["plan", "assistant_message", "agentMessage", "attention"].includes(description.kind) && description.text;
  return { event: selected, ...description, headline: purpose || description.label, detail: toolDescription && selected !== activeTool ? [toolDescription.label, toolDescription.text].filter(Boolean).join(" · ") : purpose ? "" : description.text };
}
