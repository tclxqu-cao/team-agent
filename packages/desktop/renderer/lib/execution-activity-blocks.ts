import type { ChatMessage } from "../stores/agentStore";
import type { ChatToolCall } from "./tool-call-groups";
import { toolPhrase } from "./tool-call-presentation";

export function executionSummaryPreview(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.findLast((line) => /^(?:#{1,6}\s|\*\*[^*]+\*\*$)/.test(line));
  const paragraph = text.trim().split(/\r?\n\s*\r?\n/).at(-1)?.split(/\r?\n/)[0]?.trim();
  return (heading ?? paragraph ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function reasoningPreview(message: ChatMessage): string | undefined {
  const sections = message.presentation?.reasoning;
  if (!sections?.length) return undefined;
  const last = [...sections].sort((a, b) => b.sectionIndex - a.sectionIndex)
    .find((section) => section.text.trim());
  return last ? executionSummaryPreview(last.text) || undefined : undefined;
}

export function latestExecutionSummary(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const preview = reasoningPreview(messages[index]);
    if (preview) return preview;
  }
  const commentary = messages.findLast((message) => message.content.trim());
  return commentary ? executionSummaryPreview(commentary.content) || undefined : undefined;
}

export type ExecutionActivityRow =
  | { kind: "commentary"; id: string; content: string }
  | { kind: "activity"; id: string; summary: string; toolCalls: ChatToolCall[] };

/** Fold mixed operations between visible paragraphs without rewriting native history. */
export function executionActivityRows(messages: readonly ChatMessage[]): ExecutionActivityRow[] {
  const rows: ExecutionActivityRow[] = [];
  let pending: Extract<ExecutionActivityRow, { kind: "activity" }> | undefined;
  let summary: string | undefined;
  let fallback: string | undefined;
  let scope: string | undefined;
  const flush = () => {
    if (pending) rows.push({ ...pending, summary: pending.summary
      || [...new Set(pending.toolCalls.map((tool) => toolPhrase(tool.name)?.done ?? "调用了工具"))].join("、") });
    pending = undefined;
  };
  for (const message of messages) {
    const owner = message.presentation?.executionTrace;
    const nextScope = owner ? JSON.stringify([owner.turnId, owner.segmentIndex ?? 0]) : undefined;
    const boundary = message.role !== "assistant" || message.askUser || message.widget || message.isCompactionSummary
      || message.images?.length || message.presentation?.attachments?.length || message.agentName;
    if (boundary || (scope !== undefined && nextScope !== undefined && nextScope !== scope)) {
      flush();
      summary = fallback = undefined;
      scope = nextScope;
      if (boundary) continue;
    }
    if (nextScope !== undefined) scope = nextScope;
    if (message.presentation?.agentMessagePhase === "commentary" && message.content.trim()) {
      flush();
      summary = undefined;
      fallback = executionSummaryPreview(message.content);
      rows.push({ kind: "commentary", id: message.id, content: message.content.trim() });
    }
    const preview = reasoningPreview(message);
    if (preview) {
      summary = preview;
      if (pending) pending.summary = preview;
    }
    if (message.toolCalls?.length) {
      pending ??= { kind: "activity", id: message.toolCalls[0].id,
        summary: summary || fallback || "", toolCalls: [] };
      pending.toolCalls.push(...message.toolCalls);
    }
  }
  flush();
  return rows;
}
