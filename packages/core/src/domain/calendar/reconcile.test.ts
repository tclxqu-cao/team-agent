import { describe, expect, it } from "vitest";
import { reconcileCalendarEntries } from "./reconcile";
import type { CalendarEntry } from "./entities";

const plan: CalendarEntry = { id: "plan", source: "codex", kind: "cron", title: "Wiki", at: 100, scheduledAt: 100, scheduleId: "wiki", state: "upcoming" };
const run: CalendarEntry = { ...plan, id: "run", kind: "run", at: 130, executedAt: 130, state: "completed" };

describe("reconcileCalendarEntries", () => {
  it("replaces a schedule occurrence with its result instead of duplicating it", () => {
    expect(reconcileCalendarEntries([plan, run], 150)).toEqual([{ ...plan, state: "completed", executedAt: 130, sessionId: undefined, detail: undefined }]);
  });
  it("marks elapsed schedules without evidence overdue, not completed or failed", () => {
    expect(reconcileCalendarEntries([plan], 150)[0]?.state).toBe("overdue");
    expect(reconcileCalendarEntries([plan], 50)[0]?.state).toBe("upcoming");
  });
  it("keeps failure evidence and a running result", () => {
    for (const state of ["failed", "in-progress"] as const) expect(reconcileCalendarEntries([plan, { ...run, state }], 150)[0]?.state).toBe(state);
  });
  it("does not match the same title from another schedule or source", () => {
    expect(reconcileCalendarEntries([plan, { ...run, scheduleId: "another" }], 150)).toHaveLength(2);
    expect(reconcileCalendarEntries([plan, { ...run, source: "zcode" }], 150)).toHaveLength(2);
  });
  it("deduplicates a retried occurrence using its latest result", () => {
    const retry = { ...run, id: "retry", executedAt: 140, state: "failed" as const };
    expect(reconcileCalendarEntries([plan, run, retry], 150)[0]?.state).toBe("failed");
    expect(reconcileCalendarEntries([run, retry], 150)).toEqual([retry]);
  });
  it("preserves paused schedules and standalone historic runs", () => {
    const paused = { ...plan, state: "paused" as const };
    expect(reconcileCalendarEntries([paused], 150)).toEqual([paused]);
    const standalone = { ...run, scheduleId: undefined };
    expect(reconcileCalendarEntries([standalone], 150)).toEqual([standalone]);
  });
});
