import { describe, expect, it, vi } from "vitest";
import { SinglePageHistoryPrefetch } from "./session-history-prefetch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("SinglePageHistoryPrefetch", () => {
  it("cancels obsolete downloads while retaining the current page prefetch", async () => {
    const cache = new SinglePageHistoryPrefetch<string>();
    const signals: AbortSignal[] = [];
    const loader = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      return "page";
    });
    await cache.prefetch("previous", "page-1", loader);
    await cache.prefetch("current", "page-2", loader);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await expect(cache.consume("current", "page-2", loader)).resolves.toBe("page");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending prefetch when its conversation is left", () => {
    const cache = new SinglePageHistoryPrefetch<string>();
    let requestSignal: AbortSignal | undefined;
    void cache.prefetch("previous", "page-1", signal => {
      requestSignal = signal;
      return new Promise<string>(() => {});
    });
    cache.invalidate();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("shares an in-flight prefetch with foreground consumption", async () => {
    const pending = deferred<string>();
    const loader = vi.fn(() => pending.promise);
    const cache = new SinglePageHistoryPrefetch<string>();

    void cache.prefetch("session-1", "cursor-1", loader);
    const consumed = cache.consume("session-1", "cursor-1", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve("page-1");
    await expect(consumed).resolves.toBe("page-1");
  });

  it("reuses a resolved prefetched page until it is consumed", async () => {
    const loader = vi.fn(async () => "page-1");
    const cache = new SinglePageHistoryPrefetch<string>();

    await expect(cache.prefetch("session-1", "cursor-1", loader)).resolves.toBe("page-1");
    await expect(cache.consume("session-1", "cursor-1", loader)).resolves.toBe("page-1");

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("starts a foreground request when no page is prefetched", async () => {
    const loader = vi.fn(async () => "page-1");
    const cache = new SinglePageHistoryPrefetch<string>();

    await expect(cache.consume("session-1", "cursor-1", loader)).resolves.toBe("page-1");

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps only the newest session and cursor slot", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstLoader = vi.fn(() => first.promise);
    const secondLoader = vi.fn(() => second.promise);
    const fallbackLoader = vi.fn(async () => "unexpected");
    const cache = new SinglePageHistoryPrefetch<string>();

    void cache.prefetch("session-1", "cursor-1", firstLoader);
    void cache.prefetch("session-2", "cursor-2", secondLoader);
    first.resolve("stale-page");
    await first.promise;

    const consumed = cache.consume("session-2", "cursor-2", fallbackLoader);
    second.resolve("current-page");

    await expect(consumed).resolves.toBe("current-page");
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(fallbackLoader).not.toHaveBeenCalled();
  });

  it("does not reuse an invalidated in-flight slot", async () => {
    const stale = deferred<string>();
    const staleLoader = vi.fn(() => stale.promise);
    const currentLoader = vi.fn(async () => "current-page");
    const cache = new SinglePageHistoryPrefetch<string>();

    void cache.prefetch("session-1", "cursor-1", staleLoader);
    cache.invalidate();

    await expect(cache.consume("session-1", "cursor-1", currentLoader)).resolves.toBe("current-page");
    expect(staleLoader).toHaveBeenCalledTimes(1);
    expect(currentLoader).toHaveBeenCalledTimes(1);
    stale.resolve("stale-page");
    await stale.promise;
  });

  it("allows a new request after the prefetched request rejects", async () => {
    const failedLoader = vi.fn(async () => { throw new Error("offline"); });
    const retryLoader = vi.fn(async () => "recovered-page");
    const cache = new SinglePageHistoryPrefetch<string>();

    await expect(cache.prefetch("session-1", "cursor-1", failedLoader)).rejects.toThrow("offline");
    await expect(cache.consume("session-1", "cursor-1", retryLoader)).resolves.toBe("recovered-page");

    expect(failedLoader).toHaveBeenCalledTimes(1);
    expect(retryLoader).toHaveBeenCalledTimes(1);
  });
});
