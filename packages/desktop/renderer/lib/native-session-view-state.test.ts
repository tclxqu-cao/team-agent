import { describe, expect, it } from "vitest";
import {
  isObservedNativeRun,
  isNativeRuntimeSelection,
  shouldQueueMessageForActiveRun,
  shouldFollowNativeHistory,
  shouldRestoreCustomerAgentRun,
  shouldRestoreLocalNativeRun,
  type NativeSessionViewState,
} from "./native-session-view-state";

const externalRunning = (agentType: "codex" | "claude-code"): NativeSessionViewState => ({
  agentType,
  status: "running",
  occupancy: "owned-externally",
});

describe("native session view state", () => {
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
    expect(shouldQueueMessageForActiveRun(session, false)).toBe(true);
  });

  it("restores a customer-agent run after the browser reloads", () => {
    const session: NativeSessionViewState = {
      agentType: "customer-agent",
      status: "active",
      occupancy: "available",
    };

    expect(shouldRestoreCustomerAgentRun(session)).toBe(true);
    expect(shouldRestoreLocalNativeRun(session)).toBe(false);
    expect(shouldQueueMessageForActiveRun(session, false)).toBe(false);
    expect(shouldQueueMessageForActiveRun(session, true)).toBe(true);
  });

  it.each(["codex", "claude-code", "opencode"] as const)(
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

  it("does not queue into an externally owned or idle native session", () => {
    expect(shouldQueueMessageForActiveRun(externalRunning("codex"), false)).toBe(false);
    expect(shouldQueueMessageForActiveRun({
      agentType: "codex",
      status: "idle",
      occupancy: "available",
    }, false)).toBe(false);
  });

  it("keeps locally tracked runs queueable regardless of summary lag", () => {
    expect(shouldQueueMessageForActiveRun(undefined, true)).toBe(true);
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
