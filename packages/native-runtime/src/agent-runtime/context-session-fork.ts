import { sessionHistoryMessageId, type AgentType, type Message } from "@agent/core";

const contextForkAgents = new Set<AgentType>(["zcode", "qoder", "deepseek-harness", "workbuddy", "copilot"]);

export function supportsContextFork(agentType: AgentType): boolean {
  return contextForkAgents.has(agentType);
}

/** Only the final persisted assistant response in a completed turn is a cutoff. */
export function contextForkPoints(messages: Message[], running: boolean): Message[] {
  let haveBoundary = !running;
  const marked = messages.slice();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !message.name?.startsWith("__native_steered")
      && message.name !== "__native_steering_pending") {
      haveBoundary = true;
    }
    if (message.role !== "assistant") continue;
    const canFork = haveBoundary && message.content.trim() && !message.toolCalls?.length
      && !message.presentation?.question && message.presentation?.agentMessagePhase !== "commentary"
      && (!message.presentation?.runResult || message.presentation.runResult.status === "completed");
    if (message.content.trim() || message.toolCalls?.length || message.presentation?.question
      || message.presentation?.reasoning?.length) haveBoundary = false;
    if (!canFork && !message.presentation?.forkPoint) continue;
    marked[index] = {
      ...message,
      presentation: {
        ...message.presentation,
        forkPoint: canFork ? { messageId: sessionHistoryMessageId(index, message) } : undefined,
      },
    };
  }
  return marked;
}
