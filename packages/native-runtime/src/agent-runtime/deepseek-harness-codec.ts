import type { AgentEvent, Message, ToolCall } from "@agent/core";
import { harnessRecord, type HarnessRecord } from "./deepseek-harness-client.js";

const text = (value: unknown) => typeof value === "string" ? value : "";
export function harnessContent(value: unknown, type = "text"): string {
  return Array.isArray(value) ? value.map(block => { const item = harnessRecord(block); return item.type === type ? text(item.text) : ""; }).join("") : text(value);
}

export function harnessToolCall(data: HarnessRecord): ToolCall {
  let args: unknown = data.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { input: args }; } }
  return { id: text(data.callId), name: data.name === "ask_user_question" ? "ask_user" : text(data.name), arguments: args && typeof args === "object" && !Array.isArray(args) ? args as HarnessRecord : { input: args } };
}

export function harnessMessage(event: HarnessRecord): Message | null {
  const data = harnessRecord(event.data);
  const raw = event.type === "user/message" ? data : data.message ? harnessRecord(data.message) : null;
  if (!raw || !["user", "assistant", "tool"].includes(text(raw.role))) return null;
  const reasoning = harnessContent(raw.content, "reasoning");
  return {
    role: raw.role as Message["role"], content: harnessContent(raw.content), historyId: `dsh:${event.seq}`,
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId, isError: raw.isError === true } : {}),
    ...(reasoning ? { presentation: { reasoning: [{ itemId: `dsh:${event.seq}`, sectionIndex: 0, text: reasoning }] } } : {}),
  };
}

/** Replay official surface replacements before projecting the shared chat model. */
export function decodeHarnessHistory(records: HarnessRecord[]): { messages: Message[]; events: AgentEvent[] } {
  const surface: Array<{ event: HarnessRecord; message: Message }> = [];
  const events: AgentEvent[] = [];
  for (const record of records) {
    const event = harnessRecord(record.event);
    if (event.surfaceOp && typeof event.surfaceOp === "object") {
      const op = harnessRecord(event.surfaceOp);
      if (op.op === "replace") {
        const start = surface.findIndex(item => item.event.seq === op.startSeq);
        const end = surface.findIndex(item => item.event.seq === op.endSeq);
        if (start >= 0 && end >= start) surface.splice(start, end - start + 1);
      }
    }
    const message = harnessMessage(event);
    if (message) surface.push({ event, message });
    const data = harnessRecord(event.data);
    if (event.type === "tool/call") {
      const toolCall = harnessToolCall(data);
      const owner = [...surface].reverse().find(item => item.message.role === "assistant" && harnessRecord(item.event.data).step === data.step && harnessRecord(item.event.data).turn === data.turn);
      if (owner) owner.message.toolCalls = [...owner.message.toolCalls ?? [], toolCall];
      events.push({ type: "tool_call", toolCall });
    } else if (event.type === "tool/result" && message) events.push({ type: "tool_result", result: { toolCallId: message.toolCallId || "", content: message.content, isError: message.isError } });
  }
  return { messages: surface.map(item => item.message), events };
}

export function harnessChunkEvent(frame: HarnessRecord): AgentEvent | null {
  if (frame.type !== "chunk") return null;
  const chunk = harnessRecord(frame.chunk);
  if (chunk.type === "text-delta") return { type: "text_chunk", text: text(chunk.text), itemId: text(frame.attemptId), turnId: text(frame.attemptId) };
  if (chunk.type === "reasoning-delta") return { type: "reasoning_summary_delta", itemId: text(frame.attemptId), sectionIndex: Number(chunk.index) || 0, delta: text(chunk.text) };
  return null;
}
