import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary, WorkspacePage } from "@agent/native-runtime";
import { WorkspaceSessionCache } from "./workspace-session-cache";

const page = (id: string): WorkspacePage<UnifiedSessionSummary> => ({
  data: [{ id } as UnifiedSessionSummary], nextCursor: "older", watermark: id,
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("workspace session cache", () => {
  it("returns cached rows during slow discovery, shares refreshes, then exposes fresh rows", async () => {
    let finish!: (value: WorkspacePage<UnifiedSessionSummary>) => void;
    const load = vi.fn().mockResolvedValueOnce(page("cached"))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cache = new WorkspaceSessionCache(() => 100);
    const first = await cache.read("codex/repo/20", { refresh: true, limit: 20 }, load);
    expect(first).toMatchObject({ data: [{ id: "cached" }], refreshing: true });
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => cache.read("codex/repo/20", { refresh: true, limit: 20 }, load)));
    expect(concurrent.every(result => result.refreshing)).toBe(true);
    expect(load.mock.calls).toEqual([[{ refresh: false, limit: 20 }], [{ refresh: true, limit: 20 }]]);
    finish(page("fresh"));
    await flush();
    expect(await cache.read("codex/repo/20", { refresh: true, limit: 20 }, load)).toEqual(page("fresh"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates cold reads and preserves pagination parameters", async () => {
    let finish!: (value: WorkspacePage<UnifiedSessionSummary>) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(page("history"));
    const cache = new WorkspaceSessionCache();
    const first = cache.read("repo/20", { limit: 20 }, load);
    const second = cache.read("repo/20", { limit: 20 }, load);
    await flush();
    expect(load).toHaveBeenCalledOnce();
    finish(page("head"));
    expect(await first).toEqual(await second);
    const query = { cursor: "older", limit: 50, refresh: false };
    expect(await cache.read("repo/20", query, load)).toEqual(page("history"));
    expect(load).toHaveBeenLastCalledWith(query);
  });

  it("keeps cached rows on refresh failure, backs off, and recovers", async () => {
    let now = 100;
    const cache = new WorkspaceSessionCache(() => now);
    const load = vi.fn().mockResolvedValueOnce(page("cached"))
      .mockRejectedValueOnce(new Error("runtime disconnected")).mockResolvedValue(page("recovered"));
    await cache.read("repo", { refresh: true }, load);
    await flush();
    expect(await cache.read("repo", { refresh: true }, load)).toMatchObject({ data: [{ id: "cached" }], stale: true });
    expect(load).toHaveBeenCalledTimes(2);
    now += 5_001;
    expect(await cache.read("repo", { refresh: true }, load)).toMatchObject({ refreshing: true });
    await flush();
    expect(await cache.read("repo", { refresh: true }, load)).toEqual(page("recovered"));
  });

  it("propagates cold failures and invalidates pages without restoring an older in-flight result", async () => {
    const cache = new WorkspaceSessionCache();
    const failed = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page("retry"));
    await expect(cache.read("repo", {}, failed)).rejects.toThrow("offline");
    expect(await cache.read("repo", {}, failed)).toEqual(page("retry"));
    let finish!: (value: WorkspacePage<UnifiedSessionSummary>) => void;
    const old = vi.fn(() => new Promise<WorkspacePage<UnifiedSessionSummary>>(resolve => { finish = resolve; }));
    await cache.read("repo", { refresh: true }, old);
    await flush();
    cache.clear();
    const fresh = vi.fn().mockResolvedValue(page("after-delete"));
    await cache.read("repo", {}, fresh);
    finish(page("before-delete"));
    await flush();
    expect(await cache.read("repo", {}, fresh)).toEqual(page("after-delete"));
  });
});
