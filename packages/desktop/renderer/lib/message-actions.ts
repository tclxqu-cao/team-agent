import type { ChatMessage } from "../stores/agentStore";

export interface MessageActionPolicy {
  showCopy: boolean;
  showSpeak: boolean;
  showCompletion: boolean;
  compact: boolean;
}

export function validCompletionDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatCompletionDuration(value: unknown): string | undefined {
  const durationMs = validCompletionDurationMs(value);
  return durationMs === undefined ? undefined : `${Math.round(durationMs / 1000)} 秒`;
}

function startsNewTurn(message: ChatMessage): boolean {
  return message.role === "user" && !message.isQueued && !message.isSteered;
}

function hasAssistantOutput(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(
    message.content.trim()
    || message.toolCalls?.length
    || message.presentation?.reasoning?.length
    || message.askUser
    || message.widget,
  );
}

export function isFinalAssistantResponse(
  messages: readonly ChatMessage[],
  index: number,
  isRunning: boolean,
): boolean {
  const message = messages[index];
  if (
    message?.role !== "assistant"
    || !message.content.trim()
    || message.toolCalls?.length
    || message.isCompactionSummary
  ) {
    return false;
  }

  let completedTurn = !isRunning;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex++) {
    const next = messages[nextIndex];
    if (next.isCompactionSummary) continue;
    if (startsNewTurn(next)) {
      completedTurn = true;
      break;
    }
    if (hasAssistantOutput(next)) return false;
  }
  return completedTurn;
}

export function messageActionPolicy(
  messages: readonly ChatMessage[],
  index: number,
  isRunning: boolean,
): MessageActionPolicy {
  const message = messages[index];
  if (!message) return { showCopy: false, showSpeak: false, showCompletion: false, compact: false };
  if (message.role === "user") {
    return {
      showCopy: Boolean(message.content),
      showSpeak: false,
      showCompletion: false,
      compact: false,
    };
  }

  const isFinal = isFinalAssistantResponse(messages, index, isRunning);
  return {
    showCopy: isFinal,
    showSpeak: isFinal,
    showCompletion: isFinal,
    compact: message.role === "assistant" && !isFinal && !message.isCompactionSummary,
  };
}
