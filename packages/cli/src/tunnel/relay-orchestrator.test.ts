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

  it("closes failed Cloudflare and selects Pinggy", async () => {
    const cloudflare = fakeProvider("https://bad.trycloudflare.com");
    const pinggy = fakeProvider("https://good.run.pinggy-free.link");
    const readiness = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("HTTP 530");
    });
    const result = await selectRelay(options("auto", { cloudflare, pinggy }, readiness));
    expect(cloudflare.handle.close).toHaveBeenCalledOnce();
    expect(result.provider).toBe("pinggy");
    expect(result.failures).toEqual([{ provider: "cloudflare", message: "HTTP 530" }]);
  });

  it("falls back to LAN when both public providers fail", async () => {
    const cloudflare = fakeProvider("https://bad.trycloudflare.com");
    const pinggy = fakeProvider("https://bad.run.pinggy-free.link");
    const result = await selectRelay(options("auto", { cloudflare, pinggy }, async () => { throw new Error("blocked"); }));
    expect(result.provider).toBe("lan");
    expect(result.publicUrl).toBe("http://10.0.0.2:43210");
    expect(result.failures).toHaveLength(2);
  });

  it("fails instead of leaving a background service permanently on LAN", async () => {
    const cloudflare = fakeProvider("https://bad.trycloudflare.com");
    const pinggy = fakeProvider("https://bad.run.pinggy-free.link");

    await expect(
      selectRelay({
        ...options("auto", { cloudflare, pinggy }, async () => { throw new Error("blocked"); }),
        allowLanFallback: false,
      }),
    ).rejects.toThrow("public relay unavailable (cloudflare: blocked; pinggy: blocked)");
    expect(cloudflare.handle.close).toHaveBeenCalledOnce();
    expect(pinggy.handle.close).toHaveBeenCalledOnce();
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
    start: vi.fn(async () => handle),
  };
  return { provider, handle };
}
