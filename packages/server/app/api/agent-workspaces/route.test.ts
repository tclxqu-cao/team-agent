import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentType, readWorkspaceQuery } from "./agent-workspace-http";
import { GET as listWorkspaces, POST as importWorkspace } from "./route";
import { GET as listWorkspaceSessions } from "./[workspaceId]/sessions/route";

const state = {
  nativeWorkspaceCalls: [] as unknown[][],
  nativeSessionCalls: [] as unknown[][],
  nativeImportCalls: [] as unknown[][],
};

vi.mock("../agent-host", () => ({
  agentHost: {
    getProjectStore: () => ({
      list: async () => [
        { id: "second", name: "Second", description: "/second", created: "1", updated: "2" },
        { id: "first", name: "First", description: "/first", created: "1", updated: "1" },
      ],
      get: async (id: string) => id === "second"
        ? { id, name: "Second", description: "/second", created: "1", updated: "2" }
        : null,
    }),
    getSessionStore: () => ({
      list: async () => [],
    }),
    isSessionRunning: () => false,
  },
}));

vi.mock("../../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({
    listWorkspaces: async (...args: unknown[]) => {
      state.nativeWorkspaceCalls.push(args);
      return { data: [], nextCursor: null, watermark: null };
    },
    listWorkspaceSessions: async (...args: unknown[]) => {
      state.nativeSessionCalls.push(args);
      return { data: [], nextCursor: null, watermark: null };
    },
    importWorkspace: async (...args: unknown[]) => {
      state.nativeImportCalls.push(args);
      return {
        workspace: {
          agentType: args[0],
          workspaceId: "imported:test",
          name: args[2] || "repo",
          roots: [args[1]],
          order: 1,
          source: "imported",
        },
        existing: false,
      };
    },
  }),
  runtimeErrorStatus: () => 500,
}));

vi.mock("../projects/project-http", () => ({
  webProjectService: {
    canonicalDirectory: (path: string) => path.replace(/\/$/, ""),
    list: async () => [],
    create: async () => { throw new Error("not used"); },
  },
  projectErrorResponse: () => ({ status: 500, body: { error: "failed", code: "FAILED" } }),
}));

describe("agent workspace routes", () => {
  beforeEach(() => {
    state.nativeWorkspaceCalls = [];
    state.nativeSessionCalls = [];
    state.nativeImportCalls = [];
  });

  it("validates Agent type and pagination query", () => {
    expect(readAgentType("codex")).toBe("codex");
    expect(readAgentType("unknown")).toBeNull();
    expect(readWorkspaceQuery(new URL("http://test?limit=25&cursor=next&refresh=1&since=watermark"))).toEqual({
      limit: 25,
      cursor: "next",
      refresh: true,
      since: "watermark",
    });
    expect(() => readWorkspaceQuery(new URL("http://test?limit=0"))).toThrow("limit must be an integer");
  });

  it("preserves Customer Agent project-store order", async () => {
    const response = await listWorkspaces(new Request("http://test/api/agent-workspaces?agentType=customer-agent"));
    const page = await response.json();

    expect(response.status).toBe(200);
    expect(page.data.map((workspace: { workspaceId: string }) => workspace.workspaceId)).toEqual(["second", "first"]);
  });

  it("delegates only the requested native Agent with cursor fields", async () => {
    const response = await listWorkspaces(new Request(
      "http://test/api/agent-workspaces?agentType=codex&limit=20&cursor=opaque&refresh=1",
    ));

    expect(response.status).toBe(200);
    expect(state.nativeWorkspaceCalls).toEqual([["codex", {
      cursor: "opaque",
      limit: 20,
      refresh: true,
      since: null,
    }]]);
  });

  it("URL-decodes the workspace ID and delegates session paging", async () => {
    const response = await listWorkspaceSessions(
      new Request("http://test/api/agent-workspaces/repo%20one/sessions?agentType=claude-code&limit=10&cursor=next"),
      { params: { workspaceId: "repo one" } },
    );

    expect(response.status).toBe(200);
    expect(state.nativeSessionCalls).toEqual([["claude-code", "repo one", {
      cursor: "next",
      limit: 10,
      refresh: false,
    }]]);
  });

  it("validates and imports a native Agent workspace", async () => {
    const response = await importWorkspace(new Request("http://test/api/agent-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentType: "opencode", path: "/repo/app/", name: "App" }),
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { agentType: "opencode", roots: ["/repo/app"], source: "imported" },
      existing: false,
    });
    expect(state.nativeImportCalls).toEqual([["opencode", "/repo/app", "App"]]);
  });
});
