import type { SessionHistoryDetail } from "./session-history";
import { eventRunId, isRunResult, latestRunTerminalEvent, terminalRunError } from "./run-result";

/** Restore the last terminal failure, not a tool error or an earlier failed turn. */
export function latestSessionRunError(detail: SessionHistoryDetail | null): string | null {
  if (!detail || detail.status === "running" || detail.status === "active"
    || detail.history?.newerCursor || detail.history?.delivery === "trace") return null;
  const messages = detail.messages ?? [];
  const latestTurnStart = Math.max(0, messages.findLastIndex(message => message.role === "user"
    && message.name !== "__compaction_checkpoint__" && message.name !== "__native_steering_pending"
    && !message.name?.startsWith("__native_steered:")));
  const terminal = latestRunTerminalEvent(detail.events ?? []);
  if (terminal) {
    const runId = eventRunId(terminal);
    const owner = runId ? messages.findLastIndex(message => message.presentation?.runResult?.runId === runId
      || message.name === `__native_run:${runId}`) : -1;
    if (owner < 0 || owner >= latestTurnStart) return terminalRunError(terminal);
  }
  // An older failed turn cannot describe a newer turn whose result is not projected yet.
  for (let index = messages.length - 1; index >= latestTurnStart; index -= 1) {
    const projected = messages[index].presentation?.runResult;
    if (isRunResult(projected)) return terminalRunError({ type: "done", result: projected });
  }
  if (detail.status === "failed") return "运行失败，但未记录具体错误";
  return null;
}

export function runErrorRecoveryKind(message: string): "model" | "connection" | "other" {
  if (/^terminated$|OpenCode 2 .*response read failed: terminated|fetch failed|failed to fetch|load failed|network (?:request|connection)|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|连接.*(?:失败|超时)|事件流连接/i.test(message)) {
    return "connection";
  }
  if (/\b(?:429|402)\b|quota|rate.?limit|usage.*(?:limit|exceed)|credit|insufficient.*(?:balance|fund)|额度|限流|频率|余额|model.*(?:not found|unavailable|unsupported)|unsupported.*model/i.test(message)) {
    return "model";
  }
  return "other";
}

export function openRunErrorModelPicker(
  picker: (Pick<HTMLSelectElement, "focus"> & Partial<Pick<HTMLSelectElement, "showPicker">>) | null,
): void {
  picker?.focus();
  try { picker?.showPicker?.(); } catch { /* Focus remains available when native pickers are unsupported. */ }
}
