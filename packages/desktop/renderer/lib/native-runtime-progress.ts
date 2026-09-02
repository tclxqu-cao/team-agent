import type { AgentEvent, ReasoningSummarySection, RuntimeProgress } from "@agent/core";

export function mergeReasoningSummaryDelta(
  sections: ReasoningSummarySection[] | undefined,
  event: Extract<AgentEvent, { type: "reasoning_summary_delta" }>,
): ReasoningSummarySection[] {
  const current = sections ?? [];
  const index = current.findIndex((section) => (
    section.itemId === event.itemId && section.sectionIndex === event.sectionIndex
  ));
  const next = index < 0
    ? [...current, { itemId: event.itemId, sectionIndex: event.sectionIndex, text: event.delta }]
    : current.map((section, sectionIndex) => sectionIndex === index
      ? { ...section, text: section.text + event.delta }
      : section);
  return next.sort((left, right) => left.sectionIndex - right.sectionIndex);
}

export function reduceRuntimeProgressEvents(events: readonly AgentEvent[]): RuntimeProgress[] {
  let progress: RuntimeProgress[] = [];
  for (const event of events) {
    if (event.type === "runtime_progress") {
      const { type: _type, ...value } = event;
      progress = upsertRuntimeProgress(progress, value);
    } else if (event.type === "done" || event.type === "turn_aborted" || event.type === "error") {
      progress = [];
    }
  }
  return progress;
}

export function upsertRuntimeProgress(
  current: readonly RuntimeProgress[],
  progress: RuntimeProgress,
): RuntimeProgress[] {
  const index = current.findIndex((entry) => entry.progressId === progress.progressId);
  if (index < 0) return [...current, progress];
  return current.map((entry, entryIndex) => entryIndex === index ? progress : entry);
}

export function toolRuntimeProgress(
  progress: readonly RuntimeProgress[],
  toolCallId: string,
): RuntimeProgress | undefined {
  return [...progress].reverse().find((entry) => entry.toolCallId === toolCallId);
}

export function latestGlobalRuntimeProgress(
  progress: readonly RuntimeProgress[],
): RuntimeProgress | undefined {
  return [...progress].reverse().find((entry) => !entry.toolCallId);
}
