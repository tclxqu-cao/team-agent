import { describe, expect, it } from "vitest";
import { mergeSearchSessions, resolveChatSessionId } from "./session-search";

describe("session search and agent isolation", () => {
  it("includes unloaded workspace sessions and deduplicates loaded results", () => {
    const remote = [{ id: "unloaded", agentType: "opencode" }, { id: "loaded", agentType: "opencode" }];
    expect(mergeSearchSessions(remote, [{ id: "loaded", agentType: "opencode" }], "opencode"))
      .toEqual(remote);
  });
  it("does not mix agents in search", () => {
    expect(mergeSearchSessions([{ id: "other", agentType: "codex" }], [], "opencode")).toEqual([]);
  });
  it("does not reuse a running Codex session in an empty Harness view", () => {
    expect(resolveChatSessionId(null, "runtime:codex:running", "deepseek-harness", false)).toBeNull();
    expect(resolveChatSessionId(null, "legacy", "opencode", false)).toBeNull();
  });
  it("preserves same-agent voice sessions without leaking into workspace welcome", () => {
    expect(resolveChatSessionId(null, "runtime:codex:running", "codex", false)).toBe("runtime:codex:running");
    expect(resolveChatSessionId(null, "runtime:codex:running", "codex", true)).toBeNull();
    expect(resolveChatSessionId("runtime:opencode:selected", "runtime:codex:running", "opencode", false))
      .toBe("runtime:opencode:selected");
  });
});
