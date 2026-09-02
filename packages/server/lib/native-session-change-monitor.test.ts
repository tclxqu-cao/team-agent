import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeSessionChangeMonitor,
  type SessionFileWatcher,
} from "./native-session-change-monitor";

class FakeWatcher implements SessionFileWatcher {
  readonly listeners = new Map<string, Set<() => void>>();
  readonly close = vi.fn(async () => undefined);

  on(event: "add" | "change", listener: () => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: "add" | "change"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeSessionChangeMonitor", () => {
  it("reuses one watcher and debounces write bursts for all subscribers", async () => {
    vi.useFakeTimers();
    const watchers: FakeWatcher[] = [];
    const monitor = new NativeSessionChangeMonitor(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    }, 100);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = monitor.subscribe("session-1", "/tmp/session.jsonl", first);
    const unsubscribeSecond = monitor.subscribe("session-1", "/tmp/session.jsonl", second);
    watchers[0].emit("change");
    watchers[0].emit("change");
    await vi.advanceTimersByTimeAsync(100);

    expect(watchers).toHaveLength(1);
    expect(first).toHaveBeenCalledWith({ type: "session_history_changed", revision: 1 });
    expect(second).toHaveBeenCalledWith({ type: "session_history_changed", revision: 1 });

    unsubscribeFirst();
    expect(watchers[0].close).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
  });

  it("cancels pending notifications when the last subscriber leaves", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    const monitor = new NativeSessionChangeMonitor(() => watcher, 100);
    const subscriber = vi.fn();

    const unsubscribe = monitor.subscribe("session-1", "/tmp/session.jsonl", subscriber);
    watcher.emit("change");
    unsubscribe();
    await vi.advanceTimersByTimeAsync(100);

    expect(subscriber).not.toHaveBeenCalled();
  });
});
