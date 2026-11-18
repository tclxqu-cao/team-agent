interface PoolOptions {
  createEventSource(url: string): EventSource;
  maxConnections?: number;
  leaseMs?: number;
  yieldMs?: number;
  timers?: Pick<Window, "setTimeout" | "clearTimeout">;
}

interface NativeSnapshot {
  snapshotRunId?: unknown;
  snapshotRevision?: unknown;
}

/** Pin the first native subscription's future-only boundary before it can wait or rotate. */
export async function prepareNativeRunStreamUrl(
  path: string,
  readSnapshot: (sessionId: string) => Promise<NativeSnapshot>,
): Promise<string> {
  const url = new URL(path, "http://event-source.local");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId?.startsWith("runtime:") || url.searchParams.has("afterSequence")) return path;
  const snapshot = await readSnapshot(sessionId);
  if (!Number.isSafeInteger(snapshot.snapshotRevision) || Number(snapshot.snapshotRevision) < 0) {
    throw new Error("无法确定运行事件的恢复位置，请重试");
  }
  url.searchParams.set("afterSequence", String(snapshot.snapshotRevision));
  if (typeof snapshot.snapshotRunId === "string" && snapshot.snapshotRunId) {
    url.searchParams.set("afterRunId", snapshot.snapshotRunId);
  }
  return path.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

/** Keep HTTP/1 request slots free while every logical run retains its own cursor and handlers. */
export class BoundedEventSourcePool {
  private readonly active = new Set<BoundedEventSource>();
  private readonly queue: BoundedEventSource[] = [];
  private readonly maxConnections: number;
  private readonly leaseMs: number;
  private readonly yieldMs: number;
  private readonly timers: Pick<Window, "setTimeout" | "clearTimeout">;
  private pumpTimer: number | undefined;

  constructor(private readonly options: PoolOptions) {
    this.maxConnections = Math.max(1, Math.floor(options.maxConnections ?? 3));
    this.leaseMs = Math.max(1, options.leaseMs ?? 1_000);
    this.yieldMs = Math.max(1, options.yieldMs ?? 25);
    this.timers = options.timers ?? globalThis as unknown as Window;
  }

  open(url: string, prepareUrl?: () => Promise<string>): EventSource {
    const source = new BoundedEventSource(this, url);
    void Promise.resolve().then(async () => {
      if (source.closed) return;
      try {
        source.resumeUrl = prepareUrl ? await prepareUrl() : url;
        if (!source.closed) this.enqueue(source);
      } catch {
        source.fail();
      }
    });
    return source as unknown as EventSource;
  }

  private enqueue(source: BoundedEventSource): void {
    if (source.closed || this.queue.includes(source) || this.active.has(source)) return;
    this.queue.push(source);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpTimer !== undefined || !this.queue.length) return;
    this.pumpTimer = this.timers.setTimeout(() => {
      this.pumpTimer = undefined;
      while (this.active.size < this.maxConnections && this.queue.length) {
        const source = this.queue.shift()!;
        if (source.closed) continue;
        this.active.add(source);
        source.connect(this.options.createEventSource);
        if (this.active.has(source)) this.scheduleLease(source);
      }
    }, this.yieldMs);
  }

  private scheduleLease(source: BoundedEventSource): void {
    source.leaseTimer = this.timers.setTimeout(() => {
      source.leaseTimer = undefined;
      if (!this.active.has(source) || source.closed) return;
      // A future-only CA subscription has no readable server baseline. Keep
      // its first connection until an event supplies a real id; never invent 0.
      if (this.queue.length && source.resumable) {
        this.release(source);
        this.enqueue(source);
      } else this.scheduleLease(source);
    }, this.leaseMs);
  }

  release(source: BoundedEventSource): void {
    if (source.leaseTimer !== undefined) this.timers.clearTimeout(source.leaseTimer);
    source.leaseTimer = undefined;
    this.active.delete(source);
    const queued = this.queue.indexOf(source);
    if (queued !== -1) this.queue.splice(queued, 1);
    source.disconnect();
    this.schedulePump();
    if (!this.active.size && !this.queue.length && this.pumpTimer !== undefined) {
      this.timers.clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }
}

