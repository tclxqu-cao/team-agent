import { describe, expect, it } from "vitest";
import {
  sortNewestSessionsFirst,
  sortRunningSessionsFirst,
} from "./sidebar-session-sort";

interface TestSession {
  id: string;
  created: string;
  running: boolean;
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

  it("puts running sessions first while keeping each group newest-first", () => {
    expect(sortRunningSessionsFirst(sessions, (session) => session.running).map((session) => session.id)).toEqual([
      "new-running",
      "old-running",
      "new-completed",
      "old-completed",
    ]);
  });

  it("does not mutate the cached session order", () => {
    const originalOrder = sessions.map((session) => session.id);
    sortRunningSessionsFirst(sessions, (session) => session.running);
    expect(sessions.map((session) => session.id)).toEqual(originalOrder);
  });
});
