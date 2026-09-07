export function rebuildMessagesFromEvents(
  events: Array<Record<string, unknown>>,
  options: { runId?: string; isStreaming?: boolean } = {},
) {
  const messages: Array<Record<string, unknown>> = [];
  let streamingAssistant: Record<string, unknown> | null = null;
  let messageIndex = 0;
  const nextId = () => `${options.runId ?? "event-history"}:${messageIndex++}`;

  for (const event of events) {
    if (event.type === "text_chunk") {
      if (!streamingAssistant) {
        streamingAssistant = {
          id: nextId(),
          role: "assistant",
          content: "",
          isStreaming: options.isStreaming ?? true,
          timestamp: Date.now(),
        };
        messages.push(streamingAssistant);
      }
      streamingAssistant.content = `${streamingAssistant.content ?? ""}${event.text ?? ""}`;
      continue;
    }
    if (event.type === "tool_call" && event.toolCall) {
      if (streamingAssistant) {
        streamingAssistant.toolCalls = [event.toolCall];
        streamingAssistant.isStreaming = false;
      } else {
        messages.push({
          id: nextId(),
          role: "assistant",
          content: "",
          toolCalls: [event.toolCall],
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
      streamingAssistant = null;
      continue;
    }
    if (event.type === "tool_result" && (event as { result?: { content?: string; toolCallId?: string } }).result) {
      const result = (event as { result: { content?: string; toolCallId?: string } }).result;
      messages.push({
        id: nextId(),
        role: "tool",
        content: result.content ?? "",
        toolCallId: result.toolCallId,
        timestamp: Date.now(),
      });
      continue;
    }
    if (event.type === "ask_user") {
      messages.push({
        id: nextId(),
        role: "assistant",
        content: "",
        askUser: {
          questionId: event.questionId,
          question: event.question ?? "",
          options: event.options,
          multiSelect: event.multiSelect,
        },
        timestamp: Date.now(),
      });
      continue;
    }
    if (event.type === "done" && typeof event.finalText === "string") {
      if (streamingAssistant) {
        streamingAssistant.content = event.finalText;
        streamingAssistant.isStreaming = false;
      } else if (event.finalText.trim()) {
        messages.push({
          id: nextId(),
          role: "assistant",
          content: event.finalText,
          timestamp: Date.now(),
        });
      }
      streamingAssistant = null;
    }
  }
  return messages;
}
