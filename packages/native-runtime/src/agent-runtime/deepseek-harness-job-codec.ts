import type { AgentEvent } from "@agent/core";
import { harnessRecord, type HarnessRecord } from "./deepseek-harness-client.js";

const labels = { running: "运行中", stopping: "正在停止", completed: "已完成", killed: "已停止", failed: "失败" };
const outputLimit = 16_384;

/** Decodes a native output batch into a bounded observer preview. */
export function appendHarnessJobOutput(output: string, frame: HarnessRecord): string {
  if (!Array.isArray(frame.chunks)) throw new Error("DeepSeek Harness 任务输出无效");
  const chunks = frame.chunks.map(harnessRecord);
  if (chunks.some(chunk => typeof chunk.text !== "string")) throw new Error("DeepSeek Harness 任务输出无效");
  const gap = frame.lossy === true || chunks.some(chunk => chunk.gapBefore === true);
  const text = output + (gap ? "\n[部分输出已丢失]\n" : "") + chunks.map(chunk => chunk.text).join("");
  return text.length > outputLimit ? `[仅保留最新输出]\n${text.slice(-outputLimit)}` : text;
}

/** Translates native job facts to source-independent runtime progress. */
export function harnessJobProgress(job: HarnessRecord, output = ""): Extract<AgentEvent, { type: "runtime_progress" }> {
  const status = job.status;
  if (typeof job.id !== "string" || typeof job.label !== "string"
    || !Object.hasOwn(labels, String(status)) || typeof job.startedAt !== "number") {
    throw new Error("DeepSeek Harness 后台任务数据无效");
  }
  const state = status as keyof typeof labels;
  const finishedAt = typeof job.finishedAt === "number" ? job.finishedAt : Date.now();
  return { type: "runtime_progress", kind: "background-job", progressId: `harness-job:${job.id}`, phase: "tool",
    label: `${labels[state]} · ${job.label}`, status: state, startedAt: job.startedAt,
    elapsedSeconds: Math.max(0, (finishedAt - job.startedAt) / 1000), output,
    detail: typeof job.progress === "string" ? job.progress : typeof job.detail === "string" ? job.detail
      : output ? "实时输出" : "等待输出（命令可能没有输出或隐藏了进度）" };
}
