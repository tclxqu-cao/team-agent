import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../args.js";
import { TunnelController } from "./tunnel-controller.js";
import type { TunnelStatus } from "../../../server/lib/tunnel-control.mjs";
import type { TunnelHandle } from "./tunnel-provider.js";

const controllers: TunnelController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())); vi.useRealTimers(); });

function fixture(localOnly = false) {
  let end!: () => void;
  const handle: TunnelHandle = { publicUrl: "https://working.example", close: vi.fn(async () => {}), exited: new Promise(resolve => { end = () => resolve({ code: 1, signal: null }); }) };
  const start = vi.fn(async () => handle);
  const readiness = vi.fn(async () => {});
  const published: TunnelStatus[] = [];
  const lanUrl = vi.fn(async () => "http://192.168.1.10:43210");
  const cli = parseArgs(localOnly ? ["--local-only"] : []);
  const controller = new TunnelController({
    relay: { cli, target: "windows-amd64", localUrl: "http://127.0.0.1:43210", port: 43210, log: vi.fn(),
      timeoutMs: 30_000, readiness, providerFactories: { cloudflare: async () => ({ start }) } },
    lanUrl, publish: async status => { published.push(status); },
  });
  controllers.push(controller);
  return { controller, cli, handle, start, readiness, published, lanUrl, end };
}

describe("independent tunnel lifetime", () => {
  it("shares concurrent requests, checks readiness and publishes the public address", async () => {
    const f = fixture();
    let finish!: () => void;
    f.readiness.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = f.controller.connect();
    expect(f.controller.connect()).toBe(first);
    await vi.waitFor(() => expect(f.readiness).toHaveBeenCalledOnce());
    expect(f.controller.status()).toMatchObject({ phase: "connecting", mode: "lan", stage: "checking" });
    expect(f.published.some(status => status.mode === "public")).toBe(false);
    finish();
    expect(await first).toMatchObject({ phase: "ready", mode: "public", accessUrl: "https://working.example/web" });
    await f.controller.connect();
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("keeps LAN access after a readiness failure and supports manual retry", async () => {
    const f = fixture();
    f.readiness.mockRejectedValueOnce(new Error("HTTP 530"));
    expect(await f.controller.connect()).toMatchObject({ phase: "error", mode: "lan", error: expect.stringContaining("可达性检查") });
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(await f.controller.connect()).toMatchObject({ phase: "ready", mode: "public" });
    expect(f.start).toHaveBeenCalledTimes(2);
  });
  it("bounds an unresponsive connection to thirty seconds and cleans up late handles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (handle: TunnelHandle) => void;
    f.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.controller.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ phase: "error", mode: "lan", error: expect.stringContaining("超时") });
    finish(f.handle);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("falls back on tunnel exit without reconnecting automatically", async () => {
    const f = fixture();
    await f.controller.connect();
    f.lanUrl.mockResolvedValue("http://192.168.1.20:43210");
    f.end();
    await vi.waitFor(() => expect(f.controller.status()).toMatchObject({ phase: "error", accessUrl: "http://192.168.1.20:43210/web" }));
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("refreshes the fallback address when the network changes during a connection attempt", async () => {
    const f = fixture();
    f.readiness.mockImplementationOnce(async () => {
      f.lanUrl.mockResolvedValue("http://127.0.0.1:43210");
      throw new Error("network disconnected");
    });
    expect(await f.controller.connect()).toMatchObject({ phase: "error", mode: "local", accessUrl: "http://127.0.0.1:43210/web" });
    expect(f.published.at(-1)).toMatchObject({ mode: "local" });
  });
  it("can enable a local-only instance without changing its persistent startup options", async () => {
    const f = fixture(true);
    f.lanUrl.mockResolvedValue("http://127.0.0.1:43210");
    expect(await f.controller.connect(false)).toMatchObject({ phase: "idle", mode: "local" });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.controller.connect()).toMatchObject({ phase: "ready", mode: "public" });
    expect(f.cli.localOnly).toBe(true);
  });
  it("aborts pending work on service shutdown and never publishes a late public address", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.readiness.mockImplementation(() => new Promise(() => {}));
    const pending = f.controller.connect();
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.close();
    await pending;
    expect(f.handle.close).toHaveBeenCalled();
    expect(f.published.some(status => status.mode === "public")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never opens a public tunnel in the unauthenticated test mode", async () => {
    const f = fixture(true);
    f.cli.testNoPairing = true;
    // The test flag is part of the initial startup configuration.
    const controller = new TunnelController({
      relay: { cli: f.cli, target: "windows-amd64", localUrl: "http://127.0.0.1:43210", port: 43210, log: vi.fn() },
      lanUrl: f.lanUrl, publish: vi.fn(), select: vi.fn(),
    });
    controllers.push(controller);
    expect(await controller.connect()).toMatchObject({ phase: "unsupported", mode: "local", error: expect.stringContaining("测试模式") });
    expect(f.start).not.toHaveBeenCalled();
  });
});
