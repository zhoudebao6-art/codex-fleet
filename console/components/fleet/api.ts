import type { InputFile } from "./types";
import { hashFile } from "./sha256";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const readFailures = new Map<string, { count: number; retryAt: number; error: unknown }>();
export function resetReadBackoff() { readFailures.clear(); }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const reading = !options.method || options.method === "GET";
  if (reading && typeof navigator !== "undefined" && !navigator.onLine) throw new ApiError("网络已断开，恢复连接后自动同步。", 0, "OFFLINE");
  const previous = reading ? readFailures.get(path) : undefined;
  if (previous && previous.retryAt > Date.now()) throw previous.error;
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.method === "PUT" ? 180000 : 30000);
  try {
    const response = await fetch(path, { ...options, headers, signal: controller.signal, credentials: "same-origin", cache: "no-store" });
    const type = response.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      throw new ApiError(response.status === 401 || response.redirected ? "登录状态已失效，请重新登录。" : "服务暂时没有返回有效结果，请稍后刷新。", response.status || 502);
    }
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : "请求未完成，请稍后重试。", response.status, typeof data.code === "string" ? data.code : undefined);
    if (reading) readFailures.delete(path);
    return data as T;
  }
  catch (error) {
    const failure = timedOut ? new ApiError("连接超时，当前内容已保留。请检查网络后重试。", 0, "TIMEOUT") : error;
    if (reading && (timedOut || failure instanceof TypeError || failure instanceof ApiError && failure.status >= 500)) {
      const count = (previous?.count || 0) + 1;
      if (readFailures.size > 100) readFailures.clear();
      readFailures.set(path, { count, retryAt: Date.now() + Math.min(30000, 2000 * 2 ** Math.min(count, 4)), error: failure });
    }
    throw failure;
  }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
}

export function mutation<T>(path: string, body: unknown, method = "POST") {
  return api<T>(path, { method, body: JSON.stringify(body) });
}

export function errorText(error: unknown) { if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "暂时无法连接站点，请检查网络后重试。"; return error instanceof Error ? error.message : "操作未完成，请重试。"; }
export function uid() { return crypto.randomUUID(); }
export function taskTitle(prompt?: string) { return prompt?.split(/\r?\n/).find(s => s.trim())?.slice(0, 100) || "未命名任务"; }
export function bytes(size: number) { if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`; return `${(size / (1024 * 1024)).toFixed(1)} MB`; }
export function time(value?: string | number) { if (!value) return "尚无记录"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d); }

export async function uploadFile(file: File, project: string, progress: (state: { text: string; percent: number }) => void, groupId?: string): Promise<InputFile> {
  if (file.size > 512 * 1024 * 1024) throw new Error("当前单个文件支持 512 MB 以内。请将更大的资料分卷后上传。");
  progress({ text: "正在校验文件", percent: 0 });
  const sha = await hashFile(file, done => progress({ text: `正在校验 ${bytes(done)} / ${bytes(file.size)}`, percent: Math.round(done / Math.max(file.size, 1) * 100) }));
  const state = await mutation<{ offset: number; complete: boolean }>("/api/console/files", { id: uid(), sha, name: file.name, size: file.size, project, ...(groupId ? { groupId } : {}) });
  let offset = state.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error("服务器返回的续传位置无效。");
  let complete = state.complete;
  while (!complete && offset < file.size) {
    const end = Math.min(file.size, offset + 8 * 1024 * 1024);
    const next = await api<{ offset: number; complete: boolean }>(`/api/console/files/${sha}?project=${encodeURIComponent(project)}&offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, end) });
    if (next.offset <= offset || next.offset > file.size) throw new Error("上传进度异常，请重新选择同一文件续传。");
    offset = next.offset; complete = next.complete;
    progress({ text: complete ? "上传完成，校验通过" : `正在上传 ${bytes(offset)} / ${bytes(file.size)}`, percent: Math.round(offset / Math.max(file.size, 1) * 100) });
  }
  if (!complete) throw new Error("文件尚未完成校验，请重新选择同一文件继续上传。");
  progress({ text: "上传完成，校验通过", percent: 100 });
  return { sha, name: file.name, size: file.size, project };
}
