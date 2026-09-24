import { describe, expect, it, vi } from "vitest";
import {
  AgentWorkspaceIndexService,
  CODEX_RECENT_WORKSPACE_ID,
  decodeOffsetCursor,
  paginateByOffset,
} from "./agent-workspace-index.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  AgentWorkspace,
  ImportedAgentWorkspace,
  ImportedAgentWorkspaceRepository,
  UnifiedSessionSummary,
} from "./types.js";

function workspace(agentType: AgentType, workspaceId: string, order: number): AgentWorkspace {
  return {
    agentType,
    workspaceId,
    name: workspaceId,
    roots: [`/${workspaceId}`],
    order,
    source: "native",
  };
}

function session(agentType: AgentType, id: string): UnifiedSessionSummary {
  return {
    id,
    agentType,
    nativeSessionId: id,
    title: id,
    cwd: "/repo",
    created: "2026-09-04T00:00:00.000Z",
    updated: "2026-09-04T00:00:00.000Z",
    status: "idle",
    occupancy: "available",
    sourceLabel: agentType,
    canResume: true,
    canDelete: false,
  };
}

function adapter(agentType: AgentType, items: AgentWorkspace[]): AgentRuntimeAdapter {
  return {
    agentType,
    health: vi.fn(),
    discoverSessions: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => ({ data: items, nextCursor: null, watermark: "1" })),
    listWorkspaceSessions: vi.fn(async () => ({ data: [session(agentType, `${agentType}-1`)], nextCursor: null, watermark: "1" })),
    listWorkspaceSessionsByPath: vi.fn(async (cwd: string) => ({
      data: [{ ...session(agentType, `${agentType}-imported`), cwd }],
      nextCursor: null,
      watermark: "1",
    })),
    getSession: vi.fn(),
    create: vi.fn(),
    run: vi.fn(),
    abort: vi.fn(),
    answerQuestion: vi.fn(),
  } as unknown as AgentRuntimeAdapter;
}

class MemoryImportedWorkspaceRepository implements ImportedAgentWorkspaceRepository {
  readonly rows: ImportedAgentWorkspace[] = [];

  list(agentType: Exclude<AgentType, "customer-agent">): ImportedAgentWorkspace[] {
    return this.rows.filter((row) => row.agentType === agentType);
  }

  findByPath(
    agentType: Exclude<AgentType, "customer-agent">,
    normalizedPath: string,
  ): ImportedAgentWorkspace | null {
    return this.rows.find((row) => row.agentType === agentType && row.normalizedPath === normalizedPath) ?? null;
  }

  save(workspace: ImportedAgentWorkspace): { workspace: ImportedAgentWorkspace; existing: boolean } {
    const existing = this.findByPath(workspace.agentType, workspace.normalizedPath);
    if (existing) return { workspace: existing, existing: true };
    this.rows.push(workspace);
    return { workspace, existing: false };
  }
}

