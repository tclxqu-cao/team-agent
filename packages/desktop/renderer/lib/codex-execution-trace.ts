import type { AgentEvent, ReasoningSummarySection } from "@agent/core";
import type { ChatMessage } from "../stores/agentStore";
import { mergeReasoningSummaryDelta } from "./native-runtime-progress";

export type CodexLiveExecutionEvent = Extract<AgentEvent, {
  type: "reasoning_summary_delta" | "tool_call" | "tool_result";
}>;

export function groupCodexExecutionTrace(
  messages: readonly ChatMessage[],
  revision: string,
): ChatMessage[] {
  const grouped: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    grouped.push(message);
    const turnId = message.role === "user"
      ? message.presentation?.executionTrace?.turnId
      : undefined;
    if (!turnId) continue;
    const existing = messages[index + 1];
    if (existing?.executionTrace?.turnId === turnId) {
      grouped.push({
        ...existing,
        executionTrace: { ...existing.executionTrace, turnId, revision },
      });
      index += 1;
    } else {
      grouped.push({
        id: `codex-execution-trace:${turnId}`,
        role: "assistant" as const,
        content: "",
        executionTrace: { turnId, revision },
        timestamp: message.timestamp,
      });
    }
  }
  return grouped;
}

export function isCodexExecutionCarrier(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(
    message.toolCalls?.length || message.presentation?.reasoning?.length,
  );
}

export function codexExecutionItemCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => (
    total
      + (message.toolCalls?.length ?? 0)
      + (message.presentation?.reasoning?.length ?? 0)
  ), 0);
}

export function applyCodexExecutionToolResult(
  messages: readonly ChatMessage[],
  itemId: string,
  content: string,
  isError?: boolean,
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.toolCalls?.some((toolCall) => toolCall.id === itemId)) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => toolCall.id === itemId
        ? { ...toolCall, result: content, isError }
        : toolCall),
    };
  });
}

function applyLiveEventToMessages(
  messages: readonly ChatMessage[],
  event: CodexLiveExecutionEvent,
  timestamp: number,
): ChatMessage[] {
  if (event.type === "reasoning_summary_delta") {
    const index = messages.findIndex((message) => message.presentation?.reasoning?.some(
      (section) => section.itemId === event.itemId,
    ));
    if (index < 0) {
      return [...messages, {
        id: `codex-live-reasoning:${event.itemId}`,
        role: "assistant",
        content: "",
        presentation: { reasoning: mergeReasoningSummaryDelta(undefined, event) },
        timestamp,
      }];
    }
    return messages.map((message, messageIndex) => messageIndex === index
      ? {
          ...message,
          presentation: {
            ...message.presentation,
            reasoning: mergeReasoningSummaryDelta(message.presentation?.reasoning, event),
          },
        }
      : message);
  }

  if (event.type === "tool_call") {
    const existingIndex = messages.findIndex((message) => message.toolCalls?.some(
      (toolCall) => toolCall.id === event.toolCall.id,
    ));
    if (existingIndex >= 0) {
      return messages.map((message, messageIndex) => messageIndex === existingIndex
        ? {
            ...message,
            toolCalls: message.toolCalls?.map((toolCall) => toolCall.id === event.toolCall.id
              ? { ...toolCall, name: event.toolCall.name, arguments: event.toolCall.arguments }
              : toolCall),
          }
        : message);
    }
    return [...messages, {
      id: `codex-live-tool:${event.toolCall.id}`,
      role: "assistant",
      content: "",
      toolCalls: [{ ...event.toolCall }],
      timestamp,
    }];
  }

  if (!messages.some((message) => message.toolCalls?.some(
    (toolCall) => toolCall.id === event.result.toolCallId,
  ))) return [...messages];
  return applyCodexExecutionToolResult(
    messages,
    event.result.toolCallId,
    event.result.content,
    event.result.isError,
  );
}

export function applyCodexLiveExecutionEvent(
  messages: readonly ChatMessage[],
  turnId: string,
  event: CodexLiveExecutionEvent,
  timestamp = Date.now(),
): ChatMessage[] {
  const traceIndex = messages.findIndex((message) => message.executionTrace?.turnId === turnId);
  const currentLive = traceIndex >= 0
    ? messages[traceIndex].executionTrace?.liveMessages ?? []
    : [];
  const nextLive = applyLiveEventToMessages(currentLive, event, timestamp);
  if (nextLive.length === 0 && currentLive.length === 0) return [...messages];
  if (traceIndex >= 0) {
    return messages.map((message, index) => index === traceIndex
      ? {
          ...message,
          executionTrace: {
            ...message.executionTrace!,
            liveMessages: nextLive,
          },
        }
      : message);
  }

  if (nextLive === currentLive) return [...messages];
  const userIndex = messages.findLastIndex((message) => message.role === "user" && !message.isQueued);
  if (userIndex < 0) return [...messages];
  const trace: ChatMessage = {
    id: `codex-execution-trace:${turnId}`,
    role: "assistant",
    content: "",
    executionTrace: {
      turnId,
      revision: `live:${turnId}`,
      liveMessages: nextLive,
    },
    timestamp,
  };
  return [
    ...messages.slice(0, userIndex + 1),
    trace,
    ...messages.slice(userIndex + 1),
  ];
}

function mergeReasoningSections(
  history: readonly ReasoningSummarySection[],
  live: readonly ReasoningSummarySection[],
): ReasoningSummarySection[] {
  const merged = new Map(history.map((section) => [
    `${section.itemId}:${section.sectionIndex}`,
    section,
  ]));
  for (const section of live) {
    const key = `${section.itemId}:${section.sectionIndex}`;
    const previous = merged.get(key);
    const text = !previous
      ? section.text
      : section.text.startsWith(previous.text)
        ? section.text
        : previous.text.startsWith(section.text)
          ? previous.text
          : section.text;
    merged.set(key, { ...section, text });
  }
  return [...merged.values()];
}

export function mergeCodexExecutionMessages(
  history: readonly ChatMessage[],
  live: readonly ChatMessage[],
): ChatMessage[] {
  const merged = history.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    presentation: message.presentation?.reasoning
      ? { ...message.presentation, reasoning: [...message.presentation.reasoning] }
      : message.presentation,
  }));

  for (const liveMessage of live) {
    const liveReasoning = liveMessage.presentation?.reasoning;
    if (liveReasoning?.length) {
      const targetIndex = merged.findIndex((message) => message.presentation?.reasoning?.some(
        (section) => liveReasoning.some((liveSection) => liveSection.itemId === section.itemId),
      ));
      if (targetIndex >= 0) {
        const target = merged[targetIndex];
        merged[targetIndex] = {
          ...target,
          presentation: {
            ...target.presentation,
            reasoning: mergeReasoningSections(target.presentation?.reasoning ?? [], liveReasoning),
          },
        };
      } else {
        merged.push(liveMessage);
      }
    }

    for (const liveTool of liveMessage.toolCalls ?? []) {
      const targetIndex = merged.findIndex((message) => message.toolCalls?.some(
        (toolCall) => toolCall.id === liveTool.id,
      ));
      if (targetIndex >= 0) {
        const target = merged[targetIndex];
        merged[targetIndex] = {
          ...target,
          toolCalls: target.toolCalls?.map((toolCall) => toolCall.id === liveTool.id
            ? { ...toolCall, ...liveTool }
            : toolCall),
        };
      } else {
        merged.push({ ...liveMessage, presentation: undefined, toolCalls: [liveTool] });
      }
    }
  }
  return merged;
}
