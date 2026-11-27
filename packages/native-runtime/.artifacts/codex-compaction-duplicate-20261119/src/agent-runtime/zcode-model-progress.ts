import type { AgentEvent } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";

type ProgressEvent = Extract<AgentEvent, { type: "runtime_progress" }>;

function attemptNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function zcodeModelProgress(payload: NativeJsonPacket): ProgressEvent | undefined {
  if (payload.type !== "model_request_started" && payload.type !== "model_retry_scheduled" && payload.type !== "model_request_completed") return;

  const retry = payload.type === "model_retry_scheduled";
  const attempt = attemptNumber(retry ? payload.nextAttempt : payload.attempt);
  const maximum = attemptNumber(payload.maxAttempts);
  const suffix = attempt === undefined ? "" : ` ${attempt}${maximum !== undefined && maximum >= attempt ? `/${maximum}` : ""}`;
  // Project user-facing status fields, never headers or raw telemetry.
  const event: ProgressEvent = { type: "runtime_progress", progressId: "zcode:model-request", phase: "thinking", label: `ZCode 正在请求模型${suffix}`, status: "running" };
  if (retry) {
    const details: string[] = [];
    if (typeof payload.message === "string" && payload.message.trim()) details.push(payload.message.trim());
    if (typeof payload.delayMs === "number" && Number.isFinite(payload.delayMs) && payload.delayMs >= 0) {
      details.push(`原生运行时将在 ${Math.ceil(payload.delayMs / 1000)} 秒后重试`);
    }
    return { ...event, phase: "retry", label: `ZCode 请求重试${suffix}`, ...(details.length ? { detail: details.join("\n") } : {}) };
  }
  if (payload.type === "model_request_completed") {
    return { ...event, phase: "status", label: `ZCode 模型请求完成${suffix}`, status: "completed" };
  }
  return event;
}
