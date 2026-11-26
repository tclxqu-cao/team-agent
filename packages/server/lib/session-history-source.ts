import type { AgentEvent, Message, MessagePresentation } from "@agent/core";

type QuestionStatus = NonNullable<MessagePresentation["question"]>["status"];

export function resolvedSessionQuestions(events: readonly AgentEvent[]): Map<string, QuestionStatus> {
  const resolutions = new Map<string, QuestionStatus>();
  for (const event of events) {
    if (event.type === "approval_resolved") {
      resolutions.set(event.questionId, event.resolvedQuestion?.status === "cancelled" ? "cancelled" : "answered");
    }
  }
  return resolutions;
}

export function sessionQuestionMessage(
  event: Extract<AgentEvent, { type: "ask_user" }>,
  status: QuestionStatus,
): Message {
  return {
    role: "assistant",
    content: "",
    presentation: {
      question: {
        questionId: event.questionId,
        question: event.question ?? "",
        options: event.options ?? [],
        fields: event.fields,
        multiSelect: event.multiSelect ?? false,
        cancellable: event.cancellable,
        allowFreeText: event.allowFreeText,
        status,
        ...(status === "answered" ? { answer: "已处理" } : {}),
      },
    },
  };
}

type RebuiltMessage = Message & { id: string; timestamp: number; isStreaming?: boolean };

export function rebuildMessagesFromEvents(
  events: AgentEvent[],
  options: { runId?: string; isStreaming?: boolean; pendingQuestionIds?: ReadonlySet<string> } = {},
) {
  const messages: RebuiltMessage[] = [];
  let streamingAssistant: RebuiltMessage | null = null;
  const resolutions = resolvedSessionQuestions(events);
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
    if (event.type === "tool_result" && event.result) {
      const result = event.result;
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
      const status = resolutions.get(event.questionId)
        ?? (options.pendingQuestionIds?.has(event.questionId) ? "pending" : "cancelled");
      messages.push({
        ...sessionQuestionMessage(event, status),
        id: nextId(),
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
