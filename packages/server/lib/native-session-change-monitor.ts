import { watch, type FSWatcher } from "chokidar";

export interface NativeSessionChange {
  type: "session_history_changed";
  revision: number;
}

export interface SessionFileWatcher {
  on(event: "add" | "change", listener: () => void): SessionFileWatcher;
  close(): Promise<void>;
}

interface WatchEntry {
  watcher: SessionFileWatcher;
  subscribers: Set<(change: NativeSessionChange) => void>;
  revision: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export type WatchFactory = (path: string) => SessionFileWatcher;

const createWatcher: WatchFactory = (path) => watch(path, {
  ignoreInitial: true,
  persistent: true,
}) as FSWatcher;

export class NativeSessionChangeMonitor {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(
    private readonly watchFile: WatchFactory = createWatcher,
    private readonly debounceMs = 150,
  ) {}

  subscribe(
    sessionId: string,
    path: string,
    subscriber: (change: NativeSessionChange) => void,
  ): () => void {
    const watchKey = `${sessionId}\0${path}`;
    let entry = this.entries.get(watchKey);
    if (!entry) {
      const watcher = this.watchFile(path);
      entry = {
        watcher,
        subscribers: new Set(),
        revision: 0,
        debounceTimer: null,
      };
      watcher.on("add", () => this.schedule(entry!));
      watcher.on("change", () => this.schedule(entry!));
      this.entries.set(watchKey, entry);
    }
    entry.subscribers.add(subscriber);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.entries.get(watchKey);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size === 0) this.releaseEntry(watchKey, current);
    };
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(async ([, entry]) => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      await entry.watcher.close();
    }));
  }

  private schedule(entry: WatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      entry.revision += 1;
      const change: NativeSessionChange = {
        type: "session_history_changed",
        revision: entry.revision,
      };
      for (const subscriber of entry.subscribers) {
        try {
          subscriber(change);
        } catch {
          // A disconnected subscriber must not prevent other clients updating.
        }
      }
    }, this.debounceMs);
  }

  private releaseEntry(watchKey: string, entry: WatchEntry): void {
    if (this.entries.get(watchKey) === entry) this.entries.delete(watchKey);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    void entry.watcher.close();
  }
}

const globalWithMonitor = globalThis as typeof globalThis & {
  __nativeSessionChangeMonitor?: NativeSessionChangeMonitor;
};

export function getNativeSessionChangeMonitor(): NativeSessionChangeMonitor {
  if (!globalWithMonitor.__nativeSessionChangeMonitor) {
    globalWithMonitor.__nativeSessionChangeMonitor = new NativeSessionChangeMonitor();
  }
  return globalWithMonitor.__nativeSessionChangeMonitor;
}
