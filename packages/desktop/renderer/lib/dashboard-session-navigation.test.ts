import { expect, it, vi } from "vitest";
import type { AgentApi } from "../global";
import { resolveDashboardSession } from "./dashboard-session-navigation";

it("uses the existing workspace catalog IDs when opening an original or hidden member session", async () => {
  const api = {
    listAgentWorkspaces: vi.fn(async () => ({ data: [{ workspaceId: "native-workspace", agentType: "codex", name: "project", roots: ["/project"], order: 0, source: "native" }], nextCursor: null })),
    listAgentWorkspaceSessions: vi.fn(async () => ({ data: [{ id: "codex:original", title: "原始会话", cwd: "/project", agentType: "codex" }], nextCursor: null })),
    getSession: vi.fn(async (id: string) => ({ id, title: "源会话", cwd: "/project", agentType: "codex" })),
  } as unknown as AgentApi;
  const target = { id: "codex:original", title: "原始会话", cwd: "/project", agentType: "codex" as const };
  const original = await resolveDashboardSession(api, target, new AbortController().signal);
  expect(original.session.projectId).toBe("native-workspace");
  expect(api.getSession).toHaveBeenCalledWith("codex:original", { limit: 1 });
  const internal = await resolveDashboardSession(api, { ...target, id: "codex:internal" }, new AbortController().signal);
  expect(internal.session.projectId).toBe("native-workspace");
  expect(api.getSession).toHaveBeenCalledWith("codex:internal", { limit: 1 });
  expect(api.listAgentWorkspaceSessions).not.toHaveBeenCalled();
});

const target = { id: "runtime:codex:target", title: "运行任务", cwd: "/project", agentType: "codex" as const };
const workspace = { workspaceId: "project", agentType: "codex" as const, name: "project", roots: ["/project"], order: 0, source: "native" as const };
function fixture() {
  const methods = {
    getSession: vi.fn(async () => ({ ...target, projectId: "project", messages: ["private history"], events: ["private events"], history: { hasMore: true } })),
    listAgentWorkspaces: vi.fn(async () => ({ data: [workspace], nextCursor: null as string | null, watermark: null })),
    listAgentWorkspaceSessions: vi.fn(async () => { throw new Error("Should not scan every session"); }),
  };
  return { api: methods as unknown as AgentApi, ...methods };
}

it("opens a cached workspace with one exact detail request and preserves cached sibling sessions", async () => {
  const { api, getSession, listAgentWorkspaces, listAgentWorkspaceSessions } = fixture();
  const cached = { workspaces: [workspace], sessions: [{ ...target, id: "sibling", projectId: "project" }] } as Parameters<typeof resolveDashboardSession>[3];
  const before = JSON.stringify(cached);
  const result = await resolveDashboardSession(api, target, new AbortController().signal, cached);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(getSession).toHaveBeenCalledWith(target.id, { limit: 1 });
  expect(listAgentWorkspaces).not.toHaveBeenCalled();
  expect(listAgentWorkspaceSessions).not.toHaveBeenCalled();
  expect(result.snapshot.sessions.map(session => session.id)).toEqual(["sibling", target.id]);
  expect(JSON.stringify(cached)).toBe(before);
  expect(result.session).not.toHaveProperty("messages");
  expect(result.session).not.toHaveProperty("events");
  expect(result.session).not.toHaveProperty("history");
});

it("only pages workspace metadata until the target workspace is found", async () => {
  const { api, listAgentWorkspaces, listAgentWorkspaceSessions } = fixture();
  listAgentWorkspaces.mockResolvedValueOnce({ data: [{ ...workspace, workspaceId: "other", roots: ["/other"] }], nextCursor: "next", watermark: null });
  const result = await resolveDashboardSession(api, target, new AbortController().signal);
  expect(result.session.id).toBe(target.id);
  expect(result.session.projectId).toBe("project");
  expect(listAgentWorkspaces).toHaveBeenCalledTimes(2);
  expect(listAgentWorkspaceSessions).not.toHaveBeenCalled();
});

it.each(["wrong-id", "wrong-agent"])("rejects a %s response instead of opening another conversation", async problem => {
  const { api, getSession, listAgentWorkspaces } = fixture();
  getSession.mockResolvedValue({ ...target, id: problem === "wrong-id" ? "another-session" : target.id, agentType: problem === "wrong-agent" ? "qoder" : "codex" } as Awaited<ReturnType<typeof getSession>>);
  await expect(resolveDashboardSession(api, target, new AbortController().signal)).rejects.toThrow("身份不匹配");
  expect(listAgentWorkspaces).not.toHaveBeenCalled();
});

it("cancels an old navigation before resolving its workspace when a newer target is selected", async () => {
  const { api, getSession, listAgentWorkspaces } = fixture();
  const controller = new AbortController();
  getSession.mockImplementationOnce(async () => { controller.abort(); return { ...target } as Awaited<ReturnType<typeof getSession>>; });
  await expect(resolveDashboardSession(api, target, controller.signal)).rejects.toThrow();
  expect(listAgentWorkspaces).not.toHaveBeenCalled();
});

it("can open an accessible internal session without an ordinary workspace entry", async () => {
  const { api, listAgentWorkspaces } = fixture();
  listAgentWorkspaces.mockResolvedValue({ data: [], nextCursor: null, watermark: null });
  const result = await resolveDashboardSession(api, target, new AbortController().signal);
  expect(result.session.id).toBe(target.id);
  expect(result.snapshot.workspaces[0]).toMatchObject({ workspaceId: "project", roots: [target.cwd], canCreateSession: false });
});

it("terminates repeated workspace cursors instead of waiting indefinitely", async () => {
  const { api, listAgentWorkspaces } = fixture();
  listAgentWorkspaces.mockResolvedValue({ data: [], nextCursor: "repeat", watermark: null });
  await expect(resolveDashboardSession(api, target, new AbortController().signal)).rejects.toThrow("加载中断");
  expect(listAgentWorkspaces).toHaveBeenCalledTimes(2);
});