class BoundedEventSource extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  readyState = 0;
  closed = false;
  resumeUrl: string;
  leaseTimer: number | undefined;
  private physical: EventSource | null = null;
  private generation = 0;
  private readonly retiredRuns = new Set<string>();

  constructor(private readonly pool: BoundedEventSourcePool, readonly url: string) {
    super();
    this.resumeUrl = url;
  }

  get resumable(): boolean {
    const query = new URL(this.resumeUrl, "http://event-source.local").searchParams;
    return query.has("afterSequence") || query.has("afterEventId");
  }

  connect(create: (url: string) => EventSource): void {
    if (this.closed) return;
    const generation = ++this.generation;
    let physical: EventSource;
    try { physical = create(this.resumeUrl); }
    catch { this.fail(); return; }
    this.physical = physical;
    const current = () => !this.closed && generation === this.generation && this.physical === physical;
    physical.onopen = () => {
      if (!current()) return;
      this.readyState = this.OPEN;
      this.onopen?.call(this as unknown as EventSource, new Event("open"));
      if (current()) this.dispatchEvent(new Event("open"));
    };
    physical.onmessage = event => {
      if (!current() || !this.rememberCursor(event.lastEventId)) return;
      this.onmessage?.call(this as unknown as EventSource, event);
      if (current()) this.dispatchEvent(new MessageEvent("message", { data: event.data, lastEventId: event.lastEventId, origin: event.origin }));
    };
    physical.onerror = event => {
      if (!current()) return;
      if (physical.readyState === this.CLOSED) {
        this.closed = true;
        this.readyState = this.CLOSED;
        this.pool.release(this);
      } else this.readyState = this.CONNECTING;
      this.onerror?.call(this as unknown as EventSource, event);
      this.dispatchEvent(new Event("error"));
    };
  }

  private rememberCursor(id: string): boolean {
    if (!id) return true;
    const url = new URL(this.resumeUrl, "http://event-source.local");
    if (url.searchParams.get("sessionId")?.startsWith("runtime:")) {
      const separator = id.lastIndexOf(":");
      const runId = separator > 0 ? id.slice(0, separator) : "";
      const sequence = Number(separator > 0 ? id.slice(separator + 1) : id);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || (runId && this.retiredRuns.has(runId))) return false;
      const previousRun = url.searchParams.get("afterRunId");
      const previousSequence = Number(url.searchParams.get("afterSequence"));
      if ((!runId || !previousRun || runId === previousRun) && url.searchParams.has("afterSequence") && sequence <= previousSequence) return false;
      if (runId && previousRun && runId !== previousRun) this.retiredRuns.add(previousRun);
      if (runId) url.searchParams.set("afterRunId", runId);
      url.searchParams.set("afterSequence", String(sequence));
    } else {
      const sequence = Number(id);
      if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
      if (url.searchParams.has("afterEventId") && sequence <= Number(url.searchParams.get("afterEventId"))) return false;
      url.searchParams.set("afterEventId", String(sequence));
    }
    this.resumeUrl = this.resumeUrl.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
    return true;
  }

  disconnect(): void {
    ++this.generation;
    const physical = this.physical;
    this.physical = null;
    if (physical) {
      physical.onopen = physical.onmessage = physical.onerror = null;
      physical.close();
    }
    if (!this.closed) this.readyState = this.CONNECTING;
  }

  fail(): void {
    if (this.closed) return;
    this.close();
    const event = new Event("error");
    this.onerror?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = this.CLOSED;
    this.pool.release(this);
  }
}

const SHARED_POOL_KEY = "__agentroamBoundedRunSourcesV1";
type PoolWindow = Window & typeof globalThis & { [SHARED_POOL_KEY]?: BoundedEventSourcePool };

/** Trusted same-origin app frames share one budget; a frame navigation releases its own logical streams. */
export function browserRunStreamPool(context: Window = window): BoundedEventSourcePool {
  let owner = context as PoolWindow;
  try {
    if (context.top?.location.origin === context.location.origin) owner = context.top as PoolWindow;
  } catch { /* Standalone/cross-origin embeds keep their local budget. */ }
  return owner[SHARED_POOL_KEY] ??= new BoundedEventSourcePool({
    createEventSource: url => new owner.EventSource(url),
    timers: owner,
  });
}
