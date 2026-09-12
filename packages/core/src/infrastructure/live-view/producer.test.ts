import { describe, expect, it, vi } from "vitest";
import { LiveViewProducer } from "./producer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("LiveViewProducer", () => {
  it("serializes takeover, input, and return around agent pause and resync", async () => {
    const events: Array<(event: Record<string, unknown>) => void> = [];
    const states: string[] = [];
    const pause = deferred();
    const disconnected = deferred();
    const client = {
      connect: vi.fn(),
      publish: vi.fn().mockResolvedValue({ channelId: 4 }),
      onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => { events.push(listener); return () => undefined; }),
      frame: vi.fn(),
      state: vi.fn(async (_id: string, state: string) => { states.push(state); }),
      inputResult: vi.fn(async () => undefined),
      webrtcRelay: vi.fn(async () => undefined),
      unavailable: vi.fn(),
      waitForDisconnect: vi.fn(() => disconnected.promise),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const started = deferred();
    const screencast = {
      start: vi.fn(() => started.promise),
      stop: vi.fn().mockResolvedValue(undefined),
      dispatchInput: vi.fn().mockResolvedValue(undefined),
    };
    const producer = new LiveViewProducer({
      client,
      screencast,
      metadata: { sessionId: "browser-1", backend: "codex-browser" },
      pauseAgent: vi.fn(() => pause.promise),
      resyncAgent: vi.fn().mockResolvedValue(undefined),
    });
    const running = producer.run();
    await flush();
    expect(events).toHaveLength(1);

    events[0]({ type: "browser:takeover-requested", sessionId: "browser-1" });
    events[0]({ type: "browser:input", sessionId: "browser-1", input: { kind: "pointer" } });
    await Promise.resolve();
    expect(states).toEqual([]);
    expect(screencast.dispatchInput).not.toHaveBeenCalled();

    pause.resolve();
    await flush();
    expect(states).toEqual(["user-controlled"]);
    expect(screencast.dispatchInput).toHaveBeenCalledTimes(1);
    events[0]({ type: "browser:return-requested", sessionId: "browser-1" });
    await flush();
    expect(states).toEqual(["user-controlled", "resyncing", "agent-controlled"]);

    started.resolve();
    await running;
  });

  it("relays the adapter input result back under the request token", async () => {
    const events: Array<(event: Record<string, unknown>) => void> = [];
    const started = deferred();
    const hitTest = { editable: true, bounds: { x: 1, y: 2, w: 3, h: 4 } };
    const client = {
      connect: vi.fn(),
      publish: vi.fn().mockResolvedValue({ channelId: 4 }),
      onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => { events.push(listener); return () => undefined; }),
      frame: vi.fn(),
      state: vi.fn().mockResolvedValue(undefined),
      inputResult: vi.fn(async () => undefined),
      webrtcRelay: vi.fn(async () => undefined),
      unavailable: vi.fn(),
      waitForDisconnect: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const producer = new LiveViewProducer({
      client,
      screencast: { start: vi.fn(() => started.promise), stop: vi.fn().mockResolvedValue(undefined), dispatchInput: vi.fn(async () => hitTest) },
      metadata: { sessionId: "browser-1", backend: "desktop" },
      pauseAgent: vi.fn(),
      resyncAgent: vi.fn(),
    });
    const running = producer.run();
    await flush();
    events[0]({ type: "browser:takeover-requested", sessionId: "browser-1" });
    await flush();

    events[0]({ type: "browser:input", sessionId: "browser-1", input: { kind: "pointer", action: "up" }, token: 7 });
    await flush();
    expect(client.inputResult).toHaveBeenCalledWith("browser-1", 7, hitTest);

    client.inputResult.mockClear();
    events[0]({ type: "browser:input", sessionId: "browser-1", input: { kind: "pointer", action: "up" } });
    await flush();
    expect(client.inputResult).not.toHaveBeenCalled();

    started.resolve();
    await running;
  });

  it("reports a screencast capability failure without an unhandled rejection", async () => {
    const disconnected = deferred();
    const error = Object.assign(new Error("no frames"), { code: "BROWSER_LIVE_STREAM_UNAVAILABLE" });
    const client = {
      connect: vi.fn(),
      publish: vi.fn().mockResolvedValue({ channelId: 4 }),
      onEvent: vi.fn(() => () => undefined),
      unavailable: vi.fn().mockResolvedValue(undefined),
      waitForDisconnect: vi.fn(() => disconnected.promise),
      frame: vi.fn(),
      state: vi.fn().mockResolvedValue(undefined),
      inputResult: vi.fn(async () => undefined),
      webrtcRelay: vi.fn(async () => undefined),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const onError = vi.fn();
    const producer = new LiveViewProducer({
      client,
      screencast: { start: vi.fn().mockRejectedValue(error), stop: vi.fn().mockResolvedValue(undefined), dispatchInput: vi.fn() },
      metadata: { sessionId: "browser-1", backend: "ego-browser" },
      pauseAgent: vi.fn(),
      resyncAgent: vi.fn(),
      onError,
    });
    const running = producer.run();
    await flush();
    expect(client.unavailable).toHaveBeenCalledWith("browser-1", error);
    expect(onError).toHaveBeenCalledWith(error);
    disconnected.resolve();
    await running;
  });

  it("restores agent control when pausing for takeover fails", async () => {
    const events: Array<(event: Record<string, unknown>) => void> = [];
    const started = deferred();
    const states: string[] = [];
    const onError = vi.fn(() => { throw new Error("error callback failed"); });
    const client = {
      connect: vi.fn(),
      publish: vi.fn().mockResolvedValue({ channelId: 4 }),
      onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => { events.push(listener); return () => undefined; }),
      frame: vi.fn(),
      state: vi.fn(async (_id: string, state: string) => { states.push(state); }),
      inputResult: vi.fn(async () => undefined),
      webrtcRelay: vi.fn(async () => undefined),
      unavailable: vi.fn(),
      waitForDisconnect: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const producer = new LiveViewProducer({
      client,
      screencast: { start: vi.fn(() => started.promise), stop: vi.fn().mockResolvedValue(undefined), dispatchInput: vi.fn() },
      metadata: { sessionId: "browser-1", backend: "codex-browser" },
      pauseAgent: vi.fn().mockRejectedValue(new Error("pause failed")),
      resyncAgent: vi.fn(),
      onError,
    });

    const running = producer.run();
    await flush();
    events[0]({ type: "browser:takeover-requested", sessionId: "browser-1" });
    await flush();
    expect(states).toEqual(["agent-controlled"]);
    expect(onError).toHaveBeenCalledTimes(1);

    started.resolve();
    await running;
  });

  it("keeps user control when agent resync fails", async () => {
    const events: Array<(event: Record<string, unknown>) => void> = [];
    const started = deferred();
    const states: string[] = [];
    const onError = vi.fn();
    const client = {
      connect: vi.fn(),
      publish: vi.fn().mockResolvedValue({ channelId: 4 }),
      onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => { events.push(listener); return () => undefined; }),
      frame: vi.fn(),
      state: vi.fn(async (_id: string, state: string) => { states.push(state); }),
      inputResult: vi.fn(async () => undefined),
      webrtcRelay: vi.fn(async () => undefined),
      unavailable: vi.fn(),
      waitForDisconnect: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const producer = new LiveViewProducer({
      client,
      screencast: { start: vi.fn(() => started.promise), stop: vi.fn().mockResolvedValue(undefined), dispatchInput: vi.fn() },
      metadata: { sessionId: "browser-1", backend: "codex-browser" },
      pauseAgent: vi.fn().mockResolvedValue(undefined),
      resyncAgent: vi.fn().mockRejectedValue(new Error("resync failed")),
      onError,
    });

    const running = producer.run();
    await flush();
    events[0]({ type: "browser:takeover-requested", sessionId: "browser-1" });
    await flush();
    events[0]({ type: "browser:return-requested", sessionId: "browser-1" });
    await flush();
    expect(states).toEqual(["user-controlled", "resyncing", "user-controlled"]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "resync failed" }));

    started.resolve();
    await running;
  });
});
