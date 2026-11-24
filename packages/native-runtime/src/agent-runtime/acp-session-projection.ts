import { randomUUID } from "node:crypto";
import { mergeReasoningSummaryDelta, type AgentEvent, type Message } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeReasoningEffort, RuntimeModelInfo } from "./types.js";

export function acpRecords(value: unknown): NativeJsonPacket[] {
  return Array.isArray(value) ? value.map(nativeRecord) : [];
}

export function acpText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(acpText).join("\n");
  const item = nativeRecord(value);
  return typeof item.text === "string" ? item.text : item.content ? acpText(item.content) : "";
}

export function acpConfig(result: NativeJsonPacket, category: string): NativeJsonPacket | undefined {
  return acpRecords(result.configOptions).find(option => option.category === category && typeof option.id === "string");
}

export function acpChoices(config: NativeJsonPacket | undefined): NativeJsonPacket[] {
  return acpRecords(config?.options).flatMap(option => Array.isArray(option.options) ? acpRecords(option.options) : [option]);
}

export function acpReasoningEffort(value: unknown): NativeReasoningEffort | undefined {
  if (value === "extra" || value === "extra_high") return "xhigh";
  return typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as NativeReasoningEffort : undefined;
}

export function acpModels(result: NativeJsonPacket): RuntimeModelInfo[] {
  const config = acpConfig(result, "model");
  const models = nativeRecord(result.models ?? nativeRecord(result._meta).modelState);
  const legacy = acpRecords(models.availableModels);
  const current = config?.currentValue ?? models.currentModelId;
  const currentEfforts = acpChoices(acpConfig(result, "thought_level")).flatMap(option => acpReasoningEffort(option.value) ?? []);
  const effortsByModel = new Map(legacy.map(row => [row.modelId, acpRecords(nativeRecord(row._meta).reasoningEfforts)]));
  return (config ? acpChoices(config) : legacy).flatMap(row => {
    const key = row.value ?? row.modelId;
    if (typeof key !== "string" || !key) return [];
    const efforts = current === key && currentEfforts.length ? currentEfforts
      : (effortsByModel.get(key) ?? []).flatMap(option => acpReasoningEffort(option.value) ?? []);
    return [{
      id: key,
      displayName: typeof row.name === "string" ? row.name : key,
      ...(current === key ? { current: true } : {}),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    }];
  });
}

/** Projects replay and live transcript updates into the same message shape. */
export class AcpSessionProjection {
  readonly messages: Message[] = [];
  private current?: Message;
  private readonly tools = new Map<string, { name: string; finished: boolean }>();

  appendUser(input: string, images?: string[]): void {
    this.finishTurn();
    this.messages.push({ role: "user", content: input, ...(images?.length ? { images } : {}) });
  }

  finishTurn(): void {
    this.current = undefined;
    this.tools.clear();
  }

  private appendChunk(role: "user" | "assistant", content: unknown): void {
    if (this.current?.role !== role || this.current.presentation?.reasoning) {
      this.current = { role, content: "" };
      this.messages.push(this.current);
    }
    const part = nativeRecord(content);
    if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
      (this.current.images ??= []).push(`data:${part.mimeType};base64,${part.data}`);
    } else {
      this.current.content += acpText(content);
    }
  }

  update(update: NativeJsonPacket, live = false): AgentEvent[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        if (!live) this.appendChunk("user", update.content);
        return [];
      case "agent_message_chunk": {
        const text = acpText(update.content);
        if (!text) return [];
        this.appendChunk("assistant", update.content);
        return [{ type: "text_chunk", text }];
      }
      case "agent_thought_chunk":
        return this.appendThought(update.content);
      case "tool_call":
      case "tool_call_update":
        return this.toolUpdate(update);
      case "turn_completed":
        this.finishTurn();
        return [];
      default:
        return [];
    }
  }

  private appendThought(content: unknown): AgentEvent[] {
    const delta = acpText(content);
    if (!delta) return [];
    if (!this.current?.presentation?.reasoning) {
      this.current = { role: "assistant", content: "", presentation: { reasoning: [] } };
      this.messages.push(this.current);
    }
    const reasoning = this.current.presentation?.reasoning;
    const event = { type: "reasoning_summary_delta", itemId: reasoning?.[0]?.itemId ?? randomUUID(), sectionIndex: 0, delta } as const;
    this.current.presentation = { reasoning: mergeReasoningSummaryDelta(reasoning, event) };
    return [event];
  }

  private toolUpdate(update: NativeJsonPacket): AgentEvent[] {
    const id = update.toolCallId;
    if (typeof id !== "string") return [];
    const events: AgentEvent[] = [];
    let tool = this.tools.get(id);
    if (!tool) {
      const title = update.title ?? update.kind;
      const name = typeof title === "string" ? title : "Tool";
      const toolCall = { id, name, arguments: nativeRecord(update.rawInput) };
      this.current = undefined;
      this.messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
      tool = { name, finished: false };
      this.tools.set(id, tool);
      events.push({ type: "tool_call", toolCall });
    }
    if (!tool.finished && (update.status === "completed" || update.status === "failed")) {
      tool.finished = true;
      this.current = undefined;
      const content = acpText(update.content ?? update.rawOutput);
      const isError = update.status === "failed";
      this.messages.push({ role: "tool", content, toolCallId: id, name: tool.name, isError });
      events.push({ type: "tool_result", result: { toolCallId: id, content, isError } });
    }
    return events;
  }
}

interface StoredAcpQuestion {
  input: string;
  event: Extract<AgentEvent, { type: "approval_resolved" }>;
}

export function restoreAcpQuestionHistory(messages: Message[], questions: readonly StoredAcpQuestion[]): Message[] {
  if (!questions.length) return messages;
  const restored = [...messages];
  const known = new Set(messages.flatMap(message => message.presentation?.question?.questionId ?? []));
  for (const { input, event } of questions) {
    if (!event.resolvedQuestion || known.has(event.questionId)) continue;
    let index = restored.findIndex(message => event.toolCallId && message.toolCallId === event.toolCallId);
    if (index < 0) {
      const turns = restored.flatMap((message, position) => message.role === "user" ? [{ position, content: message.content }] : []);
      const candidates = event.userTurnIndex === undefined
        ? turns.filter(turn => turn.content === input)
        : [turns[event.userTurnIndex]].filter(turn => turn?.content === input);
      if (candidates.length === 1) {
        index = restored.findIndex((message, position) => position > candidates[0]!.position
          && (message.role === "user" || message.role === "assistant" && Boolean(message.content)));
      }
    }
    restored.splice(index < 0 ? restored.length : index, 0, {
      role: "assistant", content: "", presentation: { question: event.resolvedQuestion },
    });
    known.add(event.questionId);
  }
  return restored;
}