describe("AgentWorkspaceIndexService", () => {
  it("isolates Agent requests and preserves adapter workspace order", async () => {
    const codex = adapter("codex", [workspace("codex", "second", 20), workspace("codex", "first", 10)]);
    const claude = adapter("claude-code", [workspace("claude-code", "claude", 0)]);
    const service = new AgentWorkspaceIndexService([codex, claude]);

    const page = await service.listWorkspaces("codex");

    expect(page.data.map((item) => item.workspaceId)).toEqual([
      CODEX_RECENT_WORKSPACE_ID,
      "second",
      "first",
    ]);
    expect(page.data[0]).toMatchObject({ name: "最近", canCreateSession: false });
    expect(codex.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(claude.listWorkspaces).not.toHaveBeenCalled();
  });

  it("coalesces concurrent first-page discovery for one Agent", async () => {
    let resolveRequest!: (page: { data: AgentWorkspace[]; nextCursor: null; watermark: string }) => void;
    const codex = adapter("codex", []);
    codex.listWorkspaces = vi.fn(() => new Promise<{ data: AgentWorkspace[]; nextCursor: null; watermark: string }>(
      (resolve) => { resolveRequest = resolve; },
    ));
    const service = new AgentWorkspaceIndexService([codex]);

    const first = service.listWorkspaces("codex");
    const second = service.listWorkspaces("codex");
    resolveRequest({ data: [workspace("codex", "repo", 0)], nextCursor: null, watermark: "2" });

    await expect(first).resolves.toEqual(await second);
    expect(codex.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("returns a stale first-page snapshot when refresh fails", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    const service = new AgentWorkspaceIndexService([codex]);
    await service.listWorkspaces("codex");
    codex.listWorkspaces = vi.fn(async () => { throw new Error("offline"); });

    const refreshed = await service.listWorkspaces("codex", { refresh: true });
    expect(refreshed.stale).toBe(true);
    expect(refreshed.data.some((item) => item.workspaceId === "repo")).toBe(true);
  });

  it("keeps the Codex session catalog when a workspace refresh does not change classification", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.discoverSessions = vi.fn(async () => [{
      ...session("codex", "recent"),
      cwd: "/elsewhere",
    }]);
    const service = new AgentWorkspaceIndexService([codex]);

    await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID);
    await service.listWorkspaces("codex", { refresh: true });
    await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID);

    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
  });

  it("invalidates the Codex session catalog when workspace roots change", async () => {
    const original = workspace("codex", "repo", 0);
    const changed = { ...original, roots: ["/repo-renamed"] };
    const codex = adapter("codex", [original]);
    codex.discoverSessions = vi.fn(async () => [{
      ...session("codex", "recent"),
      cwd: "/elsewhere",
    }]);
    const service = new AgentWorkspaceIndexService([codex]);

    await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID);
    codex.listWorkspaces = vi.fn(async () => ({ data: [changed], nextCursor: null, watermark: "2" }));
    await service.listWorkspaces("codex", { refresh: true });
    await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID);

    expect(codex.discoverSessions).toHaveBeenCalledTimes(2);
  });

  it("delegates a workspace session page only to its owning Agent", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    const claude = adapter("claude-code", [workspace("claude-code", "other", 0)]);
    const service = new AgentWorkspaceIndexService([codex, claude]);

    const page = await service.listWorkspaceSessions("claude-code", "other", { cursor: "cursor", limit: 25 });

    expect(page.data[0]?.agentType).toBe("claude-code");
    expect(claude.listWorkspaceSessions).toHaveBeenCalledWith("other", { cursor: "cursor", limit: 25 });
    expect(codex.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("deduplicates imported paths per Agent while allowing the same path for another Agent", async () => {
    const repository = new MemoryImportedWorkspaceRepository();
    const codex = adapter("codex", []);
    const claude = adapter("claude-code", []);
    const service = new AgentWorkspaceIndexService([codex, claude], repository, "darwin");

    const first = await service.importWorkspace("codex", "/repo/app", "App");
    const duplicate = await service.importWorkspace("codex", "/repo/app/.", "Ignored");
    const otherAgent = await service.importWorkspace("claude-code", "/repo/app", "App");

    expect(first.existing).toBe(false);
    expect(duplicate).toEqual({ workspace: first.workspace, existing: true });
    expect(otherAgent.existing).toBe(false);
    expect(otherAgent.workspace.workspaceId).not.toBe(first.workspace.workspaceId);
    expect(repository.rows).toHaveLength(2);
  });

  it("returns a native workspace when an imported path already belongs to the Agent", async () => {
    const repository = new MemoryImportedWorkspaceRepository();
    const native = workspace("codex", "native-project", 0);
    native.roots = ["/repo/native"];
    const service = new AgentWorkspaceIndexService([adapter("codex", [native])], repository, "darwin");

    await expect(service.importWorkspace("codex", "/repo/native")).resolves.toEqual({
      workspace: native,
      existing: true,
    });
    expect(repository.rows).toEqual([]);
  });

  it("merges duplicate native Codex projects by normalized roots and keeps every session", async () => {
    const older = workspace("codex", "older", 3);
    older.name = "agent-free";
    older.roots = ["/repo/agent-free/."];
    older.updatedAt = "2026-09-11T02:25:10.000Z";
    const newer = workspace("codex", "newer", 0);
    newer.name = "agent-free";
    newer.roots = ["/repo/agent-free"];
    newer.updatedAt = "2026-09-20T09:19:15.000Z";
    const sameNameElsewhere = workspace("codex", "elsewhere", 4);
    sameNameElsewhere.name = "agent-free";
    sameNameElsewhere.roots = ["/other/agent-free"];
    const codex = adapter("codex", [newer, older, sameNameElsewhere]);
    codex.listWorkspaceSessionsByPath = vi.fn(async () => ({
      data: [
        { ...session("codex", "new-session"), cwd: "/repo/agent-free", projectId: "newer" },
        { ...session("codex", "old-session"), cwd: "/repo/agent-free", projectId: "older" },
      ],
      nextCursor: null,
      watermark: "2",
    }));
    codex.discoverSessions = vi.fn(async () => [
      { ...session("codex", "old-session"), cwd: "", projectId: "older" },
    ]);
    const service = new AgentWorkspaceIndexService([codex], undefined, "darwin");

    const workspaces = await service.listWorkspaces("codex");
    const sessions = await service.listWorkspaceSessions("codex", "newer");
    const recent = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID);

    expect(workspaces.data.map((item) => item.workspaceId)).toEqual([
      CODEX_RECENT_WORKSPACE_ID,
      "newer",
      "elsewhere",
    ]);
    expect(sessions.data.map((item) => item.id)).toEqual(["new-session", "old-session"]);
    expect(sessions.data.every((item) => item.projectId === "newer")).toBe(true);
    expect(codex.listWorkspaceSessionsByPath).toHaveBeenCalledWith(
      "/repo/agent-free",
      expect.objectContaining({ cursor: null }),
    );
    expect(recent.data).toEqual([]);
  });

  it("appends imports after native order and queries imported sessions by cwd", async () => {
    const repository = new MemoryImportedWorkspaceRepository();
    const codex = adapter("codex", [
      workspace("codex", "native-second", 20),
      workspace("codex", "native-first", 10),
    ]);
    codex.discoverSessions = vi.fn(async () => [{
      ...session("codex", "codex-imported"),
      cwd: "/manual/repo",
    }]);
    const service = new AgentWorkspaceIndexService([codex], repository, "darwin");
    const imported = await service.importWorkspace("codex", "/manual/repo", "Manual");

    const workspaces = await service.listWorkspaces("codex");
    const sessions = await service.listWorkspaceSessions("codex", imported.workspace.workspaceId);

    expect(workspaces.data.map((item) => item.workspaceId)).toEqual([
      CODEX_RECENT_WORKSPACE_ID,
      "native-second",
      "native-first",
      imported.workspace.workspaceId,
    ]);
    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
    expect(codex.listWorkspaceSessionsByPath).not.toHaveBeenCalled();
    expect(sessions.data[0]).toMatchObject({
      cwd: "/manual/repo",
      projectId: imported.workspace.workspaceId,
    });
  });

  it("returns a native Codex project page before global discovery settles", async () => {
    let resolveDiscovery!: (sessions: UnifiedSessionSummary[]) => void;
    const discovery = new Promise<UnifiedSessionSummary[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    const direct = { ...session("codex", "direct"), projectId: "repo" };
    codex.listWorkspaceSessions = vi.fn(async () => ({
      data: [direct],
      nextCursor: "native-next",
      watermark: direct.updated,
    }));
    codex.discoverSessions = vi.fn(() => discovery);
    const service = new AgentWorkspaceIndexService([codex]);

    const page = await service.listWorkspaceSessions("codex", "repo", { limit: 20 });

    expect(page.data).toEqual([direct]);
    expect(page.nextCursor).toMatch(/^codex-native:/);
    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
    resolveDiscovery([]);
    await discovery;
  });

  it("merges project-ID, legacy-path, and supplemental Codex sessions after background discovery", async () => {
    let resolveDiscovery!: (sessions: UnifiedSessionSummary[]) => void;
    const discovery = new Promise<UnifiedSessionSummary[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const repo = workspace("codex", "repo", 0);
    const codex = adapter("codex", [repo]);
    const direct = Array.from({ length: 5 }, (_, index) => ({
      ...session("codex", `project-${index}`),
      cwd: "/repo",
      projectId: "repo",
      updated: `2026-09-04T00:00:0${index}.000Z`,
    }));
    const legacy = Array.from({ length: 2 }, (_, index) => ({
      ...session("codex", `legacy-${index}`),
      cwd: "/repo/legacy",
      updated: `2026-09-03T00:00:0${index}.000Z`,
    }));
    const supplemental = {
      ...session("codex", "supplemental"),
      cwd: "/repo",
      updated: "2026-09-02T00:00:00.000Z",
      compatibility: { status: "checking" as const, readerVersion: "0.153.0" },
      canResume: false,
    };
    codex.listWorkspaceSessions = vi.fn(async () => ({
      data: direct,
      nextCursor: null,
      watermark: direct[direct.length - 1]!.updated,
    }));
    codex.discoverSessions = vi.fn(() => discovery);
    const supplement = vi.fn((rows: readonly UnifiedSessionSummary[]) => [...rows, supplemental]);
    const service = new AgentWorkspaceIndexService([codex], undefined, "darwin", supplement);

    const first = await service.listWorkspaceSessions("codex", "repo", { limit: 20 });
    resolveDiscovery([...direct, ...legacy]);
    await discovery;
    await vi.waitFor(() => expect(supplement).toHaveBeenCalled());
    const reconciled = await service.listWorkspaceSessions("codex", "repo", { limit: 20, refresh: true });

    expect(first.data).toHaveLength(5);
    expect(reconciled.data).toHaveLength(8);
    expect(new Set(reconciled.data.map((item) => item.id)).size).toBe(8);
    expect(reconciled.data.every((item) => item.projectId === "repo")).toBe(true);
    expect(reconciled.data.map((item) => item.id)).toEqual([
      "project-0",
      "project-1",
      "project-2",
      "project-3",
      "project-4",
      "legacy-0",
      "legacy-1",
      "supplemental",
    ]);
    expect(supplement).toHaveBeenCalledWith([
      ...direct,
      ...legacy,
    ]);
  });

  it("preserves authoritative Codex recency order when timestamps imply another order", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.discoverSessions = vi.fn(async () => [
      {
        ...session("codex", "recency-first"),
        cwd: "/elsewhere",
        updated: "2026-09-04T00:00:01.000Z",
      },
      {
        ...session("codex", "recency-second"),
        cwd: "/elsewhere",
        updated: "2026-09-04T00:00:03.000Z",
      },
    ]);
    const service = new AgentWorkspaceIndexService([codex]);

    const page = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 });

    expect(page.data.map((item) => item.id)).toEqual(["recency-first", "recency-second"]);
  });

  it("continues a native Codex cursor after background catalog reconciliation", async () => {
    let resolveDiscovery!: (sessions: UnifiedSessionSummary[]) => void;
    const discovery = new Promise<UnifiedSessionSummary[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.listWorkspaceSessions = vi.fn(async (_workspaceId: string, query = {}) => ({
      data: [{ ...session("codex", query.cursor ? "second" : "first"), projectId: "repo" }],
      nextCursor: query.cursor ? null : "native-next",
      watermark: "1",
    }));
    codex.discoverSessions = vi.fn(() => discovery);
    const service = new AgentWorkspaceIndexService([codex]);

    const first = await service.listWorkspaceSessions("codex", "repo", { limit: 1 });
    resolveDiscovery([
      { ...session("codex", "catalog-first"), cwd: "/repo", projectId: "repo" },
      { ...session("codex", "catalog-second"), cwd: "/repo", projectId: "repo" },
    ]);
    await discovery;
    await vi.waitFor(() => expect(codex.discoverSessions).toHaveBeenCalledTimes(1));
    const second = await service.listWorkspaceSessions("codex", "repo", {
      limit: 1,
      cursor: first.nextCursor,
    });

    expect(second.data.map((item) => item.id)).toEqual(["second"]);
    expect(codex.listWorkspaceSessions).toHaveBeenLastCalledWith("repo", expect.objectContaining({
      cursor: "native-next",
      limit: 1,
    }));

    const reconciled = await service.listWorkspaceSessions("codex", "repo", { limit: 3, refresh: true });
    expect(reconciled.data.map((item) => item.id)).toEqual([
      "first",
      "second",
      "catalog-first",
    ]);
  });

  it("uses the most specific path and keeps sibling-prefix sessions in recent", async () => {
    const root = workspace("codex", "root", 0);
    root.roots = ["/repo/app"];
    const nested = workspace("codex", "nested", 1);
    nested.roots = ["/repo/app/packages/core"];
    const repository = new MemoryImportedWorkspaceRepository();
    const codex = adapter("codex", [root, nested]);
    codex.listWorkspaceSessions = vi.fn(async () => ({ data: [], nextCursor: null, watermark: "1" }));
    codex.discoverSessions = vi.fn(async () => [
      { ...session("codex", "direct"), cwd: "/elsewhere", projectId: "root" },
      { ...session("codex", "nested"), cwd: "/repo/app/packages/core/src" },
      { ...session("codex", "sibling"), cwd: "/repo/application" },
      { ...session("codex", "imported"), cwd: "/manual/repo/src" },
    ]);
    const service = new AgentWorkspaceIndexService([codex], repository, "darwin");
    const imported = await service.importWorkspace("codex", "/manual/repo", "Manual");

    await expect(service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID)).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "sibling", projectId: CODEX_RECENT_WORKSPACE_ID })],
    });
    await expect(service.listWorkspaceSessions("codex", "root")).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "direct", projectId: "root" })],
    });
    await expect(service.listWorkspaceSessions("codex", "nested")).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "nested", projectId: "nested" })],
    });
    await expect(service.listWorkspaceSessions("codex", imported.workspace.workspaceId)).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "imported", projectId: imported.workspace.workspaceId })],
    });
    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
  });

  it("pages every recent Codex session from one stable classified snapshot", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.discoverSessions = vi.fn(async () => Array.from({ length: 45 }, (_, index) => ({
      ...session("codex", `session-${String(index).padStart(2, "0")}`),
      cwd: "/elsewhere",
      updated: new Date(Date.UTC(2026, 8, 4, 0, 0, index)).toISOString(),
    })));
    const service = new AgentWorkspaceIndexService([codex]);

    const first = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 });
    const second = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20, cursor: first.nextCursor });
    const third = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20, cursor: second.nextCursor });
    const all = [...first.data, ...second.data, ...third.data];

    expect([first.data.length, second.data.length, third.data.length]).toEqual([20, 20, 5]);
    expect(new Set(all.map((item) => item.id)).size).toBe(45);
    expect(third.nextCursor).toBeNull();
    expect(first.nextCursor).toMatch(/^codex-catalog:/);
    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
  });

  it("does not let an older Codex discovery overwrite a refreshed snapshot", async () => {
    let resolveOldDiscovery!: (sessions: UnifiedSessionSummary[]) => void;
    const oldDiscovery = new Promise<UnifiedSessionSummary[]>((resolve) => {
      resolveOldDiscovery = resolve;
    });
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.discoverSessions = vi.fn()
      .mockImplementationOnce(() => oldDiscovery)
      .mockResolvedValueOnce([{
        ...session("codex", "new-session"),
        cwd: "/elsewhere",
      }]);
    const service = new AgentWorkspaceIndexService([codex]);
    await service.listWorkspaces("codex");

    const olderRequest = service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 });
    const refreshed = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20, refresh: true });
    resolveOldDiscovery([{
      ...session("codex", "old-session"),
      cwd: "/elsewhere",
    }]);

    expect(refreshed.data.map((item) => item.id)).toEqual(["new-session"]);
    await expect(olderRequest).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "new-session" })],
    });
    await expect(service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "new-session" })],
    });
    expect(codex.discoverSessions).toHaveBeenCalledTimes(2);
  });

  it("returns the cached Codex session page as stale when refresh discovery fails", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    codex.discoverSessions = vi.fn(async () => [{
      ...session("codex", "cached-session"),
      cwd: "/elsewhere",
    }]);
    const service = new AgentWorkspaceIndexService([codex]);
    await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 });
    codex.discoverSessions = vi.fn(async () => { throw new Error("offline"); });

    await expect(service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20, refresh: true })).resolves.toMatchObject({
      stale: true,
      data: [expect.objectContaining({ id: "cached-session" })],
    });
  });

  it("supplements the complete Codex snapshot after unchanged adapter discovery", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    const primary = { ...session("codex", "primary"), cwd: "/elsewhere" };
    const supplemental = {
      ...session("codex", "supplemental"),
      cwd: "/elsewhere",
      compatibility: { status: "checking" as const, readerVersion: "0.153.0" },
      canResume: false,
    };
    codex.discoverSessions = vi.fn(async () => [primary]);
    const supplement = vi.fn((rows: readonly UnifiedSessionSummary[]) => [...rows, supplemental]);
    const service = new AgentWorkspaceIndexService([codex], undefined, "darwin", supplement);

    const page = await service.listWorkspaceSessions("codex", CODEX_RECENT_WORKSPACE_ID, { limit: 20 });

    expect(page.data.map((item) => item.id)).toEqual(["primary", "supplemental"]);
    expect(supplement).toHaveBeenCalledWith([primary]);
    expect(codex.discoverSessions).toHaveBeenCalledTimes(1);
  });
});

describe("workspace pagination", () => {
  it("uses opaque offset cursors and rejects malformed cursors", () => {
    const page = paginateByOffset(["a", "b", "c"], { limit: 2 });
    expect(page.data).toEqual(["a", "b"]);
    expect(decodeOffsetCursor(page.nextCursor)).toBe(2);
    expect(() => decodeOffsetCursor("broken")).toThrow("Invalid workspace cursor");
  });
});
