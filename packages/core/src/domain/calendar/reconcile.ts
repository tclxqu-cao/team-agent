import type { CalendarEntry } from "./entities";

export function reconcileCalendarEntries(entries: CalendarEntry[], nowMs: number): CalendarEntry[] {
  const key = (entry: CalendarEntry) => entry.scheduleId && entry.scheduledAt !== undefined
    ? `${entry.source}:${entry.scheduleId}:${entry.scheduledAt}` : undefined;
  const runs = new Map<string, CalendarEntry>();
  for (const entry of entries) {
    const id = key(entry);
    if (entry.kind !== "run" || !id) continue;
    const previous = runs.get(id);
    if (!previous || (entry.executedAt ?? entry.at) > (previous.executedAt ?? previous.at)) runs.set(id, entry);
  }
  const merged = new Set<string>();
  const result: CalendarEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "run") continue;
    const id = key(entry);
    const run = id ? runs.get(id) : undefined;
    if (entry.kind === "cron" && run) {
      merged.add(id!);
      result.push({ ...entry, state: run.state, executedAt: run.executedAt ?? run.at,
        sessionId: run.sessionId ?? entry.sessionId, detail: run.detail ?? entry.detail });
    } else {
      result.push(entry.kind === "cron" && entry.state === "upcoming" && entry.at < nowMs
        ? { ...entry, state: "overdue" } : entry);
    }
  }
  const emitted = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "run") continue;
    const id = key(entry);
    if (id && (merged.has(id) || emitted.has(id) || runs.get(id) !== entry)) continue;
    if (id) emitted.add(id);
    result.push(entry);
  }
  return result;
}
