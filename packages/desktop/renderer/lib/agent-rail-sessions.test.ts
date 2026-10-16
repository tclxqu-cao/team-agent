import { describe, expect, it, vi } from "vitest";
import { loadAgentRailSessions } from "./agent-rail-sessions";
import type { AgentApi, AgentWorkspace, UnifiedSessionSummary, WorkspacePage } from "../global";

const page = <T>(data: T[], nextCursor: string | null = null): WorkspacePage<T> => ({ data, nextCursor, watermark: null });
const workspace = (id: string): AgentWorkspace => ({ agentType: "codex", workspaceId: id, name: id, roots: [], order: 0, source: "native" });
const session = (id: string): UnifiedSessionSummary => ({ id, agentType: "codex", nativeSessionId: id, title: id, cwd: "", created: "", updated: "", status: "idle", occupancy: "available", sourceLabel: "Codex", canResume: true, canDelete: true });

describe("Agent rail session discovery", () => {
  it("reads every workspace and session page, retaining native order and removing duplicate sessions", async () => {
    const api: Pick<AgentApi, "listAgentWorkspaces" | "listAgentWorkspaceSessions"> = {
      listAgentWorkspaces: vi.fn(async (_agent, query) => query?.cursor
        ? page([workspace("second")]) : page([workspace("first")], "next-workspaces")),
      listAgentWorkspaceSessions: vi.fn(async (_agent, id, query) => id === "second"
        ? page([session("shared"), session("last")])
        : query?.cursor ? page([session("shared")]) : page([session("native-first")], "next-sessions")),
    };
    const result = await loadAgentRailSessions(api, "codex", new AbortController().signal);
    expect(result.workspaces.map(row => row.workspaceId)).toEqual(["first", "second"]);
    expect(result.sessions.map(row => [row.id, row.projectId])).toEqual([
      ["native-first", "first"], ["shared", "first"], ["last", "second"],
    ]);
    expect(api.listAgentWorkspaceSessions).toHaveBeenCalledTimes(3);
  });

  it("stops discovery when the pointer moves to another Agent", async () => {
    const controller = new AbortController();
    const listAgentWorkspaceSessions = vi.fn();
    const api = {
      listAgentWorkspaces: vi.fn(async () => { controller.abort(); return page([workspace("repo")]); }),
      listAgentWorkspaceSessions,
    };
    await expect(loadAgentRailSessions(api, "codex", controller.signal)).rejects.toThrow();
    expect(listAgentWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("reports incomplete or broken pagination instead of presenting a partial list as all sessions", async () => {
    const api = {
      listAgentWorkspaces: vi.fn(async () => page([workspace("repo")], "repeated-cursor")),
      listAgentWorkspaceSessions: vi.fn(),
    };
    await expect(loadAgentRailSessions(api, "codex", new AbortController().signal)).rejects.toThrow("加载中断");
    api.listAgentWorkspaces.mockResolvedValue({ ...page([workspace("repo")]), stale: true });
    await expect(loadAgentRailSessions(api, "codex", new AbortController().signal)).rejects.toThrow("待刷新");
  });
});
