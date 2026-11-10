import { describe, expect, it } from "vitest";
import type { CatalogSession } from "../../../core/src/domain/supervision/types";
import { ALL_SESSIONS_CACHE_KEY, readAllSessionsCache, writeAllSessionsCache } from "./all-sessions-cache";

const session = (id: string): CatalogSession => ({
  id, agentType: "codex", title: id, cwd: "/project", updated: "2026-11-09", status: "idle", canResume: true,
});

describe("all sessions first-page cache", () => {
  it("restores the most recent first page and total without reusing a server cursor", () => {
    let saved = "";
    writeAllSessionsCache({ data: [session("recent")], total: 2620, nextCursor: "expired-server-cursor" }, {
      setItem: (key, value) => { expect(key).toBe(ALL_SESSIONS_CACHE_KEY); saved = value; },
    });
    const cached = readAllSessionsCache({ getItem: () => saved });
    expect(cached).toEqual({ data: [session("recent")], total: 2620 });
    expect(saved).not.toContain("expired-server-cursor");
  });

  it("bounds persisted rows to the first 20 summaries", () => {
    let saved = "";
    writeAllSessionsCache({ data: Array.from({ length: 45 }, (_, index) => session(String(index))), total: 45, nextCursor: null }, {
      setItem: (_key, value) => { saved = value; },
    });
    const cached = readAllSessionsCache({ getItem: () => saved });
    expect(cached?.data).toHaveLength(20);
    expect(cached?.data.at(-1)?.id).toBe("19");
    expect(cached?.total).toBe(45);
  });

  it("keeps a successful empty catalog so stale rows are not restored later", () => {
    let saved = "";
    writeAllSessionsCache({ data: [], total: 0, nextCursor: null }, { setItem: (_key, value) => { saved = value; } });
    expect(readAllSessionsCache({ getItem: () => saved })).toEqual({ data: [], total: 0 });
  });

  it("discards incompatible, incomplete or corrupt stored data", () => {
    const valid = { version: 1, data: [session("cached")], total: 1 };
    for (const value of [null, { ...valid, version: 0 }, { ...valid, total: -1 },
      { ...valid, data: [{ ...session("broken"), status: "unexpected" }] },
      { ...valid, data: [{ ...session("broken"), agentType: "unknown" }] },
      { ...valid, data: [{ ...session("broken"), title: null }] }]) {
      expect(readAllSessionsCache({ getItem: () => JSON.stringify(value) })).toBeNull();
    }
    expect(readAllSessionsCache({ getItem: () => "{" })).toBeNull();
  });

  it("allows refresh to continue when browser storage is blocked or full", () => {
    expect(readAllSessionsCache({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(() => writeAllSessionsCache({ data: [session("fresh")], total: 1, nextCursor: null }, {
      setItem: () => { throw new Error("full"); },
    })).not.toThrow();
  });
});
