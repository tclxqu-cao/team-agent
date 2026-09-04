import { describe, expect, it, vi } from "vitest";
import { AgentWorkspaceIndexService, decodeOffsetCursor, paginateByOffset } from "./agent-workspace-index.js";
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
    discoverSessions: vi.fn(),
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

    expect(page.data.map((item) => item.workspaceId)).toEqual(["second", "first"]);
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

    await expect(service.listWorkspaces("codex", { refresh: true })).resolves.toMatchObject({
      stale: true,
      data: [expect.objectContaining({ workspaceId: "repo" })],
    });
  });

  it("delegates a workspace session page only to its owning Agent", async () => {
    const codex = adapter("codex", [workspace("codex", "repo", 0)]);
    const claude = adapter("claude-code", [workspace("claude-code", "other", 0)]);
    const service = new AgentWorkspaceIndexService([codex, claude]);

    const page = await service.listWorkspaceSessions("codex", "repo", { cursor: "cursor", limit: 25 });

    expect(page.data[0]?.agentType).toBe("codex");
    expect(codex.listWorkspaceSessions).toHaveBeenCalledWith("repo", { cursor: "cursor", limit: 25 });
    expect(claude.listWorkspaceSessions).not.toHaveBeenCalled();
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

  it("appends imports after native order and queries imported sessions by cwd", async () => {
    const repository = new MemoryImportedWorkspaceRepository();
    const codex = adapter("codex", [
      workspace("codex", "native-second", 20),
      workspace("codex", "native-first", 10),
    ]);
    const service = new AgentWorkspaceIndexService([codex], repository, "darwin");
    const imported = await service.importWorkspace("codex", "/manual/repo", "Manual");

    const workspaces = await service.listWorkspaces("codex");
    const sessions = await service.listWorkspaceSessions("codex", imported.workspace.workspaceId);

    expect(workspaces.data.map((item) => item.workspaceId)).toEqual([
      "native-second",
      "native-first",
      imported.workspace.workspaceId,
    ]);
    expect(codex.listWorkspaceSessionsByPath).toHaveBeenCalledWith("/manual/repo", { limit: 50 });
    expect(sessions.data[0]).toMatchObject({
      cwd: "/manual/repo",
      projectId: imported.workspace.workspaceId,
    });
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
