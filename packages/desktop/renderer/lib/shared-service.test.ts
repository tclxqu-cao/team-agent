import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentApi } from "../global";
import { createSharedAgentApi, ServiceEventSource, type SharedServiceApi } from "./shared-service";
afterEach(() => vi.useRealTimers());
describe("desktop SSE transport", () => {
  it("loads calendar data through the authenticated shared-service transport", async () => {
    const overview = { days: {}, sources: {}, unscheduled: [], unscheduledSchedules: [] };
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify(overview) }));
    const api = createSharedAgentApi({ request } as unknown as SharedServiceApi, {} as AgentApi);
    await expect(api.calendarOverview!({ from: "2026-11-01", to: "2026-11-30" })).resolves.toEqual(overview);
    expect(request).toHaveBeenCalledWith("/api/calendar?from=2026-11-01&to=2026-11-30", "GET", undefined);
  });
  it("handles split multiline frames and resumes with the last event id", async () => {
    vi.useFakeTimers();
    let frame: (value: { id: string; type: string; data?: string }) => void = () => {};
    const remove = vi.fn();
    const api = { onFrame: (listener: typeof frame) => { frame = listener; return remove; }, stream: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as unknown as SharedServiceApi;
    const source = new ServiceEventSource("/api/agent/stream?sessionId=one", api);
    const received: string[] = []; source.onmessage = (event) => received.push(event.data);
    await Promise.resolve();
    frame({ id: source.id, type: "open" });
    frame({ id: source.id, type: "data", data: 'id: 17\r\ndata: first\r\nda' });
    frame({ id: source.id, type: "data", data: 'ta: second\r\n\r\n' });
    expect(received).toEqual(["first\nsecond"]);
    frame({ id: source.id, type: "error" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.stream).toHaveBeenLastCalledWith(source.id, "/api/agent/stream?sessionId=one", "17");
    source.close(); expect(remove).toHaveBeenCalledOnce(); expect(api.stop).toHaveBeenCalledWith(source.id);
    frame({ id: source.id, type: "data", data: "data: late\n\n" }); expect(received).toHaveLength(1);
  });

  it("keeps the file workspace adapter on the trusted desktop device bridge", async () => {
    const request = vi.fn(async () => ({ entries: [] }));
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const service = {} as SharedServiceApi;
    const device = {
      fileWorkspaceRequest: request,
      onFileWorkspaceEvent: subscribe,
    } as unknown as AgentApi;

    const agentApi = createSharedAgentApi(service, device);
    await agentApi.fileWorkspaceRequest("fs:list", { path: "/workspace" });
    const listener = vi.fn();
    const stop = agentApi.onFileWorkspaceEvent(listener);

    expect(request).toHaveBeenCalledWith("fs:list", { path: "/workspace" });
    expect(subscribe).toHaveBeenCalledWith(listener);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("routes openExternal to the desktop device bridge, not the http gateway", async () => {
    const openExternal = vi.fn(async () => ({ ok: true }));
    const service = {} as SharedServiceApi;
    const device = { openExternal } as unknown as AgentApi;

    const agentApi = createSharedAgentApi(service, device);
    await agentApi.openExternal!("https://flow.example/auth/entry?token=t&view=dh");

    expect(openExternal).toHaveBeenCalledWith("https://flow.example/auth/entry?token=t&view=dh");
  });

  it("keeps split-pane website operations on the local native view bridge", async () => {
    const request = vi.fn();
    const taskPageOpen = vi.fn(async () => ({ ok: true }));
    const taskPageSetBounds = vi.fn(async () => ({ ok: true }));
    const taskPageClose = vi.fn(async () => ({ ok: true }));
    const api = createSharedAgentApi({ request } as unknown as SharedServiceApi, { taskPageOpen, taskPageSetBounds, taskPageClose } as unknown as AgentApi);
    await api.taskPageOpen("left", "https://example.com");
    await api.taskPageSetBounds("left", null);
    await api.taskPageClose("left");
    expect(taskPageOpen).toHaveBeenCalledWith("left", "https://example.com");
    expect(taskPageSetBounds).toHaveBeenCalledWith("left", null);
    expect(taskPageClose).toHaveBeenCalledWith("left");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps artifact file menus on the trusted desktop bridge", async () => {
    const showFileContextMenu = vi.fn(async () => ({ shown: true as const }));
    const request = vi.fn();
    const api = createSharedAgentApi({ request } as unknown as SharedServiceApi, { showFileContextMenu } as unknown as AgentApi);
    await expect(api.showFileContextMenu!("/tmp/Word 优化版.docx")).resolves.toEqual({ shown: true });
    expect(showFileContextMenu).toHaveBeenCalledWith("/tmp/Word 优化版.docx");
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards notification reads and their expected scope through the pinned device operation", async () => {
    const notificationRead = vi.fn(async () => ({ ok: true }));
    const request = vi.fn();
    const api = createSharedAgentApi({ request } as unknown as SharedServiceApi, { notificationRead } as unknown as AgentApi);
    const scope = { serviceId: "service-one", ownerId: "owner-one" };
    await expect(api.notificationRead!("n", scope)).resolves.toEqual({ ok: true });
    expect(notificationRead).toHaveBeenCalledWith("n", scope);
    expect(request).not.toHaveBeenCalled();
  });

  it("carries the selected fork point through the shared server transport", async () => {
    const request = vi.fn(async () => ({ status: 201, body: JSON.stringify({ id: "runtime:codex:fork" }) }));
    const localFork = vi.fn();
    const agentApi = createSharedAgentApi({ request } as unknown as SharedServiceApi, { forkSession: localFork } as unknown as AgentApi);

    await expect(agentApi.forkSession("runtime:codex:source", { turnId: "turn-2" })).resolves.toMatchObject({ id: "runtime:codex:fork" });

    expect(request).toHaveBeenCalledWith("/api/sessions/runtime%3Acodex%3Asource/fork-at", "POST", JSON.stringify({ point: { turnId: "turn-2" } }));
    expect(localFork).not.toHaveBeenCalled();
  });

  it("routes group commands through the shared server instead of the local device bridge", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify([{ id: "group" }]) }));
    const localCollaboration = vi.fn();
    const agentApi = createSharedAgentApi({ request } as unknown as SharedServiceApi, { collaboration: localCollaboration } as unknown as AgentApi);
    await expect(agentApi.collaboration({ action: "groups" })).resolves.toEqual([{ id: "group" }]);
    expect(request).toHaveBeenCalledWith("/api/collaboration", "POST", JSON.stringify({ action: "groups" }));
    expect(localCollaboration).not.toHaveBeenCalled();
  });
});
