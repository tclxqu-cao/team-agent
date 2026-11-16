import type { ChatMessage } from "../stores/agentStore";
import { validCompletionDurationMs } from "./message-actions";

/** Attach authoritative completion timing to the trace before each final answer. */
export function codexExecutionTurnDurations(messages: readonly ChatMessage[]): Map<string, number> {
  const durations = new Map<string, number>();
  let turnId: string | undefined;
  for (const message of messages) {
    if (message.role === "user") turnId = message.presentation?.executionTrace?.turnId;
    if (message.executionTrace) turnId = message.executionTrace.turnId;
    if (message.role !== "assistant" || message.executionTrace) continue;
    const duration = validCompletionDurationMs(message.presentation?.completionDurationMs)
      ?? validCompletionDurationMs(message.presentation?.runResult?.durationMs);
    const owner = message.presentation?.executionTrace?.turnId ?? turnId;
    if (owner && duration !== undefined) durations.set(owner, duration);
  }
  return durations;
}
