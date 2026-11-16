import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, HttpClient, RequestTimeoutError } from "./http-client";

describe("HttpClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["headers", "body"])("bounds a response stalled while reading %s", async phase => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const transport = vi.fn(async (_url, options) => {
      signal = options.signal;
      if (phase === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
    });
    const result = new HttpClient(transport as typeof fetch).get("/slow", { timeoutMs: 50 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(RequestTimeoutError);
    expect(signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up its deadline after a successful response", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    await expect(new HttpClient(transport).get("/ready")).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it("preserves a structured runtime error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "Session is already running",
      code: "SESSION_ALREADY_RUNNING",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));

    const request = new HttpClient().post("/api/agent/run", {});

    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "SESSION_ALREADY_RUNNING",
      message: "Session is already running",
    } satisfies Partial<ApiError>);
  });
});
