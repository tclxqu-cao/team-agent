import type { StreamEvent } from "../entities.js";

export function isModelRequestTimeout(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const reason = signal.reason;
  return signal.aborted && reason instanceof Error && reason.name === "TimeoutError";
}

export function modelRequestTimeoutEvent(
  provider: string,
  timeoutMs: number,
): Extract<StreamEvent, { type: "error" }> {
  return {
    type: "error",
    code: "model_request_timeout",
    message: `${provider} 单次请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待；已接收的推理或文本会保留，但本轮未成功完成。`,
  };
}
