import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "@agent/native-runtime";
const mocks = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn(), ca: vi.fn(), projects: vi.fn() }));
vi.mock("../app/api/agent-host", () => ({ agentHost: { getSessionStore: () => ({ list: mocks.ca }), getProjectStore: () => ({ list: mocks.projects }), isSessionRunning: () => false } }));
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
  mocks.ca.mockResolvedValue([]); mocks.projects.mockResolvedValue([]);
  const sessions = Array.from({ length: 45 }, (_, index) => session(index));
  mocks.list.mockResolvedValue(sessions); mocks.refresh.mockResolvedValue(sessions);
});
afterEach(() => vi.useRealTimers());
describe("shared session catalog", () => {
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
  it("refreshes live status so an externally started third Codex session appears on the next poll", async () => {
    vi.useFakeTimers();
    const stale = [{ ...session(0), status: "running" as const }, { ...session(1), status: "running" as const }, { ...session(2), status: "idle" as const }];
    mocks.list.mockResolvedValue(stale);
    mocks.refresh.mockResolvedValue(stale);
    const first = await querySessionCatalog({});
    expect(first.data.filter(session => session.status === "running")).toHaveLength(2);
    mocks.refresh.mockResolvedValue(stale.map(session => session.id === "codex:2" ? { ...session, status: "running", updated: "2026-10-28T05:47:02Z" } : session));
    await vi.advanceTimersByTimeAsync(2001);
    const next = await querySessionCatalog({});
    expect(next.data.filter(session => session.status === "running")).toHaveLength(3);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(first.data.find(session => session.id === "codex:2")?.status).toBe("idle");
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
});
