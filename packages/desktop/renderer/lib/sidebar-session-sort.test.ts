import { describe, expect, it } from "vitest";
import {
  orderSessionsForAgent,
  sortNewestSessionsFirst,
  sortPinnedSessionsFirst,
  sortRunningSessionsFirst,
} from "./sidebar-session-sort";

interface TestSession {
  id: string;
  created: string;
  running: boolean;
  pinned?: boolean;
}

const sessions: TestSession[] = [
  { id: "old-running", created: "2026-09-01T08:00:00.000Z", running: true },
  { id: "new-completed", created: "2026-09-02T10:00:00.000Z", running: false },
  { id: "new-running", created: "2026-09-02T09:00:00.000Z", running: true },
  { id: "old-completed", created: "2026-09-01T09:00:00.000Z", running: false },
];

describe("sidebar session sorting", () => {
  it("puts newly created sessions first by default", () => {
    expect(sortNewestSessionsFirst(sessions).map((session) => session.id)).toEqual([
      "new-completed",
      "new-running",
      "old-completed",
      "old-running",
    ]);
  });

  it("puts running sessions first while preserving source order inside each group", () => {
    expect(sortRunningSessionsFirst(sessions, (session) => session.running).map((session) => session.id)).toEqual([
      "old-running",
      "new-running",
      "new-completed",
      "old-completed",
    ]);
  });

  it("preserves runtime source order for Codex and creation order for other agents", () => {
    expect(orderSessionsForAgent(sessions, "codex").map((session) => session.id)).toEqual([
      "old-running",
      "new-completed",
      "new-running",
      "old-completed",
    ]);
    expect(orderSessionsForAgent(sessions, "customer-agent").map((session) => session.id)).toEqual([
      "new-completed",
      "new-running",
      "old-completed",
      "old-running",
    ]);
  });

  it("does not mutate the cached session order", () => {
    const originalOrder = sessions.map((session) => session.id);
    sortRunningSessionsFirst(sessions, (session) => session.running);
    expect(sessions.map((session) => session.id)).toEqual(originalOrder);
  });

  it("puts pinned sessions before running sessions while preserving each partition order", () => {
    const withPinned = sessions.map((session) => ({
      ...session,
      pinned: session.id === "new-completed" || session.id === "old-running",
    }));
    const runningFirst = sortRunningSessionsFirst(
      sortNewestSessionsFirst(withPinned),
      (session) => session.running,
    );

    expect(sortPinnedSessionsFirst(runningFirst, (session) => session.pinned).map((session) => session.id)).toEqual([
      "old-running",
      "new-completed",
      "new-running",
      "old-completed",
    ]);
  });

  it("stably partitions pinned sessions without mutating the input", () => {
    const originalOrder = sessions.map((session) => session.id);
    const result = sortPinnedSessionsFirst(sessions, (session) => session.id.endsWith("completed"));

    expect(result.map((session) => session.id)).toEqual([
      "new-completed",
      "old-completed",
      "old-running",
      "new-running",
    ]);
    expect(sessions.map((session) => session.id)).toEqual(originalOrder);
  });
});
