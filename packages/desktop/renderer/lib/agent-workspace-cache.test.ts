import { describe, expect, it, vi } from "vitest";
import {
  AGENT_WORKSPACE_CACHE_KEY,
  emptyAgentWorkspaceCache,
  emptyAgentWorkspacePartition,
  preservePendingNativeSession,
  readAgentWorkspaceCache,
  refreshCachedRunningSessionPages,
  reconcileSessionPage,
  reconcileWorkspacePage,
  writeAgentWorkspaceCache,
} from "./agent-workspace-cache";
import type { AgentType, AgentWorkspace, UnifiedSessionSummary } from "../global";

function workspace(agentType: AgentType, workspaceId: string, name = workspaceId): AgentWorkspace {
  return { agentType, workspaceId, name, roots: [`/${workspaceId}`], order: 0, source: "native" };
}

function session(
  id: string,
  overrides: Partial<UnifiedSessionSummary> = {},
): UnifiedSessionSummary {
  return {
    id,
    agentType: "codex",
    nativeSessionId: id,
    title: id,
    cwd: "/repo",
    created: "2026-09-04T00:00:00.000Z",
    updated: "2026-09-04T00:00:00.000Z",
    status: "idle",
    occupancy: "available",
    sourceLabel: "Codex",
    canResume: true,
    canDelete: false,
    ...overrides,
  };
}

