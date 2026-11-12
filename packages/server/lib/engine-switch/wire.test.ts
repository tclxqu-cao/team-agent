import { describe, expect, it } from "vitest";
import type { ContextHandoff } from "@agent/core";
import { handoffForWire } from "./wire";

function handoff(count: number): ContextHandoff {
  return {
    id: "h1",
    threadKey: "t1",
    fromSessionId: "a",
    fromAgentType: "codex",
    toSessionId: "b",
    toAgentType: "claude-code",
    strategy: "full",
    summaryText: "summary",
    omittedHistoryIds: Array.from({ length: count }, (_, i) => `seq-${i}`),
    status: "pending",
    createdBy: "system",
    created: "2026-11-12T00:00:00.000Z",
    consumedAt: null,
  };
}

describe("handoffForWire", () => {
  it("keeps the stored artifact intact and trims the wire list to the newest ids", () => {
    const stored = handoff(500);
    const wire = handoffForWire(stored);
    expect(stored.omittedHistoryIds).toHaveLength(500); // artifact untouched
    expect(wire.omittedHistoryIds).toHaveLength(20);
    expect(wire.omittedHistoryIds.at(-1)).toBe("seq-499");
    expect(wire.omittedCount).toBe(500);
  });

  it("leaves short lists untouched", () => {
    const wire = handoffForWire(handoff(3));
    expect(wire.omittedHistoryIds).toHaveLength(3);
    expect(wire.omittedCount).toBe(3);
  });
});
