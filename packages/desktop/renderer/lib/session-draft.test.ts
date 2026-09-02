import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from "./session-draft";

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
});
