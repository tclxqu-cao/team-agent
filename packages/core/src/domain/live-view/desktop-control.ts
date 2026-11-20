export const PRIMARY_DESKTOP_LIVE_ID = "cli-desktop:primary";

export interface DesktopRun {
  sessionId: string;
  runId: string;
  title?: string;
}

export interface DesktopActivity {
  owner: { kind: "agent"; run: DesktopRun } | { kind: "viewer" } | null;
  queue: DesktopRun[];
}

interface AgentLease {
  id: number;
  run: DesktopRun;
  observed: boolean;
  executing: boolean;
  ended: boolean;
}

interface WaitingAction {
  run: DesktopRun;
  grant: (lease: AgentLease) => void;
  cancel: () => void;
}

export class DesktopObservationRequired extends Error {
  override readonly name = "DesktopObservationRequired";

  constructor() {
    super("Desktop control changed. Observe the desktop again before sending input.");
  }
}

export class DesktopControlCoordinator {
  private nextLease = 0;
  private agent: AgentLease | null = null;
  private viewer: Promise<() => void> | null = null;
  private grantViewer: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: WaitingAction[] = [];
  private readonly listeners = new Set<(activity: DesktopActivity) => void>();

  constructor(private readonly idleMs = 15_000) {}

  snapshot(): DesktopActivity {
    const owner = this.agent
      ? { kind: "agent" as const, run: this.agent.run }
      : this.viewer ? { kind: "viewer" as const } : null;
    const queue = new Map<string, DesktopRun>();
    for (const pending of this.queue) {
      if (pending.run.runId !== this.agent?.run.runId) queue.set(pending.run.runId, pending.run);
    }
    return { owner, queue: [...queue.values()] };
  }

  subscribe(listener: (activity: DesktopActivity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute<T>(run: DesktopRun, mutating: boolean, operation: (leaseId: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(run, signal);
    let keepLease = false;
    try {
      signal?.throwIfAborted();
      if (lease.ended) throw new DOMException("Desktop run ended", "AbortError");
      if (mutating && !lease.observed) {
        keepLease = true;
        throw new DesktopObservationRequired();
      }
      const observation = await operation(lease.id);
      signal?.throwIfAborted();
      lease.observed = true;
      keepLease = true;
      return observation;
    } finally {
      lease.executing = false;
      if (!keepLease || lease.ended) this.agent = null;
      this.advance();
    }
  }

  endRun(runId: string): void {
    for (const pending of [...this.queue]) {
      if (pending.run.runId === runId) pending.cancel();
    }
    if (this.agent?.run.runId !== runId) return;
    this.agent.ended = true;
    this.advance();
  }

  requestViewerControl(): Promise<() => void> {
    if (this.viewer) return this.viewer;
    const viewer = new Promise<() => void>((resolve) => {
      this.grantViewer = () => resolve(() => {
        if (this.viewer !== viewer) return;
        this.viewer = null;
        this.advance();
      });
    });
    this.viewer = viewer;
    this.advance();
    return viewer;
  }

  private acquire(run: DesktopRun, signal?: AbortSignal): Promise<AgentLease> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const pending: WaitingAction = {
        run,
        grant: (lease) => {
          signal?.removeEventListener("abort", pending.cancel);
          resolve(lease);
        },
        cancel: () => {
          signal?.removeEventListener("abort", pending.cancel);
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new DOMException("Desktop action cancelled", "AbortError"));
          this.notify();
        },
      };
      signal?.addEventListener("abort", pending.cancel, { once: true });
      this.queue.push(pending);
      this.advance();
    });
  }

  private advance(): void {
    if (!this.agent?.executing) {
      if (this.agent?.ended || this.viewer) this.clearLease();
      if (this.viewer) {
        this.grantViewer?.();
        this.grantViewer = null;
      } else {
        const next = this.agent
          ? this.queue.findIndex((pending) => pending.run.runId === this.agent?.run.runId)
          : this.queue.length ? 0 : -1;
        if (next >= 0) {
          if (this.idleTimer) clearTimeout(this.idleTimer);
          this.idleTimer = null;
          const [pending] = this.queue.splice(next, 1);
          this.agent ??= { id: ++this.nextLease, run: pending.run, observed: false, executing: false, ended: false };
          this.agent.executing = true;
          pending.grant(this.agent);
        } else if (this.agent && !this.idleTimer) {
          this.idleTimer = setTimeout(() => {
            this.clearLease();
            this.advance();
          }, this.idleMs);
          this.idleTimer.unref?.();
        }
      }
    }
    this.notify();
  }

  private clearLease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.agent = null;
  }

  private notify(): void {
    if (!this.listeners.size) return;
    const activity = this.snapshot();
    for (const listener of this.listeners) listener(activity);
  }
}

const sharedKey = Symbol.for("agentroam.desktop-control");

export function sharedDesktopControl(): DesktopControlCoordinator {
  const host = globalThis as typeof globalThis & { [sharedKey]?: DesktopControlCoordinator };
  return host[sharedKey] ??= new DesktopControlCoordinator();
}
