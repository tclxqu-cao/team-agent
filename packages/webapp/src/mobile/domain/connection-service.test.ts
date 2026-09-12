import { describe, expect, it } from "vitest";
import { MobileConnectionService } from "./connection-service";
import type { ConnectivityProbePort, EndpointStoragePort, NativeEnvironmentPort } from "./ports";
import { ServerEndpoint } from "./server-endpoint";

class FakeEnvironment implements NativeEnvironmentPort {
  constructor(
    private readonly native: boolean,
    private readonly launch: string | null = null,
  ) {}
  isNativeApp(): boolean {
    return this.native;
  }
  platform(): "ios" | "android" | "web" {
    return this.native ? "android" : "web";
  }
  launchServerUrl(): string | null {
    return this.launch;
  }
}

class FakeStorage implements EndpointStoragePort {
  saved: ServerEndpoint | null = null;
  load(): ServerEndpoint | null {
    return this.saved;
  }
  save(endpoint: ServerEndpoint): void {
    this.saved = endpoint;
  }
  clear(): void {
    this.saved = null;
  }
}

class FakeProbe implements ConnectivityProbePort {
  reachable = true;
  calls: string[] = [];
  async probe(endpoint: ServerEndpoint): Promise<{ ok: true; modelId: string | null } | { ok: false; reason: string }> {
    this.calls.push(endpoint.toString());
    return this.reachable ? { ok: true, modelId: "glm-4" } : { ok: false, reason: "连接超时" };
  }
}

function harness(native: boolean, launch: string | null = null) {
  const environment = new FakeEnvironment(native, launch);
  const storage = new FakeStorage();
  const probe = new FakeProbe();
  return { service: new MobileConnectionService(environment, storage, probe), storage, probe };
}

describe("MobileConnectionService", () => {
  it("keeps the browser on same-origin regardless of stored state", async () => {
    const { service } = harness(false);
    await expect(service.planStartup()).resolves.toEqual({ mode: "same-origin" });
  });

  it("prefers the launch parameter over everything in the native shell", async () => {
    const { service, probe } = harness(true, "10.0.0.5:3000/context");
    await expect(service.planStartup()).resolves.toEqual({
      mode: "ready",
      endpoint: ServerEndpoint.parse("http://10.0.0.5:3000"),
    });
    expect(probe.calls).toEqual([]);
  });

  it("reuses a reachable saved endpoint without entering setup", async () => {
    const { service, storage } = harness(true);
    storage.save(ServerEndpoint.parse("http://10.0.0.5:3000")!);
    await expect(service.planStartup()).resolves.toEqual({
      mode: "ready",
      endpoint: ServerEndpoint.parse("http://10.0.0.5:3000"),
    });
  });

  it("falls back to setup when the saved server no longer answers", async () => {
    const { service, storage } = harness(true);
    storage.save(ServerEndpoint.parse("http://10.0.0.5:3000")!);
    const probe = new FakeProbe();
    probe.reachable = false;
    const broken = new MobileConnectionService(new FakeEnvironment(true), storage, probe);
    const plan = await broken.planStartup();
    expect(plan.mode).toBe("setup");
    if (plan.mode === "setup") expect(plan.failure).toBe("连接超时");
  });

  it("asks for setup when nothing was ever configured", async () => {
    const { service } = harness(true);
    await expect(service.planStartup()).resolves.toEqual({ mode: "setup", endpoint: null });
  });

  it("connect() validates, probes and only then persists", async () => {
    const { service, storage } = harness(true);

    const invalid = await service.connect("javascript:alert(1)");
    expect(invalid).toEqual({ ok: false, reason: expect.stringContaining("地址无效") });

    const probe = new FakeProbe();
    probe.reachable = false;
    const failing = new MobileConnectionService(new FakeEnvironment(true), storage, probe);
    const unreachable = await failing.connect("10.0.0.9:3000");
    expect(unreachable).toEqual({ ok: false, reason: expect.stringContaining("无法连接") });
    expect(storage.saved).toBeNull();

    const ok = await service.connect("10.0.0.5:3000");
    expect(ok.ok).toBe(true);
    expect(storage.saved?.toString()).toBe("http://10.0.0.5:3000");
  });

  it("disconnect clears the persisted endpoint", async () => {
    const { service, storage } = harness(true);
    storage.save(ServerEndpoint.parse("http://10.0.0.5:3000")!);
    service.disconnect();
    expect(storage.saved).toBeNull();
  });
});
