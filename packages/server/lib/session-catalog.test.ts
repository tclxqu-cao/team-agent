import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "@agent/native-runtime";
const mocks = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn(), ca: vi.fn(), summaries: vi.fn(), projects: vi.fn() }));
vi.mock("../app/api/agent-host", () => ({ agentHost: { getSessionStore: () => ({ list: mocks.ca, listSummaries: mocks.summaries }), getProjectStore: () => ({ list: mocks.projects }), isSessionRunning: () => false } }));
vi.mock("./native-runtime-service", () => ({ getNativeRuntimeService: () => ({ list: mocks.list, refresh: mocks.refresh }), runtimeErrorStatus: () => 500 }));
vi.mock("./collaboration/visibility", () => ({ collaborationSessionIds: () => new Set(["internal"]) }));
import { querySessionCatalog } from "./session-catalog";
import { GET } from "../app/api/sessions/route";

function session(index: number): UnifiedSessionSummary {
  return { id: `codex:${index}`, agentType: "codex", nativeSessionId: `${index}`, title: index === 44 ? "目录外分页可搜索的任务" : `任务 ${index}`, cwd: "/project", created: "2026-10-01", updated: `2026-10-${String(28 - index % 20).padStart(2, "0")}`, status: index % 9 === 0 ? "running" : "idle", occupancy: "available", sourceLabel: "Codex", canResume: true, canDelete: true };
}
beforeEach(() => {
  vi.resetAllMocks();
  delete (globalThis as typeof globalThis & { __liveNativeSessionCatalog?: unknown }).__liveNativeSessionCatalog;
  (globalThis as typeof globalThis & { __sessionCatalogSnapshots?: Map<string, unknown> }).__sessionCatalogSnapshots?.clear();
  mocks.ca.mockResolvedValue([]); mocks.summaries.mockResolvedValue([]); mocks.projects.mockResolvedValue([]);
  const sessions = Array.from({ length: 45 }, (_, index) => session(index));
  mocks.list.mockResolvedValue(sessions); mocks.refresh.mockResolvedValue(sessions);
});
afterEach(() => vi.useRealTimers());
describe("shared session catalog", () => {
  it("uses summary storage without loading session messages or events", async () => {
    mocks.summaries.mockResolvedValue([{ id: "summary", title: "Summary", projectId: "", status: "idle",
      created: "2026-11-04", updated: "2026-11-04", metadata: {} }]);
    const page = await querySessionCatalog({ query: "Summary" });
    expect(page.data.map(row => row.id)).toEqual(["summary"]);
    expect(mocks.ca).not.toHaveBeenCalled();
    expect(page.data[0]).not.toHaveProperty("messages");
    expect(page.data[0]).not.toHaveProperty("events");
  });
  it("returns the first 20 running-first sessions, stable pages without omissions, and full-catalog search", async () => {
    const first = await querySessionCatalog({});
    expect(first.data).toHaveLength(20); expect(first.total).toBe(45);
    expect(first.data.slice(0, 5).every(session => session.status === "running")).toBe(true);
    mocks.list.mockResolvedValue([session(999)]); // Discovery changes cannot reorder this snapshot.
    const second = await querySessionCatalog({ cursor: first.nextCursor!, limit: 20 });
    const third = await querySessionCatalog({ cursor: second.nextCursor!, limit: 20 });
    expect(new Set([...first.data, ...second.data, ...third.data].map(session => session.id)).size).toBe(45);
    expect(third.nextCursor).toBeNull();
    mocks.list.mockResolvedValue(Array.from({ length: 45 }, (_, index) => session(index)));
    const search = await querySessionCatalog({ query: "分页可搜索", limit: 20 });
    expect(search.data.map(session => session.id)).toEqual(["codex:44"]);
    await expect(querySessionCatalog({ query: "different", cursor: first.nextCursor! })).rejects.toThrow("重新加载");
  });
  it("preserves the existing sessions array contract and hides only internal execution sessions", async () => {
    mocks.list.mockResolvedValue([{ ...session(0), id: "internal" }, session(1)]);
    const response = await GET(new Request("http://localhost/api/sessions"));
    const body = await response.json(); expect(Array.isArray(body)).toBe(true); expect(body.map((session: { id: string }) => session.id)).toEqual(["codex:1"]);
  });

  it("includes a child's ancestor chain across a page boundary and when only the child matches search", async () => {
    const parent = { ...session(17), title: "主任务", status: "idle" as const };
    const child = { ...session(18), title: "子任务", parentSessionId: parent.id, status: "idle" as const };
    const grandchild = { ...session(19), title: "测试唯一关键词", parentSessionId: child.id, status: "running" as const };
    mocks.refresh.mockResolvedValue([parent, child, grandchild]);

    const first = await querySessionCatalog({ limit: 1 });
    expect(first.data.map(row => [row.id, row.parentSessionId])).toEqual([[grandchild.id, child.id]]);
    expect(first.ancestors?.map(row => [row.id, row.parentSessionId])).toEqual([[child.id, parent.id], [parent.id, undefined]]);
    expect(first.total).toBe(3);
    const second = await querySessionCatalog({ cursor: first.nextCursor!, limit: 1 });
    expect(second.data.map(row => row.id)).toEqual([parent.id]);

    const search = await querySessionCatalog({ query: "唯一关键词" });
    expect(search.data.map(row => row.id)).toEqual([grandchild.id]);
    expect(search.ancestors?.map(row => row.id)).toEqual([child.id, parent.id]);
    expect(search.total).toBe(1);
  });
  it("applies newly running sessions on the first poll after the cache expires", async () => {
    vi.useFakeTimers();
    const stale = [{ ...session(0), status: "running" as const }, { ...session(1), status: "running" as const }, { ...session(2), status: "idle" as const }];
    mocks.list.mockResolvedValue(stale);
    mocks.refresh.mockResolvedValue(stale);
    const first = await querySessionCatalog({});
    expect(first.data.filter(session => session.status === "running")).toHaveLength(2);
    mocks.refresh.mockResolvedValue(stale.map(session => session.id === "codex:2" ? { ...session, status: "running", updated: "2026-10-28T05:47:02Z" } : session));
    await vi.advanceTimersByTimeAsync(15_001);
    const next = await querySessionCatalog({});
    expect(next.data.filter(session => session.status === "running")).toHaveLength(3);
    expect(next.data.find(session => session.id === "codex:2")?.status).toBe("running");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(first.data.find(session => session.id === "codex:2")?.status).toBe("idle");
  });
  it("coalesces slow expired refreshes and returns current activity to every waiting viewer", async () => {
    vi.useFakeTimers();
    await querySessionCatalog({});
    let release!: (sessions: UnifiedSessionSummary[]) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(15_001);
    let settled = false;
    const first = querySessionCatalog({}).then(page => { settled = true; return page; });
    const second = querySessionCatalog({ query: "任务" });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    release([{ ...session(0), status: "idle" }, { ...session(1), status: "running" }]);
    const pages = await Promise.all([first, second]);
    for (const page of pages) {
      expect(page.total).toBe(2);
      expect(page.data.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "codex:1", status: "running" }, { id: "codex:0", status: "idle" },
      ]);
    }
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
  it("retains cached native sessions when a refresh fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await querySessionCatalog({});
    mocks.refresh.mockRejectedValueOnce(new Error("temporary background refresh failure"));
    await vi.advanceTimersByTimeAsync(15_001);
    const page = await querySessionCatalog({});
    expect(page.total).toBe(45);
    await vi.advanceTimersByTimeAsync(0);
    expect((await querySessionCatalog({})).total).toBe(45);
    expect(warn).toHaveBeenCalledWith("Native session catalog refresh failed; serving cached sessions:", expect.any(Error));
    warn.mockRestore();
  });
  it("reuses discovery across nearby list and search requests until the next visible poll", async () => {
    vi.useFakeTimers();
    await querySessionCatalog({});
    await vi.advanceTimersByTimeAsync(2001);
    await querySessionCatalog({ query: "任务" });
    await vi.advanceTimersByTimeAsync(12_998);
    await querySessionCatalog({});
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await querySessionCatalog({});
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
  it("coalesces simultaneous live discovery requests and retries a failed discovery", async () => {
    let release!: (sessions: UnifiedSessionSummary[]) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>(resolve => { release = resolve; }));
    const first = querySessionCatalog({}); const second = querySessionCatalog({ query: "任务" });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    release([session(0)]);
    expect((await first).total).toBe(1); expect((await second).total).toBe(1);
    delete (globalThis as typeof globalThis & { __liveNativeSessionCatalog?: unknown }).__liveNativeSessionCatalog;
    mocks.refresh.mockRejectedValueOnce(new Error("temporary discovery failure"));
    await expect(querySessionCatalog({})).rejects.toThrow("temporary discovery failure");
    mocks.refresh.mockResolvedValue([session(0), session(1)]);
    expect((await querySessionCatalog({})).total).toBe(2);
  });

  it("keeps cached picker tasks selectable while one shared refresh is slow", async () => {
    vi.useFakeTimers();
    const first = await querySessionCatalog({ backgroundRefresh: true });
    let release!: (sessions: UnifiedSessionSummary[]) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(15_001);

    const pending = await querySessionCatalog({ backgroundRefresh: true });
    const search = await querySessionCatalog({ query: "分页可搜索", backgroundRefresh: true });
    expect(pending.data).toEqual(first.data);
    expect(pending.refreshing).toBe(true);
    expect(search.data.map(row => row.id)).toEqual(["codex:44"]);
    expect(search.refreshing).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);

    release([session(99)]);
    await vi.advanceTimersByTimeAsync(0);
    const latest = await querySessionCatalog({ backgroundRefresh: true });
    expect(latest.data.map(row => row.id)).toEqual(["codex:99"]);
    expect(latest.refreshing).toBeUndefined();
    expect((await querySessionCatalog({ cursor: first.nextCursor! })).total).toBe(45);
  });

  it("bounds a cold picker request and reports discovery in progress instead of an empty search result", async () => {
    vi.useFakeTimers();
    let release!: (sessions: UnifiedSessionSummary[]) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>(resolve => { release = resolve; }));
    mocks.summaries.mockResolvedValue([{ id: "local", title: "本地任务", projectId: "", status: "idle",
      created: "2026-11-17", updated: "2026-11-17", metadata: {} }]);
    const request = querySessionCatalog({ backgroundRefresh: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const warming = await request;
    expect(warming.data.map(row => row.id)).toEqual(["local"]);
    expect(warming.refreshing).toBe(true);

    release([session(1)]);
    await vi.advanceTimersByTimeAsync(0);
    const complete = await querySessionCatalog({ backgroundRefresh: true });
    expect(complete.data.map(row => row.id)).toEqual(["local", "codex:1"]);
    expect(complete.refreshing).toBeUndefined();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the refresh marker if discovery completes while project metadata is loading", async () => {
    vi.useFakeTimers();
    await querySessionCatalog({ backgroundRefresh: true });
    let releaseRefresh!: (sessions: UnifiedSessionSummary[]) => void;
    let releaseProjects!: (projects: []) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>(resolve => { releaseRefresh = resolve; }));
    mocks.projects.mockReturnValue(new Promise<[]>(resolve => { releaseProjects = resolve; }));
    await vi.advanceTimersByTimeAsync(15_001);
    const request = querySessionCatalog({ backgroundRefresh: true });
    await vi.advanceTimersByTimeAsync(0);
    releaseRefresh([session(99)]);
    releaseProjects([]);
    const page = await request;
    expect(page.refreshing).toBe(true);
    expect(page.total).toBe(45);
  });

  it("reports a late cold discovery failure on the next picker read and permits retry", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    mocks.refresh.mockReturnValue(new Promise<UnifiedSessionSummary[]>((_resolve, reject) => { fail = reject; }));
    const request = querySessionCatalog({ backgroundRefresh: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await request).refreshing).toBe(true);
    fail(new Error("late discovery failure"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(querySessionCatalog({ backgroundRefresh: true })).rejects.toThrow("late discovery failure");
    mocks.refresh.mockResolvedValue([session(1)]);
    expect((await querySessionCatalog({ backgroundRefresh: true })).data.map(row => row.id)).toEqual(["codex:1"]);
  });
});
