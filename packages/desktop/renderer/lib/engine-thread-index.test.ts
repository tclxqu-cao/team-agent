import { afterEach, describe, expect, it, vi } from "vitest";
import { activeThreadSession, historyThreadRedirect, fetchEngineThreadIndex, foldEngineThreadSessions } from "./engine-thread-index";
import type { UnifiedSessionSummary } from "../global";

const session = (id: string, agentType: UnifiedSessionSummary["agentType"]): UnifiedSessionSummary => ({
  id, agentType, nativeSessionId: id, title: id, cwd: "/tmp/project", status: "idle", occupancy: "available",
  canResume: true, canDelete: true, sourceLabel: agentType, created: "now", updated: "now",
});
afterEach(() => vi.unstubAllGlobals());
describe("engine thread presentation", () => {
  it("opens the current engine and preserves metadata, without synthetic child rows", async () => {
    const a = session("A", "codex"), b = { ...session("B", "claude-code"), readOnly: true, canResume: false };
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ threads: [{
      threadKey: "t", title: "Original conversation", originSessionId: "A", currentSessionId: "B",
      currentAgentType: "claude-code", created: "now", updated: "now", members: [a, b],
    }] }))));
    const index = await fetchEngineThreadIndex();
    expect(index.get("A")?.currentSessionId).toBe("B");
    const folded = foldEngineThreadSessions([a, b], index);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ id: "B", title: "Original conversation", readOnly: true, canResume: false });
    expect(activeThreadSession(index.get("A")!)).toMatchObject({ id: "B", agentType: "claude-code" });
  });

  it("keeps ordinary/multi-agent session collections unchanged and retries index failures", async () => {
    const sessions = [session("ordinary", "codex"), session("parallel", "claude-code")];
    expect(foldEngineThreadSessions(sessions, null)).toBe(sessions);
    vi.stubGlobal("window", {});
    const fetch = vi.fn().mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"threads":[]}'));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchEngineThreadIndex()).rejects.toThrow();
    expect((await fetchEngineThreadIndex()).size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent index refreshes into one gateway request", async () => {
    vi.stubGlobal("window", {});
    let resolveResponse!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>(resolve => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetch);
    const first = fetchEngineThreadIndex();
    const second = fetchEngineThreadIndex();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveResponse(new Response('{"threads":[]}'));
    await expect(Promise.all([first, second])).resolves.toEqual([new Map(), new Map()]);
  });
  it("redirects a saved switched selection without changing ordinary session identity checks", () => {
    const current = { ...session("B", "claude-code"), threadKey: "t", activeSessionId: "B" };
    expect(historyThreadRedirect(current, "A")?.id).toBe("B");
    expect(historyThreadRedirect(session("ordinary", "codex"), "other")).toBeUndefined();
    expect(historyThreadRedirect(null, "other")).toBeUndefined();
  });

});
