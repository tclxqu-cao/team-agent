import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ live: vi.fn(), summaries: vi.fn(), projects: vi.fn(), running: vi.fn() }));
vi.mock("../app/api/agent-host", () => ({ agentHost: {
  getSessionStore: () => ({ listSummaries: mocks.summaries }), getProjectStore: () => ({ list: mocks.projects }), isSessionRunning: mocks.running,
} }));
vi.mock("./native-runtime-service", () => ({ getNativeRuntimeService: () => ({ liveSessions: mocks.live }) }));
vi.mock("./collaboration/visibility", () => ({ collaborationSessionIds: () => new Set(["hidden"]) }));
import { sessionActivity } from "./session-activity";
beforeEach(() => {
  vi.resetAllMocks();
  delete (globalThis as typeof globalThis & { __nativeSessionActivity?: unknown }).__nativeSessionActivity;
  mocks.summaries.mockResolvedValue([{ id: "local", projectId: "project", title: "运行中", created: "2020-01-01", updated: "2020-01-01", status: "idle" }]);
  mocks.projects.mockResolvedValue([{ id: "project", description: "/repo" }]);
  mocks.running.mockImplementation(id => id === "local");
});
afterEach(() => vi.useRealTimers());
describe("fast session activity", () => {
  it("returns local running sessions while a broker is still pending and coalesces viewers", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { sessions: []; agentTypes: ["codex"] }) => void;
    mocks.live.mockReturnValue(new Promise(done => { resolve = done; }));
    const first = sessionActivity(); const second = sessionActivity();
    await vi.advanceTimersByTimeAsync(500);
    for (const snapshot of await Promise.all([first, second])) {
      expect(snapshot.sessions[0]).toMatchObject({ id: "local", status: "running", cwd: "/repo" });
      expect(snapshot.agentTypes).toEqual(["customer-agent"]);
    }
    expect(mocks.live).toHaveBeenCalledTimes(1);
    resolve({ sessions: [], agentTypes: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect((await sessionActivity()).agentTypes).toEqual(["customer-agent", "codex"]);
  });
  it("keeps internal executions hidden and publishes native status without calling full discovery", async () => {
    const native = { id: "native", agentType: "qoder", title: "原生新任务", cwd: "/repo", created: "2026-11-17", updated: "2026-11-17", status: "running", canResume: false, occupancy: "owned-externally" };
    mocks.live.mockResolvedValue({ sessions: [native, { ...native, id: "hidden" }], agentTypes: ["qoder"] });
    const snapshot = await sessionActivity();
    expect(snapshot.sessions.map(row => row.id)).toEqual(["local", "native"]);
    expect(snapshot.sessions[1].status).toBe("running");
  });
});
