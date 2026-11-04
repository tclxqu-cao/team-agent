import type { AgentEvent } from "@agent/core";
import { mergeReasoningSummaryDelta } from "./native-runtime-progress";
import type { ChatMessage } from "../stores/agentStore";

type CopilotLiveEvent = Extract<AgentEvent, { type: "text_chunk" | "reasoning_summary_delta" | "tool_call" }>;

/** Match the native history's turn/part identity instead of appending into another part. */
export function applyCopilotLiveMessage(
  messages: ChatMessage[],
  event: CopilotLiveEvent,
  now = Date.now(),
): ChatMessage[] | null {
  if (!event.turnId) return null;
  const partId = event.type === "tool_call" ? `${event.toolCall.id}:call` : event.itemId;
  if (!partId) return null;
  const id = `${event.turnId}:${partId}`;
  const index = messages.findIndex(message => message.id === id);
  const previous = index >= 0 ? messages[index] : undefined;
  let message: ChatMessage = previous ?? { id, role: "assistant", content: "", timestamp: now, presentation: { nativeMessageId: id } };
  if (event.type === "text_chunk") message = { ...message, content: message.content + event.text };
  else if (event.type === "reasoning_summary_delta") message = {
    ...message,
    presentation: { ...message.presentation, reasoning: mergeReasoningSummaryDelta(message.presentation?.reasoning, event) },
  };
  else message = {
    ...message,
    toolCalls: [{ ...previous?.toolCalls?.find(tool => tool.id === event.toolCall.id), ...event.toolCall }],
  };
  if (index < 0) return [...messages, message];
  return messages.map((entry, entryIndex) => entryIndex === index ? message : entry);
}
