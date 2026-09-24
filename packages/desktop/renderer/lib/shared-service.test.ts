import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentApi } from "../global";
import { createSharedAgentApi, ServiceEventSource, type SharedServiceApi } from "./shared-service";
afterEach(() => vi.useRealTimers());
describe("desktop SSE transport", () => {
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
});
