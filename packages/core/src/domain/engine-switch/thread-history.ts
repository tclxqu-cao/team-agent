import type { Message } from "../model/entities.js";
import { sessionHistoryMessageId } from "../session/SessionQueryIndex.js";
import type { ContextHandoff, EngineSwitchRecord, EngineSwitchSessionView } from "./entities.js";

export const HANDOFF_INPUT_SEPARATOR = "\n\n[agentroam:current-user-message]\n";

export interface EngineThreadPhase {
  sessionId: string;
  agentType: EngineSwitchSessionView["agentType"];
  messages: Message[];
  boundaryUncertain?: boolean;
}

/** Remove our own transport envelope; never summarize a summary recursively. */
export function cleanEngineHistory(messages: readonly Message[], handoffs: readonly Pick<ContextHandoff, "summaryText">[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    let content = message.content;
    for (const handoff of handoffs) {
      if (!content.startsWith(handoff.summaryText) || !handoff.summaryText) continue;
      const rest = content.slice(handoff.summaryText.length);
      if (rest.startsWith(HANDOFF_INPUT_SEPARATOR)) content = rest.slice(HANDOFF_INPUT_SEPARATOR.length);
      else if (rest.startsWith("\n\n---\n\n")) content = rest.slice("\n\n---\n\n".length);
      break;
    }
    return content === message.content ? message : { ...message, content };
  });
}

function signature(message: Message): string {
  return JSON.stringify([message.role, message.content, message.toolCalls, message.toolCallId,
    message.images, message.presentation?.attachments]);
}

/** Ids are opaque. Compare actual message boundaries, falling back to content. */
export function historyDeltaStart(current: readonly Message[], previous: readonly Message[]): number {
  if (!previous.length) return 0;
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length
    && signature(previous[prefix]) === signature(current[prefix])) prefix++;
  if (prefix === previous.length) return prefix;
  const last = previous[previous.length - 1];
  for (let index = current.length - 1; index >= 0; index--) {
    if (last.historyId && current[index].historyId === last.historyId) {
      return signature(current[index]) === signature(last) ? index + 1 : index;
    }
    if (signature(current[index]) === signature(last)) return index + 1;
  }
  // A compacted/replaced transcript must fail towards retaining context.
  return 0;
}

export function scopedHistory(messages: readonly Message[], sessionId: string, start = 0, phase = "origin"): Message[] {
  return messages.slice(start).map((message, offset) => {
    const attachments = [...(message.presentation?.attachments ?? [])];
    for (const [index, dataUrl] of (message.images ?? []).entries()) {
      if (!attachments.some((attachment) => attachment.dataUrl === dataUrl)) attachments.push({ type: "image", name: `image-${index + 1}`, dataUrl });
    }
    return {
      ...message,
      historyId: `${sessionId}:${phase}:${sessionHistoryMessageId(start + offset, message)}`,
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, id: `${sessionId}:${phase}:tool:${call.id}` })) } : {}),
      ...(message.toolCallId ? { toolCallId: `${sessionId}:${phase}:tool:${message.toolCallId}` } : {}),
      ...(message.presentation || attachments.length ? { presentation: { ...message.presentation, nativeMessageId: undefined,
        ...(message.presentation?.reasoning ? { reasoning: message.presentation.reasoning.map((section) => ({ ...section, itemId: `${sessionId}:${phase}:${section.itemId}` })) } : {}),
        ...(attachments.length ? { attachments } : {}) } } : {}),
    };
  });
}

/** Saved phases are immutable. Only the currently active phase reads live history. */
export function engineThreadPhases(
  records: readonly EngineSwitchRecord[],
  active: EngineSwitchSessionView,
  legacySources: ReadonlyMap<string, EngineSwitchSessionView> = new Map(),
  handoffs: readonly ContextHandoff[] = [],
): EngineThreadPhase[] {
  const previous = new Map<string, Message[]>();
  const phases: EngineThreadPhase[] = [];
  for (const record of records) {
    let snapshot = record.sourceSnapshot;
    let boundaryUncertain = false;
    if (!snapshot) {
      const live = cleanEngineHistory(legacySources.get(record.fromSessionId)?.messages ?? [], handoffs);
      const boundary = record.coveredThroughHistoryId
        ? live.findIndex((message) => message.historyId === record.coveredThroughHistoryId) : -1;
      snapshot = boundary >= 0 ? live.slice(0, boundary + 1) : live;
      boundaryUncertain = live.length > 0 && boundary < 0;
    }
    const start = historyDeltaStart(snapshot, previous.get(record.fromSessionId) ?? []);
    const messages = record.phaseMessages ?? scopedHistory(snapshot, record.fromSessionId, start, record.id);
    previous.set(record.fromSessionId, snapshot);
    phases.push({ sessionId: record.fromSessionId, agentType: record.fromAgentType, messages,
      ...(boundaryUncertain ? { boundaryUncertain: true } : {}) });
  }
  const current = cleanEngineHistory(active.messages, handoffs);
  phases.push({ sessionId: active.id, agentType: active.agentType,
    messages: scopedHistory(current, active.id, historyDeltaStart(current, previous.get(active.id) ?? []), records.at(-1)?.id ?? "origin") });
  return phases;
}

export function threadDisplayMessages(phases: readonly EngineThreadPhase[]): Message[] {
  const messages: Message[] = [];
  for (const [index, phase] of phases.entries()) {
    if (!phase.messages.length) continue;
    if (messages.length) messages.push({ role: "assistant", name: "__thread_switch__",
      historyId: `thread-switch:${index}:${phase.sessionId}`,
      content: `⟲ 已切换引擎 → ${phase.agentType}` });
    if (phase.boundaryUncertain) messages.push({ role: "assistant", name: "__thread_switch__",
      historyId: `thread-legacy:${index}:${phase.sessionId}`,
      content: "此段来自旧版切换记录，原记录未保存精确边界。" });
    messages.push(...phase.messages);
  }
  return messages;
}
