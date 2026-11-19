import { describe, expect, it } from "vitest";
import {
  getNativeRunObservation,
  isObservedNativeRun,
  isNativeRunVisible,
  isNativeRuntimeSelection,
  shouldQueueMessageForActiveRun,
  shouldFollowNativeHistory,
  shouldPollNativeHistoryFallback,
  prefersNativeHistoryPolling,
  shouldRestoreCustomerAgentRun,
  shouldRestoreLocalNativeRun,
  shouldDeferAnchoredSessionEvent,
  type NativeSessionViewState,
} from "./native-session-view-state";

it("polls even an idle Codex view when the client has no history observer", () => {
  const idle = { agentType: "codex" as const, status: "idle" as const, occupancy: "available" as const };
  expect(shouldPollNativeHistoryFallback(idle, false)).toBe(true);
  expect(shouldPollNativeHistoryFallback(idle, true)).toBe(false);
});

const externalRunning = (agentType: "codex" | "claude-code"): NativeSessionViewState => ({
  agentType,
  status: "running",
  occupancy: "owned-externally",
});

describe("native session view state", () => {
  it.each(["available", "owned-by-customer-agent", "owned-externally"] as const)(
    "shows an actively running native session independently of ownership: %s",
    (occupancy) => {
      const running = { agentType: "codex", status: "running", occupancy } as const;
      expect(isNativeRunVisible(running, "selected", false, null)).toBe(true);
      expect(isNativeRunVisible(running, "selected", false, { sessionId: "selected", running: true })).toBe(true);
      expect(isNativeRunVisible(running, "selected", false, { sessionId: "selected", running: false })).toBe(false);
    },
  );

  it("uses polled execution and completion instead of the selected session's cached status", () => {
    const idle = { agentType: "zcode", status: "idle", occupancy: "available" } as const;
    expect(isNativeRunVisible(idle, "selected", false, { sessionId: "selected", running: true })).toBe(true);
    expect(isNativeRunVisible({ ...idle, status: "running", occupancy: "owned-externally" }, "selected", false,
      { sessionId: "selected", running: false })).toBe(false);
  });

  it("keeps mobile-owned runs visible and ignores another session's observation", () => {
    const idle = { agentType: "zcode", status: "idle", occupancy: "available" } as const;
    expect(isNativeRunVisible(idle, "selected", true, { sessionId: "selected", running: false })).toBe(true);
    expect(isNativeRunVisible(idle, "selected", false, { sessionId: "previous", running: true })).toBe(false);
    expect(isNativeRunVisible({ ...idle, status: "running", occupancy: "owned-externally" }, "selected", false,
      { sessionId: "previous", running: false })).toBe(true);
  });

  it.each(["qoder", "zcode", "workbuddy"] as const)(
    "polls idle %s history when native transcript observation is unsupported",
    (agentType) => {
      const session = { agentType, status: "idle", occupancy: "available" } as const;
      expect(shouldPollNativeHistoryFallback(session)).toBe(true);
      expect(prefersNativeHistoryPolling(session)).toBe(true);
    },
  );

  it("preserves existing polling policy for other runtimes", () => {
    expect(shouldPollNativeHistoryFallback({ agentType: "codex", status: "idle", occupancy: "available" })).toBe(false);
    expect(shouldPollNativeHistoryFallback({ agentType: "codex", status: "running" })).toBe(true);
    expect(shouldPollNativeHistoryFallback({ agentType: "claude-code", occupancy: "owned-externally" })).toBe(true);
    expect(shouldPollNativeHistoryFallback({ agentType: "customer-agent" })).toBe(true);
    expect(shouldPollNativeHistoryFallback(undefined)).toBe(false);
    expect(prefersNativeHistoryPolling({ agentType: "codex" })).toBe(false);
    expect(prefersNativeHistoryPolling(undefined)).toBe(false);
  });
  it("settles runs while viewing older history without applying live transcript events", () => {
    const events = ["text_chunk", "tool_call", "thinking", "run_admitted", "done", "error", "turn_aborted"];
    expect(events.filter((type) => !shouldDeferAnchoredSessionEvent(type)))
      .toEqual(["run_admitted", "done", "error", "turn_aborted"]);
  });
  it("keeps a newly selected native runtime ready while its summary is still loading", () => {
    expect(isNativeRuntimeSelection(undefined, "codex")).toBe(true);
    expect(isNativeRuntimeSelection(undefined, "claude-code")).toBe(true);
    expect(isNativeRuntimeSelection(undefined, "opencode")).toBe(true);
    expect(isNativeRuntimeSelection(undefined, "customer-agent")).toBe(false);
  });

  it("prefers the selected session runtime once its summary is available", () => {
    expect(isNativeRuntimeSelection({ agentType: "codex" }, "customer-agent")).toBe(true);
    expect(isNativeRuntimeSelection({ agentType: "customer-agent" }, "codex")).toBe(false);
  });

  it.each(["codex", "claude-code"] as const)(
    "keeps an externally owned %s run visible without restoring local ownership",
    (agentType) => {
      const session = externalRunning(agentType);

      expect(isObservedNativeRun(session)).toBe(true);
      expect(shouldRestoreLocalNativeRun(session)).toBe(false);
    },
  );

  it.each(["codex", "claude-code"] as const)(
    "continues following externally owned %s history even with a stale local running id",
    (agentType) => {
      expect(shouldFollowNativeHistory(externalRunning(agentType), "session-1", "session-1"))
        .toBe(true);
    },
  );

  it("restores and reconciles a native run owned by Customer Agent", () => {
    const session: NativeSessionViewState = {
      agentType: "codex",
      status: "running",
      occupancy: "owned-by-customer-agent",
    };

    expect(shouldRestoreLocalNativeRun(session)).toBe(true);
    expect(isObservedNativeRun(session)).toBe(false);
    expect(shouldFollowNativeHistory(session, "session-1", "session-1")).toBe(true);
    const observation = getNativeRunObservation("session-1", {
      ...session, snapshotRunId: "run-1", snapshotRunStatus: "active",
    });
    expect(observation.controllableRunId).toBe("run-1");
    expect(shouldQueueMessageForActiveRun("session-1", false, observation)).toBe(true);
    expect(shouldQueueMessageForActiveRun("session-2", false, observation)).toBe(false);
  });

  it("restores a customer-agent run after the browser reloads", () => {
    const session: NativeSessionViewState = {
      agentType: "customer-agent",
      status: "active",
      occupancy: "available",
    };

    expect(shouldRestoreCustomerAgentRun(session)).toBe(true);
    expect(shouldRestoreLocalNativeRun(session)).toBe(false);
    expect(shouldQueueMessageForActiveRun("session-1", false, null)).toBe(false);
    expect(shouldQueueMessageForActiveRun("session-1", true, null)).toBe(true);
  });

  it("observes a shared VS Code turn without restoring a nonexistent broker run or queueing behind it", () => {
    const session: NativeSessionViewState = { agentType: "copilot", status: "running", occupancy: "available" };
    expect(isObservedNativeRun(session)).toBe(true);
    expect(shouldRestoreLocalNativeRun(session)).toBe(false);
    const snapshot = { ...session, snapshotRunId: "run-1", snapshotRunStatus: "active" } as const;
    expect(shouldQueueMessageForActiveRun("session-1", false, getNativeRunObservation("session-1", snapshot))).toBe(false);
    const managed = getNativeRunObservation("session-1", { ...snapshot, occupancy: "owned-by-customer-agent" });
    expect(shouldQueueMessageForActiveRun("session-1", false, managed)).toBe(true);
  });

  it.each(["codex", "claude-code", "opencode", "deepseek-harness"] as const)(
    "follows an available idle %s session so later transcript writes appear without a reload",
    (agentType) => {
      expect(shouldFollowNativeHistory({
        agentType,
        status: "idle",
        occupancy: "available",
      }, "session-1", null)).toBe(true);
    },
  );

  it("does not follow Customer Agent sessions or an absent selection", () => {
    expect(shouldFollowNativeHistory({
      agentType: "customer-agent",
      status: "idle",
      occupancy: "available",
    }, "session-1", null)).toBe(false);
    expect(shouldFollowNativeHistory({ agentType: "codex" }, null, null)).toBe(false);
    expect(shouldFollowNativeHistory(undefined, "session-1", null)).toBe(false);
  });

  it.each(["codex", "claude-code", "zcode"] as const)(
    "clears controls when the current %s detail supersedes a running list entry",
    (agentType) => {
      const summary = { agentType, status: "running", occupancy: "owned-by-customer-agent" } as const;
      const detail = { ...summary, status: "idle", snapshotRunId: "old", snapshotRunStatus: "terminal" } as const;
      const observation = getNativeRunObservation("session-1", detail);
      expect(isNativeRunVisible(summary, "session-1", false, observation)).toBe(false);
      expect(shouldQueueMessageForActiveRun("session-1", false, observation)).toBe(false);
    },
  );

  it("keeps an external run visible even when a previous broker run is retained", () => {
    const session = externalRunning("codex");
    const observation = getNativeRunObservation("session-1", {
      ...session, snapshotRunId: "old", snapshotRunStatus: "terminal",
    });
    expect(isNativeRunVisible(session, "session-1", false, observation)).toBe(true);
    expect(shouldQueueMessageForActiveRun("session-1", false, observation)).toBe(false);
  });

  it("requires a run identity for controls restored from a broker snapshot", () => {
    const observation = getNativeRunObservation("session-1", {
      agentType: "zcode", status: "running", occupancy: "owned-by-customer-agent", snapshotRunStatus: "active",
    });
    expect(observation.running).toBe(true);
    expect(shouldQueueMessageForActiveRun("session-1", false, observation)).toBe(false);
  });

  it("keeps locally tracked runs queueable regardless of summary lag", () => {
    expect(shouldQueueMessageForActiveRun("session-1", true, null)).toBe(true);
  });

  it("does not present an externally owned idle session as actively running", () => {
    const session: NativeSessionViewState = {
      agentType: "codex",
      status: "idle",
      occupancy: "owned-externally",
    };

    expect(isObservedNativeRun(session)).toBe(false);
    expect(shouldRestoreLocalNativeRun(session)).toBe(false);
    expect(shouldFollowNativeHistory(session, "session-1", null)).toBe(true);
  });
});
