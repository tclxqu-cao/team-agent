import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../lib/native-runtime-service";

function rebuildMessagesFromEvents(events: Array<Record<string, unknown>>) {
  const messages: Array<Record<string, unknown>> = [];
  let streamingAssistant: Record<string, unknown> | null = null;

  for (const event of events) {
    const type = event.type;
    if (type === "text_chunk") {
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

    if (type === "tool_call" && event.toolCall) {
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

    if (type === "tool_result" && (event as { result?: { content?: string; toolCallId?: string } }).result) {
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

    if (type === "ask_user") {
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

    if (type === "done" && typeof event.finalText === "string") {
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

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    try {
      const detail = await getNativeRuntimeService().get(params.id);
      return NextResponse.json(detail);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        { status: runtimeErrorStatus(err) },
      );
    }
  }

  const session = await agentHost.getSessionStore().get(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const rebuiltMessages = !session.messages?.length && Array.isArray(session.events) && session.events.length > 0
    ? rebuildMessagesFromEvents(session.events as Array<Record<string, unknown>>)
    : session.messages;

  const hydrated = { ...session, messages: rebuiltMessages };
  return NextResponse.json(hydrated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    return NextResponse.json(
      { error: "External runtime sessions cannot be deleted" },
      { status: 405 },
    );
  }
  await agentHost.getSessionStore().delete(params.id);
  return NextResponse.json({ status: "deleted" });
}
