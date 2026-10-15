import { describe, expect, it, vi } from "vitest";
import type { CliOptions, RelayMode } from "../args.js";
import { selectRelay } from "./relay-orchestrator.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

describe("selectRelay", () => {
  it("selects Cloudflare when it becomes ready", async () => {
    const cloudflare = fakeProvider("https://ready.trycloudflare.com");
    const result = await selectRelay(options("auto", { cloudflare }));
    expect(result.provider).toBe("cloudflare");
    expect(result.publicUrl).toContain("trycloudflare.com");
  });

  it("closes failed Cloudflare and falls back directly to LAN without starting Pinggy", async () => {
    const cloudflare = fakeProvider("https://bad.trycloudflare.com");
    const pinggy = fakeProvider("https://good.run.pinggy-free.link");
    const readiness = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("HTTP 530");
    });
    const result = await selectRelay(options("auto", { cloudflare, pinggy }, readiness));
    expect(cloudflare.handle.close).toHaveBeenCalledOnce();
    expect(result.provider).toBe("lan");
    expect(result.publicUrl).toBe("http://10.0.0.2:43210");
    expect(pinggy.provider.start).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ provider: "cloudflare", message: "HTTP 530" }]);
  });

  it("falls back to LAN when Cloudflare fails", async () => {
    const cloudflare = fakeProvider("https://bad.trycloudflare.com");
    const pinggy = fakeProvider("https://bad.run.pinggy-free.link");
    const result = await selectRelay(options("auto", { cloudflare, pinggy }, async () => { throw new Error("blocked"); }));
    expect(result.provider).toBe("lan");
    expect(result.publicUrl).toBe("http://10.0.0.2:43210");
    expect(result.failures).toEqual([{ provider: "cloudflare", message: "blocked" }]);
  });

  it.each(["auto", "cloudflare", "pinggy", "custom"] as const)("keeps %s startup available when a provider cannot be created", async (mode) => {
    const providerName = mode === "auto" ? "cloudflare" : mode;
    const result = await selectRelay({
      ...options(mode, {}),
      providerFactories: { [providerName]: async () => { throw new Error("component unavailable"); } },
    });
    expect(result.provider).toBe("lan");
    expect(result.failures).toEqual([{ provider: providerName, message: "component unavailable" }]);
  });

  it.each(["start", "readiness"])("falls back when %s never settles and releases the timed-out tunnel", async (stage) => {
    vi.useFakeTimers();
    try {
      const cloudflare = fakeProvider("https://slow.trycloudflare.com");
      let finishStart: ((handle: TunnelHandle) => void) | undefined;
      if (stage === "start") cloudflare.provider.start.mockImplementation(() => new Promise((done) => { finishStart = done; }));
      const pending = selectRelay({
        ...options("auto", { cloudflare }, stage === "readiness" ? () => new Promise(() => {}) : undefined),
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toMatchObject({ provider: "lan", publicUrl: "http://10.0.0.2:43210" });
      expect(cloudflare.provider.start.mock.calls[0]![0].signal.aborted).toBe(true);
      if (finishStart) finishStart(cloudflare.handle);
      await vi.advanceTimersByTimeAsync(0);
      expect(cloudflare.handle.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not create a tunnel after provider initialization times out", async () => {
    vi.useFakeTimers();
    try {
      const cloudflare = fakeProvider("https://late.trycloudflare.com");
      let finishFactory!: (provider: TunnelProvider) => void;
      const pending = selectRelay({
        ...options("auto", {}), timeoutMs: 25,
        providerFactories: { cloudflare: () => new Promise((done) => { finishFactory = done; }) },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect((await pending).provider).toBe("lan");
      finishFactory(cloudflare.provider);
      await vi.advanceTimersByTimeAsync(0);
      expect(cloudflare.provider.start).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("propagates user cancellation instead of reporting a successful LAN fallback", async () => {
    const controller = new AbortController();
    const cloudflare = fakeProvider("https://cancelled.trycloudflare.com");
    const reason = new Error("shutdown requested");
    await expect(selectRelay({
      ...options("auto", { cloudflare }, async () => { controller.abort(reason); }),
      signal: controller.signal,
    })).rejects.toThrow("shutdown requested");
    expect(cloudflare.handle.close).toHaveBeenCalledOnce();
  });

  it("bypasses every public provider in local-only mode", async () => {
    const cloudflare = fakeProvider("https://unused.trycloudflare.com");
    const result = await selectRelay({ ...options("auto", { cloudflare }), cli: cli("auto", true) });
    expect(result.provider).toBe("lan");
    expect(cloudflare.provider.start).not.toHaveBeenCalled();
  });
});

function options(
  relay: RelayMode,
  providers: Partial<Record<"cloudflare" | "pinggy" | "custom", ReturnType<typeof fakeProvider>>>,
  readiness: (url: string) => Promise<void> = async () => {},
) {
  return {
    cli: cli(relay),
    target: "darwin-arm64" as const,
    localUrl: "http://127.0.0.1:43210",
    lanUrl: "http://10.0.0.2:43210",
    port: 43210,
    signal: new AbortController().signal,
    log: vi.fn(),
    readiness: readiness as never,
    providerFactories: Object.fromEntries(
      Object.entries(providers).map(([name, value]) => [name, async () => value.provider]),
    ),
  };
}

function cli(relay: RelayMode, localOnly = false): CliOptions {
  return {
    command: "start",
    serviceAction: null,
    unlockServiceAction: null,
    roots: [process.cwd()],
    port: null,
    relay,
    tunnelCommand: relay === "custom" ? "relay {port}" : null,
    localOnly,
    qr: false,
    dataDir: "/tmp/agentroam-test",
  };
}

function fakeProvider(publicUrl: string) {
  const handle: TunnelHandle & { close: ReturnType<typeof vi.fn> } = {
    publicUrl,
    close: vi.fn(async () => {}),
    exited: new Promise(() => {}),
  };
  const provider: TunnelProvider & { start: ReturnType<typeof vi.fn> } = {
    start: vi.fn(async (_options: Parameters<TunnelProvider["start"]>[0]) => handle),
  };
  return { provider, handle };
}
