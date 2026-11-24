import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpGateway } from "../../../../shared/src/infrastructure/http/agent-http-gateway";
import { BoundedEventSourcePool } from "./bounded-event-source";

class ControlledEventSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) {}
}

describe("Web gateway observation policy", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the default SSE observation contract and releases it on unsubscribe", () => {
    const source = new ControlledEventSource("/changes");
    const create = vi.fn(() => source as unknown as EventSource);
    const gateway = new AgentHttpGateway({} as never, {} as never, undefined, create);
    const change = vi.fn();
    const error = vi.fn();
    expect(gateway.sessionHistoryObservationMode).toBe("sse");
    const stop = gateway.observeSession("runtime:codex:observed", change, error);
    expect(create).toHaveBeenCalledWith("/api/sessions/runtime%3Acodex%3Aobserved/changes");
    source.onmessage?.(new MessageEvent("message", { data: '{"type":"session_history_changed","revision":9}' }));
    expect(change).toHaveBeenCalledWith({ type: "session_history_changed", revision: 9 });
    expect(error).not.toHaveBeenCalled();
    stop();
    stop();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("exposes polling as an explicit policy without manufacturing an observation error", () => {
    const create = vi.fn();
    const gateway = new AgentHttpGateway({} as never, {} as never, undefined, create, undefined, {
      historyObservation: "polling",
    });
    expect(gateway.sessionHistoryObservationMode).toBe("polling");
    expect(create).not.toHaveBeenCalled();
  });

  it("closes a stream whose open gate times out and permits the next send to reconnect", async () => {
    vi.useFakeTimers();
    const sources: ControlledEventSource[] = [];
    const create = vi.fn((url: string) => {
      const source = new ControlledEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    const post = vi.fn(async () => ({}));
    const gateway = new AgentHttpGateway({ post } as never, {} as never, undefined, create);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent(event => events.push(event as Record<string, unknown>));
    const timedOut = gateway.run("first attempt", "ordinary");
    await vi.advanceTimersByTimeAsync(8_000);
    await timedOut;
    expect(sources[0].close).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "事件流连接超时", _sid: "ordinary" }));
    expect(post).not.toHaveBeenCalled();

    const retried = gateway.run("retry", "ordinary");
    expect(create).toHaveBeenCalledTimes(2);
    const next = sources[1];
    next.readyState = 1;
    next.onopen?.(new Event("open"));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith("/api/agent/run", { input: "retry", sessionId: "ordinary" });
    next.onmessage?.(new MessageEvent("message", { data: '{"type":"done","finalText":"completed"}' }));
    await retried;
    expect(next.close).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "done", finalText: "completed", _sid: "ordinary" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an admitted native run pending while its stream waits for a physical slot", async () => {
    vi.useFakeTimers();
    const physical: ControlledEventSource[] = [];
    const pool = new BoundedEventSourcePool({
      maxConnections: 1, leaseMs: 100, yieldMs: 1,
      createEventSource: url => {
        const source = new ControlledEventSource(url);
        physical.push(source);
        queueMicrotask(() => {
          if (source.readyState === 2) return;
          source.readyState = 1;
          source.onopen?.(new Event("open"));
        });
        return source as unknown as EventSource;
      },
    });
    const blocker = pool.open("/api/agent/stream?sessionId=runtime%3Acodex%3Aother&afterSequence=0&afterRunId=other-run");
    await vi.advanceTimersByTimeAsync(1);
    const post = vi.fn(async () => ({ runId: "target-run", snapshotRevision: 0 }));
    const gateway = new AgentHttpGateway({ post } as never, {} as never, undefined, url => pool.open(url));
    const id = "runtime:codex:queued";
    let settled = false;
    const run = gateway.run("queued on the client", id).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith("/api/agent/run", { input: "queued on the client", sessionId: id }, { timeoutMs: 8_000 });
    expect(physical).toHaveLength(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(101);
    const source = physical.find(candidate => new URL(candidate.url, "http://agent.test").searchParams.get("sessionId") === id)!;
    expect(source).toBeDefined();
    expect(settled).toBe(false);
    source.onmessage?.(new MessageEvent("message", {
      lastEventId: "target-run:1",
      data: JSON.stringify({ type: "done", finalText: "completed", _nativeRunId: "target-run", _nativeSequence: 1 }),
    }));
    await run;
    expect(settled).toBe(true);
    expect(source.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(303);
    expect(physical.filter(candidate => new URL(candidate.url, "http://agent.test").searchParams.get("sessionId") === id)).toHaveLength(1);
    blocker.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
