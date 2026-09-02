import type { AgentEvent, ReasoningSummarySection, RuntimeProgress } from "./entities.js";

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

export function reduceRuntimeProgress(events: AgentEvent[]): RuntimeProgress[] {
  const progress = new Map<string, RuntimeProgress>();
  for (const event of events) {
    if (event.type === "runtime_progress") {
      const { type: _type, ...value } = event;
      progress.set(event.progressId, value);
      continue;
    }
    if (event.type === "done" || event.type === "turn_aborted" || event.type === "error") {
      progress.clear();
    }
  }
  return [...progress.values()];
}
