import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogSession, SessionCatalogPage } from "../../../../core/src/domain/supervision/types";
import { readTaskCatalogCache, readTaskCatalogWindow, writeTaskCatalogCache } from "./task-session-catalog";

const row = (index: number): CatalogSession => ({
  id: String(index), title: `任务 ${index}`, agentType: "codex", cwd: "/work",
  updated: "2026-11-23T00:00:00Z", status: "idle", canResume: true,
});

const page = (start: number, limit: number, total = 220): SessionCatalogPage => ({
  data: Array.from({ length: Math.min(limit, total - start) }, (_, index) => row(start + index)),
  nextCursor: start + limit < total ? `new:${start + limit}` : null,
  total,
});

afterEach(() => vi.unstubAllGlobals());

describe("task picker catalog window", () => {
  it("reopens the loaded window with a new cursor without persisting the old one", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } });
    const signal = new AbortController().signal;
    const read = vi.fn(async (cursor?: string, limit = 30) => page(Number(cursor?.split(":")[1] ?? 0), limit));
    const first = await readTaskCatalogWindow(read, { rows: [], count: 0, cursor: null }, false, signal);
    const expanded = await readTaskCatalogWindow(read, first, true, signal);
    writeTaskCatalogCache(expanded);
    const cached = readTaskCatalogCache()!;
    expect(cached).toEqual({ count: 60, rows: [...page(0, 60).data] });
    read.mockClear();

    const reopened = await readTaskCatalogWindow(read, { ...cached, cursor: null }, false, signal);
    expect(read.mock.calls).toEqual([[undefined, 60]]);
    expect(reopened).toEqual(expanded);
  });

  it("rebuilds windows beyond one server page and counts results separately from ancestors", async () => {
    const signal = new AbortController().signal;
    const parent = row(900);
    const read = vi.fn()
      .mockResolvedValueOnce({ ...page(0, 100), ancestors: [parent] })
      .mockResolvedValueOnce(page(100, 20));
    const result = await readTaskCatalogWindow(read, { rows: page(0, 120).data, count: 120, cursor: null }, false, signal);
    expect(read.mock.calls).toEqual([[undefined, 100], ["new:100", 20]]);
    expect(result).toMatchObject({ count: 120, cursor: "new:120" });
    expect(result.rows).toHaveLength(121);
  });

  it("recovers expired pagination at the next depth in a fresh snapshot", async () => {
    const signal = new AbortController().signal;
    const read = vi.fn().mockRejectedValueOnce(new Error("会话列表已更新，请刷新重新加载"))
      .mockResolvedValueOnce(page(0, 90));
    const result = await readTaskCatalogWindow(read, { rows: page(0, 60).data, count: 60, cursor: "old:60" }, true, signal);
    expect(read.mock.calls).toEqual([["old:60", 30], [undefined, 90]]);
    expect(result).toMatchObject({ count: 90, cursor: "new:90" });
  });

  it("keeps loaded sessions while discovery returns only a partial page", async () => {
    const previous = { rows: page(0, 60).data, count: 60, cursor: null };
    const read = vi.fn().mockResolvedValue({ ...page(0, 0, 0), refreshing: true });
    await expect(readTaskCatalogWindow(read, previous, false, new AbortController().signal))
      .resolves.toEqual({ ...previous, refreshing: true });
  });
});
