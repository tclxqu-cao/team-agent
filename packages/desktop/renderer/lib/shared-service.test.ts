import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceEventSource, type SharedServiceApi } from "./shared-service";
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
});
