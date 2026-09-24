import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionDraft,
  readSessionDraft,
  resolveSessionDraftAction,
  writeSessionDraft,
} from "./session-draft";

describe("session drafts", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps drafts isolated by unified session id", () => {
    writeSessionDraft("runtime:codex:first", "first draft");
    writeSessionDraft("runtime:claude-code:second", "second draft");

    expect(readSessionDraft("runtime:codex:first")).toBe("first draft");
    expect(readSessionDraft("runtime:claude-code:second")).toBe("second draft");
  });

  it("clears only the accepted session draft", () => {
    writeSessionDraft("one", "keep me");
    writeSessionDraft("two", "remove me");
    clearSessionDraft("two");

    expect(readSessionDraft("one")).toBe("keep me");
    expect(readSessionDraft("two")).toBe("");
  });

  it("restores the first selected Customer Agent session instead of carrying visible text", () => {
    expect(resolveSessionDraftAction(null, "ca-session", "carried text"))
      .toEqual({ type: "restore", ownerSessionId: "ca-session" });
  });

  it("restores the target session when switching between agent types", () => {
    expect(resolveSessionDraftAction("ca-session", "runtime:codex:one", "ca draft"))
      .toEqual({ type: "restore", ownerSessionId: "runtime:codex:one" });
  });

  it("persists visible text only when the viewed session still owns it", () => {
    expect(resolveSessionDraftAction("ca-session", "ca-session", "current draft"))
      .toEqual({ type: "persist", ownerSessionId: "ca-session", value: "current draft" });
  });

  it("stops synchronizing when there is no viewed session", () => {
    expect(resolveSessionDraftAction("ca-session", null, "current draft"))
      .toEqual({ type: "inactive", ownerSessionId: null });
  });
});
