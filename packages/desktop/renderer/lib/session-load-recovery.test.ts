import { describe, expect, it, vi } from "vitest";
import {
  describeSessionLoadError,
  isSessionTransportError,
  loadSessionWithRetry,
} from "./session-load-recovery";

describe("session load recovery", () => {
  it("recognizes browser transport failures but not aborts or API errors", () => {
    expect(isSessionTransportError(new TypeError("Load failed"))).toBe(true);
    expect(isSessionTransportError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isSessionTransportError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isSessionTransportError(new DOMException("cancelled", "AbortError"))).toBe(false);
    expect(isSessionTransportError(new Error("请求失败 (500)"))).toBe(false);
  });

  it("retries transient failures with bounded increasing delays", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue({ id: "fork" });
    const sleep = vi.fn(async () => undefined);

    await expect(loadSessionWithRetry(load, { sleep })).resolves.toEqual({ id: "fork" });
    expect(load).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[500], [1_000], [2_000]]);
  });

  it("stops retrying as soon as one attempt succeeds", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ id: "recovered" });
    const sleep = vi.fn(async () => undefined);

    await expect(loadSessionWithRetry(load, { sleep })).resolves.toEqual({ id: "recovered" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[500]]);
  });

  it("stops after the configured attempt limit", async () => {
    const failure = new TypeError("Load failed");
    const load = vi.fn(async () => { throw failure; });
    const sleep = vi.fn(async () => undefined);

    await expect(loadSessionWithRetry(load, { maxAttempts: 2, sleep })).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry an HTTP or domain error", async () => {
    const failure = new Error("Session not found");
    const load = vi.fn(async () => { throw failure; });
    const sleep = vi.fn(async () => undefined);

    await expect(loadSessionWithRetry(load, { sleep })).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("turns native browser text into an actionable message", () => {
    expect(describeSessionLoadError(new TypeError("Load failed")))
      .toBe("网络连接中断，会话加载失败，请重新加载");
    expect(describeSessionLoadError(new Error("Session not found")))
      .toBe("Session not found");
  });
});
