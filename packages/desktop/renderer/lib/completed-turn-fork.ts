import type { SessionForkPoint } from "@agent/core";
import type { ChatMessage } from "../stores/agentStore";

export function completedTurnForkPoint(message: ChatMessage, sessionId: string): SessionForkPoint | undefined {
  if (message.presentation?.forkPoint) return message.presentation.forkPoint;
  if (!sessionId.startsWith("runtime:") && message.id.startsWith("history-message.v1.")) {
    return { messageId: message.id };
  }
  return undefined;
}
