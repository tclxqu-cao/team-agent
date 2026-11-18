import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import type { CatalogSession, SessionActivitySnapshot } from "../../../core/src/domain/supervision/types";
import { applyDashboardActivity, applySessionActivity, createSessionActivityStore } from "./session-activity";

const row = (agentType: CatalogSession["agentType"], status: CatalogSession["status"] = "running"): CatalogSession => ({
  id: `${agentType}:new`, agentType, status, title: `新建 ${agentType}`, cwd: "/project", updated: "2026-11-17", canResume: true,
});
const activity = (sessions: CatalogSession[], agentTypes = [...AGENT_TYPES]): SessionActivitySnapshot => ({ sessions, agentTypes, updatedAt: "2026-11-17" });
afterEach(() => vi.useRealTimers());

describe("live session activity", () => {
  it("updates every Agent in both the catalog and Dashboard without waiting for history discovery", () => {
    const sessions = AGENT_TYPES.map(type => row(type));
    const fresh = activity(sessions);
    expect(applySessionActivity(sessions.map(session => ({ ...session, status: "idle" })), fresh).every(session => session.status === "running")).toBe(true);
    const dashboard = applyDashboardActivity(null, fresh)!;
    expect(dashboard.agents.flatMap(agent => agent.sessions)).toHaveLength(AGENT_TYPES.length);
    expect(applySessionActivity([], fresh, "qoder").map(session => session.agentType)).toEqual(["qoder"]);
  });

  it("removes ended runs only for Agents whose discovery has completed", () => {
    const previous = [row("codex"), row("claude-code")];
    expect(applySessionActivity(previous, activity([], ["codex"])).map(session => session.status)).toEqual(["idle", "running"]);
  });

  it("publishes simultaneous creation/admission receipts synchronously and rejects stale snapshots", async () => {
    vi.useFakeTimers();
    let complete!: (value: SessionActivitySnapshot) => void;
    const read = vi.fn(() => new Promise<SessionActivitySnapshot>(resolve => { complete = resolve; }));
    const listen = vi.fn(() => vi.fn());
    const store = createSessionActivityStore(read, listen);
    const stop = store.subscribe(vi.fn(), true);
    for (const agentType of AGENT_TYPES) {
      const session = row(agentType, "idle");
      store.receive({ type: "session_summary", session, _sid: session.id });
      store.receive({ type: "run_admitted", _sid: session.id });
    }
    expect(store.getSnapshot()!.sessions.filter(session => session.status === "running")).toHaveLength(AGENT_TYPES.length);
    complete(activity(AGENT_TYPES.map(type => row(type, "idle"))));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()!.sessions.every(session => session.status === "running")).toBe(true);
    store.receive({ type: "done", _sid: row("codex").id });
    expect(store.getSnapshot()!.sessions.find(session => session.agentType === "codex")?.status).toBe("completed");
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares the poll and event listener across consumers and resumes without accepting a hidden visit's response", async () => {
    vi.useFakeTimers();
    const completions: Array<(value: SessionActivitySnapshot) => void> = [];
    const read = vi.fn(() => new Promise<SessionActivitySnapshot>(resolve => completions.push(resolve)));
    const off = vi.fn();
    const listen = vi.fn(() => off);
    const store = createSessionActivityStore(read, listen);
    const first = store.subscribe(vi.fn(), true);
    const second = store.subscribe(vi.fn(), true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
    first(); second();
    const again = store.subscribe(vi.fn(), true);
    expect(read).toHaveBeenCalledTimes(2);
    completions[0](activity([row("codex")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toBeNull();
    completions[1](activity([row("qoder")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()!.sessions[0].agentType).toBe("qoder");
    again();
  });

  it("retains a newly observed external session after it stops, even while the history catalog is blocked", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(activity([row("codex")]))
      .mockResolvedValue(activity([]));
    const store = createSessionActivityStore(read, () => () => {});
    const stop = store.subscribe(vi.fn(), true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getSnapshot()!.sessions).toEqual([expect.objectContaining({ id: row("codex").id, status: "idle" })]);
    stop();
  });
});