describe("agent workspace cache", () => {
  it("keeps Agent partitions, selection, and scroll position independent", () => {
    const cache = emptyAgentWorkspaceCache();
    cache.activeAgent = "codex";
    cache.agents.codex = {
      workspaces: [workspace("codex", "codex-repo")],
      nextCursor: "next",
      watermark: "watermark",
      expandedWorkspaceIds: ["codex-repo"],
      selectedWorkspaceId: "codex-repo",
      selectedSessionId: "codex-session",
      sidebarScrollTop: 128,
      sessions: {},
    };
    cache.agents["claude-code"] = {
      workspaces: [workspace("claude-code", "claude-repo")],
      nextCursor: null,
      watermark: null,
      expandedWorkspaceIds: [],
      selectedWorkspaceId: null,
      selectedSessionId: null,
      sidebarScrollTop: 9,
      sessions: {},
    };
    let stored = "";
    writeAgentWorkspaceCache(cache, { setItem: (key, value) => {
      expect(key).toBe(AGENT_WORKSPACE_CACHE_KEY);
      stored = value;
    } });

    const restored = readAgentWorkspaceCache({ getItem: () => stored });

    expect(restored.agents.codex?.sidebarScrollTop).toBe(128);
    expect(restored.agents["claude-code"]?.workspaces[0]?.workspaceId).toBe("claude-repo");
  });

  it("restores each Agent's selected session and sidebar state on cold read", () => {
    const cache = emptyAgentWorkspaceCache();
    cache.activeAgent = "codex";
    cache.agents.codex = {
      workspaces: [workspace("codex", "codex-repo")],
      nextCursor: null,
      watermark: null,
      expandedWorkspaceIds: ["codex-repo"],
      selectedWorkspaceId: "codex-repo",
      selectedSessionId: "codex-session",
      sidebarScrollTop: 128,
      sessions: {},
    };
    cache.agents["claude-code"] = {
      workspaces: [workspace("claude-code", "claude-repo")],
      nextCursor: null,
      watermark: null,
      expandedWorkspaceIds: ["claude-repo"],
      selectedWorkspaceId: "claude-repo",
      selectedSessionId: "claude-session",
      sidebarScrollTop: 64,
      sessions: {},
    };
    let stored = "";
    writeAgentWorkspaceCache(cache, { setItem: (_key, value) => { stored = value; } });

    const restored = readAgentWorkspaceCache({ getItem: () => stored });

    expect(restored.activeAgent).toBe("codex");
    expect(restored.agents.codex?.selectedWorkspaceId).toBe("codex-repo");
    expect(restored.agents.codex?.selectedSessionId).toBe("codex-session");
    expect(restored.agents.codex?.expandedWorkspaceIds).toEqual(["codex-repo"]);
    expect(restored.agents.codex?.sidebarScrollTop).toBe(128);
    expect(restored.agents["claude-code"]?.selectedWorkspaceId).toBe("claude-repo");
    expect(restored.agents["claude-code"]?.selectedSessionId).toBe("claude-session");
    expect(restored.agents["claude-code"]?.expandedWorkspaceIds).toEqual(["claude-repo"]);
    expect(restored.agents["claude-code"]?.sidebarScrollTop).toBe(64);
  });

  it("reconciles rename and order from the authoritative first page", () => {
    const current = [workspace("codex", "one", "Old"), workspace("codex", "two")];
    const result = reconcileWorkspacePage(current, {
      data: [workspace("codex", "two", "Two"), workspace("codex", "one", "Renamed")],
      nextCursor: null,
      watermark: "2",
    }, true);

    expect(result.map(({ workspaceId, name }) => [workspaceId, name])).toEqual([
      ["two", "Two"],
      ["one", "Renamed"],
    ]);
  });

  it("keeps already loaded later workspace pages during a first-page refresh", () => {
    const current = [workspace("codex", "one", "Old"), workspace("codex", "later")];
    const result = reconcileWorkspacePage(current, {
      data: [workspace("codex", "one", "Renamed")],
      nextCursor: "page-two",
      watermark: "2",
    }, true);

    expect(result.map(({ workspaceId, name }) => [workspaceId, name])).toEqual([
      ["one", "Renamed"],
      ["later", "later"],
    ]);
  });

  it("appends every session page without duplicates or a total-row cap", () => {
    const current = Array.from({ length: 300 }, (_, index) => session(String(index)));
    const result = reconcileSessionPage(current, {
      data: [session("299"), session("300")],
      nextCursor: null,
      watermark: null,
    }, false);

    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
    expect(result).toHaveLength(301);
  });

  it("replaces a cached session with the fresh duplicate from an appended page", () => {
    const result = reconcileSessionPage([
      session("target", { status: "running" }),
      session("after"),
    ], {
      data: [session("target", { status: "idle" }), session("new")],
      nextCursor: null,
      watermark: null,
    }, false);

    expect(result.map(({ id, status }) => [id, status])).toEqual([
      ["target", "idle"],
      ["after", "idle"],
      ["new", "idle"],
    ]);
  });

  it("uses refreshed first-page order ahead of cached and later-page rows", () => {
    const result = reconcileSessionPage([
      session("cached-first"),
      session("cached-second"),
      session("later-page"),
    ], {
      data: [session("cached-second"), session("cached-first")],
      nextCursor: "page-two",
      watermark: "2",
    }, true);

    expect(result.map((item) => item.id)).toEqual([
      "cached-second",
      "cached-first",
      "later-page",
    ]);
  });

  it("removes missing sessions when the refreshed first page is the complete list", () => {
    const result = reconcileSessionPage([session("removed"), session("kept")], {
      data: [session("kept")],
      nextCursor: null,
      watermark: "2",
    }, true);

    expect(result.map((item) => item.id)).toEqual(["kept"]);
  });

  it("follows refreshed pages until a cached running session is resolved", async () => {
    const loadPage = vi.fn(async (cursor: string) => cursor === "page-two"
      ? {
          data: [session("middle")],
          nextCursor: "page-three",
          watermark: "2",
        }
      : {
          data: [session("target", { status: "idle" })],
          nextCursor: "page-four",
          watermark: "3",
        });

    const page = await refreshCachedRunningSessionPages(
      [session("target", { status: "running" })],
      { data: [session("first")], nextCursor: "page-two", watermark: "1" },
      loadPage,
    );

    expect(loadPage.mock.calls).toEqual([["page-two"], ["page-three"]]);
    expect(page.data.map(({ id, status }) => [id, status])).toEqual([
      ["first", "idle"],
      ["middle", "idle"],
      ["target", "idle"],
    ]);
    expect(page.nextCursor).toBe("page-four");
  });

  it("drops a missing cached running session after scanning the complete list", async () => {
    const current = [
      session("removed", { status: "running" }),
      session("kept"),
    ];
    const page = await refreshCachedRunningSessionPages(
      current,
      { data: [session("kept")], nextCursor: "page-two", watermark: "1" },
      vi.fn(async () => ({ data: [session("last")], nextCursor: null, watermark: "2" })),
    );

    expect(page.nextCursor).toBeNull();
    expect(reconcileSessionPage(current, page, true).map((item) => item.id)).toEqual([
      "kept",
      "last",
    ]);
  });

  it("does not load later pages without an unresolved cached running session", async () => {
    const loadPage = vi.fn();

    const page = await refreshCachedRunningSessionPages(
      [session("idle")],
      { data: [session("first")], nextCursor: "page-two", watermark: "1" },
      loadPage,
    );

    expect(loadPage).not.toHaveBeenCalled();
    expect(page.nextCursor).toBe("page-two");
  });

  it("does not chase an explicit pending running session", async () => {
    const loadPage = vi.fn();

    await refreshCachedRunningSessionPages(
      [session("pending", { status: "running" })],
      { data: [session("first")], nextCursor: "page-two", watermark: "1" },
      loadPage,
      "pending",
    );

    expect(loadPage).not.toHaveBeenCalled();
  });

  it("stops on a repeated cursor without dropping unresolved cached rows", async () => {
    const current = [session("target", { status: "running" })];
    const loadPage = vi.fn(async () => ({
      data: [session("middle")],
      nextCursor: "page-two",
      watermark: "2",
    }));

    const page = await refreshCachedRunningSessionPages(
      current,
      { data: [session("first")], nextCursor: "page-two", watermark: "1" },
      loadPage,
    );

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({ nextCursor: "page-two", stale: true });
    expect(reconcileSessionPage(current, page, true).map((item) => item.id)).toContain("target");
  });

  it("keeps cached later rows when a followed page is stale", async () => {
    const current = [session("target", { status: "running" })];
    const page = await refreshCachedRunningSessionPages(
      current,
      { data: [session("first")], nextCursor: "page-two", watermark: "1" },
      vi.fn(async () => ({
        data: [session("target", { status: "idle" })],
        nextCursor: null,
        watermark: "2",
        stale: true,
      })),
    );

    expect(page).toMatchObject({
      data: [expect.objectContaining({ id: "first" })],
      nextCursor: "page-two",
      stale: true,
    });
    expect(reconcileSessionPage(current, page, true)[1]).toMatchObject({
      id: "target",
      status: "running",
    });
  });

  it("preserves an explicit pending native fork while discovery has not returned it yet", () => {
    const source = session("source");
    const forked = session("forked");

    expect(preservePendingNativeSession(
      [source],
      forked,
    ).map((item) => item.id)).toEqual(["forked", "source"]);
  });

  it("does not duplicate a pending session already returned by discovery", () => {
    const pending = session("pending");

    expect(preservePendingNativeSession([pending], pending)).toEqual([pending]);
  });

  it("does not preserve a stale selected row without an explicit pending session", () => {
    expect(preservePendingNativeSession([session("source")])).toEqual([session("source")]);
  });

  it("ignores corrupted storage", () => {
    expect(readAgentWorkspaceCache({ getItem: () => "not-json" })).toEqual(emptyAgentWorkspaceCache());
  });

  it("preserves a read-only workspace and more than 300 cached sessions", () => {
    const cache = emptyAgentWorkspaceCache();
    cache.activeAgent = "codex";
    cache.agents.codex = {
      ...emptyAgentWorkspacePartition(),
      workspaces: [{
        ...workspace("codex", "codex:recent", "最近"),
        roots: [],
        source: "derived",
        canCreateSession: false,
      }],
      sessions: {
        "codex:recent": {
          data: Array.from({ length: 325 }, (_, index) => session(String(index))),
          nextCursor: null,
          loaded: true,
        },
      },
    };
    let stored = "";
    writeAgentWorkspaceCache(cache, { setItem: (_key, value) => { stored = value; } });

    const restored = readAgentWorkspaceCache({ getItem: () => stored });

    expect(restored.agents.codex?.workspaces[0]?.canCreateSession).toBe(false);
    expect(restored.agents.codex?.sessions["codex:recent"]?.data).toHaveLength(325);
  });
});
