import type { MessagePresentation, RunResult } from "@agent/core";
import { classifyRunError, normalizeTokenUsage, runResultLabel } from "../../../core/src/domain/agent/run-result";
import type { ChatMessage } from "../stores/agentStore";
import { formatCompletionDuration, validCompletionDurationMs } from "./message-actions";

export interface RunResultEvent {
  type?: string;
  result?: unknown;
  usage?: unknown;
  durationMs?: number;
  runId?: string;
  _runId?: string;
  _nativeRunId?: string;
  turnId?: string;
  code?: string;
  message?: string;
  _preserveActiveRun?: boolean;
}

export function isRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<RunResult>;
  return ["completed", "failed", "cancelled", "interrupted"].includes(result.status ?? "")
    && typeof result.reason === "string"
    && validCompletionDurationMs(result.durationMs) !== undefined;
}

export function isRunTerminalEvent(event: RunResultEvent): boolean {
  return ["done", "error", "turn_aborted"].includes(event.type ?? "")
    && !event._preserveActiveRun
    && !["SESSION_OCCUPIED", "SESSION_ALREADY_RUNNING", "CANCEL_CONFIRMATION_TIMEOUT"].includes(event.code ?? "");
}

export function eventRunId(event: RunResultEvent): string | undefined {
  return (isRunResult(event.result) ? event.result.runId : undefined)
    ?? event.runId ?? event._runId ?? event._nativeRunId ?? event.turnId;
}

/** No result is invented from a disconnect, a context estimate, or imported text. */
export function eventRunResult(event: RunResultEvent): RunResult | undefined {
  if (!isRunTerminalEvent(event) || !isRunResult(event.result)) return undefined;
  const usage = normalizeTokenUsage(event.result.usage) ?? normalizeTokenUsage(event.usage);
  const { usage: _usage, ...result } = event.result;
  const runId = eventRunId(event);
  return { ...result, ...(runId ? { runId } : {}), ...(usage ? { usage } : {}) };
}

/** The first terminal owns the status. Later reports may only fill missing usage. */
export function mergeRunResult(first: RunResult | undefined, next: RunResult): RunResult {
  if (!first || (first.runId && next.runId && first.runId !== next.runId)) return next;
  const usage = normalizeTokenUsage(first.usage) ?? normalizeTokenUsage(next.usage);
  return { ...first, ...(usage ? { usage } : {}) };
}

export function mergeRunResultPresentation(
  previous: MessagePresentation | undefined,
  next: MessagePresentation | undefined,
): MessagePresentation | undefined {
  const result = next?.runResult
    ? mergeRunResult(previous?.runResult, next.runResult)
    : previous?.runResult;
  if (!result) return next ?? previous;
  return { ...previous, ...next, runResult: result };
}

export function runResultTargetMessage(
  messages: readonly ChatMessage[],
  runId?: string,
): ChatMessage | undefined {
  const existing = runId ? messages.find((message) => message.presentation?.runResult?.runId === runId) : undefined;
  if (existing) return existing;
  let turnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && !message.isQueued && !message.isSteered && !message.isCompactionSummary) {
      turnStart = index;
      break;
    }
  }
  if (turnStart < 0) return undefined;
  // Never put a new turn's failure on the preceding turn's assistant response.
  for (let index = messages.length - 1; index > turnStart; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant"
      && !message.executionTrace && !message.toolCalls?.length && !message.isCompactionSummary && !message.askUser && !message.widget
      && message.presentation?.agentMessagePhase !== "commentary" && message.content.trim()) return message;
  }
  return messages[turnStart];
}

export function applyRunResultToMessages(messages: ChatMessage[], event: RunResultEvent): ChatMessage[] {
  const result = eventRunResult(event);
  if (!result) return messages;
  const target = runResultTargetMessage(messages, result.runId);
  if (!target) return messages;
  return messages.map((message) => message.id === target.id ? {
    ...message,
    presentation: {
      ...message.presentation,
      runResult: mergeRunResult(message.presentation?.runResult, result),
    },
  } : message);
}

/** Older errors may lack a result; fill it only when a later actual result arrives. */
export function authoritativeRunResultEvent(first: RunResultEvent, next: RunResultEvent): RunResultEvent {
  const result = eventRunResult(next);
  if (!result || eventRunResult(first) || first === next) return next;
  const reason = first.type === "error" ? classifyRunError(first.message ?? "", first.code)
    : first.type === "turn_aborted" ? "user_cancelled" : "completed";
  const status = reason === "user_cancelled" ? "cancelled"
    : reason === "runtime_interrupted" ? "interrupted" : first.type === "error" ? "failed" : "completed";
  return { ...next, result: { ...result, status, reason } };
}

/** Live callers reset on admission; same-run cleanup must not turn a failure into success. */
export function firstRunTerminalEvent<T extends RunResultEvent>(first: T | undefined, next: T): T {
  if (!first) return next;
  const firstId = eventRunId(first);
  const nextId = eventRunId(next);
  return firstId && nextId && firstId !== nextId ? next : first;
}

/** History is chronological: choose the latest run, not the last duplicate terminal. */
export function latestRunTerminalEvent<T extends RunResultEvent>(events: readonly T[]): T | undefined {
  const seenRuns = new Set<string>();
  let latest: T | undefined;
  for (const event of events) {
    if (event.type === "run_admitted") {
      latest = undefined;
      continue;
    }
    if (!isRunTerminalEvent(event)) continue;
    const runId = eventRunId(event);
    if (runId) {
      if (seenRuns.has(runId)) continue;
      seenRuns.add(runId);
    } else if (latest?.type === "error" && !eventRunId(latest) && event.type !== "error") {
      // Legacy error -> done has no evidence of a different run succeeding.
      continue;
    }
    latest = event;
  }
  return latest;
}

export function terminalRunError(event: RunResultEvent): string | null {
  const result = eventRunResult(event);
  if (result && result.status !== "failed" && result.status !== "interrupted") return null;
  if (event.type !== "error" && !result) return null;
  return event.message?.trim() || (result ? runResultLabel(result) : "运行失败，但未记录具体错误");
}

export function formatRunResultSummary(result: RunResult): string {
  const duration = formatCompletionDuration(result.durationMs);
  const usage = normalizeTokenUsage(result.usage);
  return [
    runResultLabel(result),
    duration ? `总耗时 ${duration}` : "耗时未知",
    usage
      ? `输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token${usage.coverage === "partial" ? "（部分统计）" : ""}`
      : "token 未知",
  ].join(" · ");
}
