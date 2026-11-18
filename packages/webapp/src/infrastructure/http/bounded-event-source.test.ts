import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedEventSourcePool, browserRunStreamPool, prepareNativeRunStreamUrl } from "./bounded-event-source";

class PhysicalEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: PhysicalEventSource[] = [];
  static active = 0;
  static peak = 0;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    PhysicalEventSource.instances.push(this);
    PhysicalEventSource.active++;
    PhysicalEventSource.peak = Math.max(PhysicalEventSource.peak, PhysicalEventSource.active);
    queueMicrotask(() => {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.OPEN;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    });
  }

  message(id: string, payload: Record<string, unknown> = {}): void {
    const event = new MessageEvent("message", { lastEventId: id, data: JSON.stringify(payload) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    PhysicalEventSource.active--;
  }
}

const streamUrl = (sessionId: string, cursor = "afterSequence=0&afterRunId=run-a") =>
  `/api/agent/stream?sessionId=${encodeURIComponent(sessionId)}${cursor ? `&${cursor}` : ""}`;
const paramsOf = (source: { url: string }) => new URL(source.url, "http://agent.test").searchParams;
const current = (sessionId: string) => [...PhysicalEventSource.instances].reverse().find(source =>
  source.readyState !== source.CLOSED && paramsOf(source).get("sessionId") === sessionId);

describe("bounded Web event streams", () => {
  const logical: EventSource[] = [];
  const createPool = (options: { maxConnections?: number; leaseMs?: number; yieldMs?: number } = {}) =>
    new BoundedEventSourcePool({
      createEventSource: url => new PhysicalEventSource(url) as unknown as EventSource,
      maxConnections: 3, leaseMs: 100, yieldMs: 1, ...options,
    });
  const open = (pool: BoundedEventSourcePool, url: string, prepare?: () => Promise<string>) => {
    const source = pool.open(url, prepare);
    logical.push(source);
    return source;
  };
  const flush = () => vi.advanceTimersByTimeAsync(1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", PhysicalEventSource);
    PhysicalEventSource.instances = [];
    PhysicalEventSource.active = 0;
    PhysicalEventSource.peak = 0;
  });
  afterEach(() => {
    for (const source of logical.splice(0)) source.close();
    for (const source of PhysicalEventSource.instances) source.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rotates six running sessions fairly while keeping three physical connections", async () => {
    const pool = createPool();
    const sessions = Array.from({ length: 6 }, (_, index) => `runtime:codex:task-${index}`);
    const received = sessions.map(() => vi.fn());
    const opened = sessions.map(() => vi.fn());
    sessions.forEach((id, index) => {
      const source = open(pool, streamUrl(id));
      source.onopen = opened[index];
      source.onmessage = received[index];
    });
    expect(PhysicalEventSource.instances).toHaveLength(0);
    await flush();
    expect(PhysicalEventSource.instances).toHaveLength(3);
    expect(PhysicalEventSource.active).toBe(3);
    sessions.slice(0, 3).forEach(id => current(id)!.message("run-a:1", { type: "text_chunk", text: id }));

    await vi.advanceTimersByTimeAsync(101);
    sessions.slice(3).forEach(id => current(id)!.message("run-a:1", { type: "text_chunk", text: id }));
    expect(PhysicalEventSource.peak).toBe(3);
    expect(PhysicalEventSource.active).toBe(3);
    expect(opened.every(handler => handler.mock.calls.length > 0)).toBe(true);
    received.forEach((handler, index) => {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(JSON.parse(handler.mock.calls[0][0].data).text).toBe(sessions[index]);
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(sessions.slice(0, 3).every(id => current(id))).toBe(true);
    expect(PhysicalEventSource.peak).toBe(3);
  });

  it("resumes a native baseline even if no event arrived before its first lease ended", async () => {
    const id = "runtime:codex:quiet";
    const pool = createPool({ maxConnections: 1 });
    const snapshot = vi.fn(async () => ({ snapshotRunId: "run-a", snapshotRevision: 23 }));
    const source = open(pool, streamUrl(id, ""), () => prepareNativeRunStreamUrl(streamUrl(id, ""), snapshot));
    const received = vi.fn();
    source.onmessage = received;
    await flush();
    expect(paramsOf(current(id)!).get("afterSequence")).toBe("23");
    expect(paramsOf(current(id)!).get("afterRunId")).toBe("run-a");
    open(pool, streamUrl("runtime:codex:other"));

    await vi.advanceTimersByTimeAsync(202);
    const resumed = current(id)!;
    expect(paramsOf(resumed).get("afterSequence")).toBe("23");
    expect(paramsOf(resumed).get("afterRunId")).toBe("run-a");
    resumed.message("run-a:24", { type: "text_chunk", text: "arrived during the gap" });
    expect(received).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps a new native run's sequence with its own run id", async () => {
    const id = "runtime:codex:successor";
    const pool = createPool({ maxConnections: 1 });
    const source = open(pool, streamUrl(id, "afterSequence=10&afterRunId=run-a"));
    open(pool, streamUrl("runtime:codex:competing"));
    const received = vi.fn();
    source.onmessage = received;
    await flush();
    current(id)!.message("run-b:1", { type: "text_chunk", text: "new turn" });
    await vi.advanceTimersByTimeAsync(202);
    expect(paramsOf(current(id)!).get("afterRunId")).toBe("run-b");
    expect(paramsOf(current(id)!).get("afterSequence")).toBe("1");
    current(id)!.message("run-b:1", { type: "text_chunk", text: "duplicate" });
    current(id)!.message("run-b:2", { type: "text_chunk", text: "next" });
    expect(received).toHaveBeenCalledTimes(2);
  });

  it("resumes ordinary streams by event id and suppresses replay duplicates", async () => {
    const pool = createPool({ maxConnections: 1 });
    const source = open(pool, streamUrl("ordinary", "afterEventId=5"));
    open(pool, streamUrl("runtime:codex:competing"));
    const received = vi.fn();
    source.onmessage = received;
    await flush();
    current("ordinary")!.message("6", { type: "text_chunk", text: "six" });
    await vi.advanceTimersByTimeAsync(202);
    expect(paramsOf(current("ordinary")!).get("afterEventId")).toBe("6");
    current("ordinary")!.message("6", { type: "text_chunk", text: "duplicate" });
    current("ordinary")!.message("4", { type: "text_chunk", text: "older" });
    current("ordinary")!.message("7", { type: "done" });
    expect(received).toHaveBeenCalledTimes(2);
    expect(JSON.parse(received.mock.calls[1][0].data).type).toBe("done");
  });

  it("never opens a queued stream after it has been cancelled", async () => {
    const pool = createPool({ maxConnections: 1 });
    open(pool, streamUrl("runtime:codex:first"));
    const cancelled = open(pool, streamUrl("runtime:codex:cancelled"));
    cancelled.close();
    await flush();
    await vi.advanceTimersByTimeAsync(303);
    expect(PhysicalEventSource.instances.every(source => paramsOf(source).get("sessionId") !== "runtime:codex:cancelled")).toBe(true);
    expect(cancelled.readyState).toBe(EventSource.CLOSED);
  });

  it("cancels a still-preparing native stream without consuming a physical slot", async () => {
    const pool = createPool({ maxConnections: 1 });
    let resolvePreparation!: (url: string) => void;
    const preparing = open(pool, streamUrl("runtime:codex:preparing", ""), () =>
      new Promise(resolve => { resolvePreparation = resolve; }));
    open(pool, streamUrl("runtime:codex:ready"));
    await flush();
    preparing.close();
    resolvePreparation(streamUrl("runtime:codex:preparing"));
    await flush();
    expect(current("runtime:codex:ready")).toBeDefined();
    expect(PhysicalEventSource.instances.every(source => paramsOf(source).get("sessionId") !== "runtime:codex:preparing")).toBe(true);
  });

  it("ignores messages and errors from a physical source whose lease has ended", async () => {
    const id = "runtime:codex:late";
    const pool = createPool({ maxConnections: 1 });
    const source = open(pool, streamUrl(id));
    open(pool, streamUrl("runtime:codex:competing"));
    const received = vi.fn();
    const failed = vi.fn();
    source.onmessage = received;
    source.onerror = failed;
    await flush();
    const first = current(id)!;
    const lateMessage = first.onmessage!;
    const lateError = first.onerror!;
    first.message("run-a:1", { type: "text_chunk" });
    await vi.advanceTimersByTimeAsync(202);
    const replacement = current(id)!;
    expect(replacement).not.toBe(first);
    lateMessage(new MessageEvent("message", { lastEventId: "run-a:99", data: '{"type":"text_chunk"}' }));
    lateError(new Event("error"));
    expect(received).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(replacement.readyState).toBe(EventSource.OPEN);
    await vi.advanceTimersByTimeAsync(202);
    expect(paramsOf(current(id)!).get("afterSequence")).toBe("1");
  });

  it("honors close from a terminal callback before starting the next queued stream", async () => {
    const pool = createPool({ maxConnections: 1 });
    const first = open(pool, streamUrl("runtime:codex:first"));
    const next = open(pool, streamUrl("runtime:codex:next"));
    const terminal = vi.fn((event: MessageEvent) => {
      if (JSON.parse(event.data).type === "done") first.close();
    });
    first.onmessage = terminal;
    await flush();
    current("runtime:codex:first")!.message("run-a:1", { type: "done" });
    await vi.advanceTimersByTimeAsync(1);
    expect(first.readyState).toBe(EventSource.CLOSED);
    expect(current("runtime:codex:next")).toBeDefined();
    next.close();
    await vi.advanceTimersByTimeAsync(303);
    expect(PhysicalEventSource.instances.filter(source => paramsOf(source).get("sessionId") === "runtime:codex:first")).toHaveLength(1);
    expect(PhysicalEventSource.active).toBe(0);
  });

  it("pins an ordinary pre-run stream until its first id supplies a safe cursor", async () => {
    const pool = createPool({ maxConnections: 1 });
    open(pool, streamUrl("ordinary", ""));
    open(pool, streamUrl("runtime:codex:waiting"));
    await flush();
    const first = current("ordinary")!;
    await vi.advanceTimersByTimeAsync(303);
    expect(current("ordinary")).toBe(first);
    expect(current("runtime:codex:waiting")).toBeUndefined();
    expect(PhysicalEventSource.peak).toBe(1);
    first.message("11", { type: "text_chunk" });
    await vi.advanceTimersByTimeAsync(101);
    expect(current("runtime:codex:waiting")).toBeDefined();
    await vi.advanceTimersByTimeAsync(101);
    expect(paramsOf(current("ordinary")!).get("afterEventId")).toBe("11");
  });

  it("shares one three-connection budget between sibling app frames and releases all timers", async () => {
    const location = { origin: "http://agent.test" };
    const top = {
      location,
      EventSource: PhysicalEventSource,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    const firstFrame = { top, location } as unknown as Window;
    const secondFrame = { top, location: { ...location } } as unknown as Window;
    const firstPool = browserRunStreamPool(firstFrame);
    const secondPool = browserRunStreamPool(secondFrame);
    expect(secondPool).toBe(firstPool);
    const streams = Array.from({ length: 6 }, (_, index) => open(
      index < 3 ? firstPool : secondPool,
      streamUrl(`runtime:codex:frame-task-${index}`),
    ));

    await vi.advanceTimersByTimeAsync(25);
    expect(PhysicalEventSource.active).toBe(3);
    await vi.advanceTimersByTimeAsync(1_025);
    expect(PhysicalEventSource.instances).toHaveLength(6);
    expect(PhysicalEventSource.active).toBe(3);
    expect(PhysicalEventSource.peak).toBe(3);

    streams.forEach(source => source.close());
    await vi.advanceTimersByTimeAsync(0);
    expect(PhysicalEventSource.active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("native initial stream cursor", () => {
  it("captures a native snapshot before a future-only stream can rotate", async () => {
    const id = "runtime:codex:baseline";
    const read = vi.fn(async () => ({ snapshotRunId: "run:first", snapshotRevision: 17 }));
    const url = await prepareNativeRunStreamUrl(streamUrl(id, ""), read);
    expect(read).toHaveBeenCalledWith(id);
    const params = new URL(url, "http://agent.test").searchParams;
    expect(params.get("afterRunId")).toBe("run:first");
    expect(params.get("afterSequence")).toBe("17");
  });

  it("preserves an explicit cursor without issuing a snapshot request", async () => {
    const read = vi.fn();
    const original = streamUrl("runtime:codex:retained", "afterSequence=0&afterRunId=run-known");
    expect(await prepareNativeRunStreamUrl(original, read)).toBe(original);
    expect(read).not.toHaveBeenCalled();
    const ordinary = streamUrl("ordinary", "");
    expect(await prepareNativeRunStreamUrl(ordinary, read)).toBe(ordinary);
    expect(read).not.toHaveBeenCalled();
  });
});
