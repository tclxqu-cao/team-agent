import { describe, expect, it } from "vitest";
import {
  isObservedNativeRun,
  shouldFollowNativeHistory,
  shouldRestoreLocalNativeRun,
  type NativeSessionViewState,
} from "./native-session-view-state";

const externalRunning = (agentType: "codex" | "claude-code"): NativeSessionViewState => ({
  agentType,
  status: "running",
  occupancy: "owned-externally",
});

describe("native session view state", () => {
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

  it("restores and exclusively streams a native run owned by Customer Agent", () => {
    const session: NativeSessionViewState = {
      agentType: "codex",
      status: "running",
      occupancy: "owned-by-customer-agent",
    };

    expect(shouldRestoreLocalNativeRun(session)).toBe(true);
    expect(isObservedNativeRun(session)).toBe(false);
    expect(shouldFollowNativeHistory(session, "session-1", "session-1")).toBe(false);
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
