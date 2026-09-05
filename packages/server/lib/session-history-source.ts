export function rebuildMessagesFromEvents(events: Array<Record<string, unknown>>) {
  const messages: Array<Record<string, unknown>> = [];
  let streamingAssistant: Record<string, unknown> | null = null;

  for (const event of events) {
    if (event.type === "text_chunk") {
      if (!streamingAssistant) {
        streamingAssistant = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          isStreaming: true,
          timestamp: Date.now(),
        };
        messages.push(streamingAssistant);
      }
      streamingAssistant.content = `${streamingAssistant.content ?? ""}${event.text ?? ""}`;
      continue;
    }
    if (event.type === "tool_call" && event.toolCall) {
      streamingAssistant = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: streamingAssistant?.content ?? "",
        toolCalls: [event.toolCall],
        isStreaming: false,
        timestamp: Date.now(),
      };
      messages.push(streamingAssistant);
      streamingAssistant = null;
      continue;
    }
    if (event.type === "tool_result" && (event as { result?: { content?: string; toolCallId?: string } }).result) {
      const result = (event as { result: { content?: string; toolCallId?: string } }).result;
      messages.push({
        id: crypto.randomUUID(),
        role: "tool",
        content: result.content ?? "",
        toolCallId: result.toolCallId,
        timestamp: Date.now(),
      });
      continue;
    }
    if (event.type === "ask_user") {
      messages.push({
        id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
