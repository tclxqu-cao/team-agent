import { describe, expect, it, vi } from "vitest";
import { AgentWorkspaceIndexService } from "./agent-workspace-index.js";
import { QoderRuntimeAdapter } from "./qoder-runtime-adapter.js";
import { ZCodeRuntimeAdapter } from "./zcode-runtime-adapter.js";
import { WorkBuddyRuntimeAdapter } from "./workbuddy-runtime-adapter.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError, type ImportedAgentWorkspace, type ImportedAgentWorkspaceRepository } from "./types.js";

const factories = [
  { agentType: "qoder", create: (client: NativeSessionProtocol) => new QoderRuntimeAdapter(client) },
  { agentType: "zcode", create: (client: NativeSessionProtocol) => new ZCodeRuntimeAdapter(client) },
  { agentType: "workbuddy", create: (client: NativeSessionProtocol) => new WorkBuddyRuntimeAdapter(client) },
] as const;

function session(id: string, cwd: string, updated = "2026-10-27T00:00:00.000Z"): NativeProtocolSession {
  return { id, title: id, cwd, created: "2026-10-26T00:00:00.000Z", updated };
}

function protocol(sessions: NativeProtocolSession[]) {
  return {
    available: vi.fn(async () => {}),
    list: vi.fn(async () => sessions),
    read: vi.fn(async () => ({ session: sessions[0]!, messages: [] })),
    create: vi.fn(async () => sessions[0]!),
    run: vi.fn(async function* () {}),
    abort: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => false),
    listModels: vi.fn(async () => []),
    dispose: vi.fn(async () => {}),
  } satisfies NativeSessionProtocol;
}

describe.each(factories)("$agentType directory discovery", ({ agentType, create }) => {
  it("keeps native child sessions visible under a parent in a different working directory", async () => {
    const client = protocol([
      session("parent", "/repo/main"),
      { ...session("child", "/repo/worker"), parentSessionId: "parent", readOnly: true },
    ]);
    const adapter = create(client);
    const workspaces = (await adapter.listWorkspaces()).data;
    expect(workspaces.map(row => row.roots[0])).toEqual(["/repo/main"]);
    const children = (await adapter.listWorkspaceSessions(workspaces[0].workspaceId)).data;
    expect(children).toHaveLength(2);
    expect(children.find(row => row.nativeSessionId === "child")).toMatchObject({ cwd: "/repo/worker", parentSessionId: children.find(row => row.nativeSessionId === "parent")!.id, canResume: false });
  });
  it("derives paginated stable directories from native cwd and keeps the newest timestamp", async () => {
    const client = protocol([
      session("older", "/repo/team/", "2026-10-26T00:00:00.000Z"),
      session("newer", "/repo/team/.", "2026-10-27T00:00:00.000Z"),
      session("other", "/repo/other", "2026-10-26T12:00:00.000Z"),
      session("unknown", ""),
      session("newer", "/repo/team/.", "2026-10-25T00:00:00.000Z"),
    ]);
    const adapter = create(client);
    const index = new AgentWorkspaceIndexService([adapter]);
    const first = await index.listWorkspaces(agentType, { limit: 1 });
    expect(first.data).toEqual([expect.objectContaining({ agentType, name: "team", roots: ["/repo/team"], source: "derived", updatedAt: "2026-10-27T00:00:00.000Z" })]);
    expect(first.nextCursor).toBeTruthy();
    const second = await index.listWorkspaces(agentType, { cursor: first.nextCursor, limit: 1 });
    expect(second.data.map(row => row.name)).toEqual(["other"]);
    expect(second.nextCursor).toBeNull();
    client.list.mockResolvedValue([session("newer", "/repo/team")]);
    const refreshed = await index.listWorkspaces(agentType, { refresh: true });
    expect(refreshed.data[0].workspaceId).toBe(first.data[0].workspaceId);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
    expect(client.listModels).not.toHaveBeenCalled();
  });

  it("loads only exact-directory sessions with native identities and safe pagination", async () => {
    const client = protocol([
      session("newer", "/repo/team/", "2026-10-27T00:00:00.000Z"),
      session("older", "/repo/team", "2026-10-26T00:00:00.000Z"),
      session("sibling", "/repo/team-other"),
      session("child", "/repo/team/child"),
      session("newer", "/repo/team/", "2026-10-27T00:00:00.000Z"),
    ]);
    const index = new AgentWorkspaceIndexService([create(client)]);
    const workspace = (await index.listWorkspaces(agentType)).data.find(row => row.roots[0] === "/repo/team")!;
    const first = await index.listWorkspaceSessions(agentType, workspace.workspaceId, { limit: 1 });
    expect(first.data).toEqual([expect.objectContaining({ agentType, nativeSessionId: "newer", projectId: workspace.workspaceId, cwd: "/repo/team/" })]);
    const second = await index.listWorkspaceSessions(agentType, workspace.workspaceId, { cursor: first.nextCursor, limit: 1 });
    expect(second.data.map(row => row.nativeSessionId)).toEqual(["older"]);
    expect(second.nextCursor).toBeNull();
    expect(client.read).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("supports empty imported directories and refreshes their native session list", async () => {
    const client = protocol([]);
    const rows: ImportedAgentWorkspace[] = [];
    const repository: ImportedAgentWorkspaceRepository = {
      list: type => rows.filter(row => row.agentType === type),
      findByPath: (type, path) => rows.find(row => row.agentType === type && row.normalizedPath === path) ?? null,
      save: workspace => { rows.push(workspace); return { workspace, existing: false }; },
    };
    const index = new AgentWorkspaceIndexService([create(client)], repository);
    const imported = await index.importWorkspace(agentType, "/repo/empty", "Empty");
    expect((await index.listWorkspaces(agentType)).data).toEqual([expect.objectContaining({ name: "Empty", source: "imported" })]);
    expect((await index.listWorkspaceSessions(agentType, imported.workspace.workspaceId)).data).toEqual([]);
    client.list.mockResolvedValue([session("arrived", "/repo/empty")]);
    const refreshed = await index.listWorkspaceSessions(agentType, imported.workspace.workspaceId, { refresh: true });
    expect(refreshed.data).toEqual([expect.objectContaining({ nativeSessionId: "arrived", projectId: imported.workspace.workspaceId })]);
    expect(client.create).not.toHaveBeenCalled();
  });

  it("keeps empty catalogs empty rather than inventing a working directory", async () => {
    const adapter = create(protocol([session("no-cwd", " ")]));
    expect((await adapter.listWorkspaces()).data).toEqual([]);
    expect(await adapter.discoverSessions()).toHaveLength(1);
  });

  it("does not hide native discovery failures as an empty successful result", async () => {
    const client = protocol([]);
    client.list.mockRejectedValue(new RuntimeSessionError("native catalog unavailable", "RUNTIME_UNAVAILABLE"));
    await expect(create(client).listWorkspaces()).rejects.toThrow("native catalog unavailable");
  });

  it("rejects unknown directories and malformed pagination", async () => {
    const adapter = create(protocol([session("one", "/repo/team")]));
    await expect(adapter.listWorkspaceSessions("missing")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(adapter.listWorkspaces({ cursor: "invalid" })).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    await expect(adapter.listWorkspaceSessionsByPath("/repo/team", { limit: 0 })).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
  });
});
