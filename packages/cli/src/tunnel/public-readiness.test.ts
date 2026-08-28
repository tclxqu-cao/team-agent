import { describe, expect, it, vi } from "vitest";
import { waitForPublicReadiness } from "./public-readiness.js";

describe("waitForPublicReadiness", () => {
  it("retries a transient 530 and accepts the expected auth status", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 530 }))
      .mockResolvedValueOnce(
        Response.json({ authenticated: false, needsSetup: true }, { status: 200 }),
      );

    await waitForPublicReadiness("https://example.test", {
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 100,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid HTTP 200 payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await expect(
      waitForPublicReadiness("https://example.test", { fetchImpl, intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow("invalid auth status JSON");
  });

  it("includes the last HTTP status in timeout diagnostics", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    await expect(
      waitForPublicReadiness("https://example.test", { fetchImpl, intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow("HTTP 502");
  });

  it("reuses one proxy handle across retries and closes it after success", async () => {
    const close = vi.fn(async () => {});
    const proxiedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 530 }))
      .mockResolvedValueOnce(
        Response.json({ authenticated: false, needsSetup: true }, { status: 200 }),
      );
    const proxyFetchFactory = vi.fn(() => ({ fetch: proxiedFetch, close }));

    await waitForPublicReadiness("https://example.test", {
      intervalMs: 1,
      timeoutMs: 100,
      proxyResolver: async () => "http://127.0.0.1:7897/",
      proxyFetchFactory,
    });

    expect(proxyFetchFactory).toHaveBeenCalledOnce();
    expect(proxiedFetch).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a fatal response",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 })),
      timeoutMs: 100,
      expected: "HTTP 403",
    },
    {
      name: "a timeout",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 530 })),
      timeoutMs: 2,
      expected: "HTTP 530",
    },
  ])("closes the proxy handle after $name", async ({ fetchImpl, timeoutMs, expected }) => {
    const close = vi.fn(async () => {});

    await expect(
      waitForPublicReadiness("https://example.test", {
        intervalMs: 1,
        timeoutMs,
        proxyResolver: async () => "http://127.0.0.1:7897/",
        proxyFetchFactory: () => ({ fetch: fetchImpl, close }),
      }),
    ).rejects.toThrow(expected);

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the proxy handle when readiness is aborted", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const proxiedFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new Error("request aborted");
    });

    await expect(
      waitForPublicReadiness("https://example.test", {
        signal: controller.signal,
        proxyResolver: async () => "http://127.0.0.1:7897/",
        proxyFetchFactory: () => ({ fetch: proxiedFetch, close }),
      }),
    ).rejects.toThrow("public tunnel readiness aborted");

    expect(close).toHaveBeenCalledOnce();
  });

  it("does not create a proxy handle in direct mode", async () => {
    const proxyFetchFactory = vi.fn();
    const directFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ authenticated: false, needsSetup: true }),
    );

    try {
      await waitForPublicReadiness("https://example.test", {
        proxyResolver: async () => null,
        proxyFetchFactory,
      });
    } finally {
      directFetch.mockRestore();
    }

    expect(proxyFetchFactory).not.toHaveBeenCalled();
  });

  it("skips proxy discovery when a fetch implementation is injected", async () => {
    const proxyResolver = vi.fn(async () => "http://127.0.0.1:7897/");
    const proxyFetchFactory = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ authenticated: false, needsSetup: true }),
    );

    await waitForPublicReadiness("https://example.test", {
      fetchImpl,
      proxyResolver,
      proxyFetchFactory,
    });

    expect(proxyResolver).not.toHaveBeenCalled();
    expect(proxyFetchFactory).not.toHaveBeenCalled();
  });
});
