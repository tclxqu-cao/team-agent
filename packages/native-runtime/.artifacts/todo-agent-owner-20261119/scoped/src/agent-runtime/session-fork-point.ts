import type { Message, SessionForkPoint } from "@agent/core";
import { RuntimeSessionError } from "./types.js";

export function parseSessionForkPoint(value: unknown): SessionForkPoint {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const point = value as Record<string, unknown>;
    const keys = Object.keys(point);
    if (keys.length === 1 && (keys[0] === "turnId" || keys[0] === "messageId")) {
      const id = point[keys[0]];
      if (typeof id === "string" && id.trim() && id.length <= 1024) {
        return keys[0] === "turnId" ? { turnId: id } : { messageId: id };
      }
    }
  }
  throw new RuntimeSessionError("请选择已完成的轮次进行 Fork", "INVALID_SESSION_ID");
}

/** Require the last assistant response before the next user input. */
export function completedForkMessageIndex(
  messages: readonly Message[],
  messageId: string,
  isRunning: boolean,
): number {
  const index = messages.findIndex((message) => (
    message.presentation?.forkPoint?.messageId === messageId || message.historyId === messageId
  ));
  const message = messages[index];
  if (message?.role !== "assistant" || !message.content?.trim() || message.toolCalls?.length
    || message.presentation?.agentMessagePhase === "commentary") {
    throw new RuntimeSessionError("该轮次不存在或尚未完成，请刷新会话后重试", "INVALID_SESSION_ID");
  }
  for (const next of messages.slice(index + 1)) {
    if (next.role === "user") return index;
    if (next.role === "assistant") {
      throw new RuntimeSessionError("只能从已完成轮次的最后一条回复 Fork", "INVALID_SESSION_ID");
    }
  }
  if (isRunning) {
    throw new RuntimeSessionError("该轮次尚未完成", "SESSION_ALREADY_RUNNING");
  }
  return index;
}
