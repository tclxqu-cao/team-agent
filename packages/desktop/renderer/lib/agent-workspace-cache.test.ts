import { describe, expect, it } from "vitest";
import {
  AGENT_WORKSPACE_CACHE_KEY,
  emptyAgentWorkspaceCache,
  readAgentWorkspaceCache,
  reconcileSessionPage,
  reconcileWorkspacePage,
  writeAgentWorkspaceCache,
} from "./agent-workspace-cache";
import type { AgentType, AgentWorkspace, UnifiedSessionSummary } from "../global";

function workspace(agentType: AgentType, workspaceId: string, name = workspaceId): AgentWorkspace {
  return { agentType, workspaceId, name, roots: [`/${workspaceId}`], order: 0, source: "native" };
}

function session(id: string): UnifiedSessionSummary {
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

  it("appends session pages without duplicates and caps cached rows", () => {
    const current = Array.from({ length: 300 }, (_, index) => session(String(index)));
    const result = reconcileSessionPage(current, {
      data: [session("299"), session("300")],
      nextCursor: null,
      watermark: null,
    }, false);

    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
    expect(result).toHaveLength(300);
  });

  it("removes missing sessions when the refreshed first page is the complete list", () => {
    const result = reconcileSessionPage([session("removed"), session("kept")], {
      data: [session("kept")],
      nextCursor: null,
      watermark: "2",
    }, true);

    expect(result.map((item) => item.id)).toEqual(["kept"]);
  });

  it("ignores corrupted storage", () => {
    expect(readAgentWorkspaceCache({ getItem: () => "not-json" })).toEqual(emptyAgentWorkspaceCache());
  });
});
