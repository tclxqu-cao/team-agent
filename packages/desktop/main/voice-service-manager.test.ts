import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceServiceManager,
  findVoiceServiceEntry,
  findVoiceServiceRuntime,
  getLocalVoiceServiceLaunch,
  type ManagedVoiceProcess,
} from "./voice-service-manager";

function options(overrides: Partial<ConstructorParameters<typeof VoiceServiceManager>[0]> = {}) {
  return {
    remoteUrl: null,
    remoteToken: null,
    localUrl: "http://127.0.0.1:17863",
    localToken: null,
    serviceEntry: "/repo/packages/voice-service/dist/main.js",
    runtimeExecutable: "/opt/homebrew/bin/node",
    cwd: "/repo",
    env: {},
    ...overrides,
  };
}

describe("VoiceServiceManager", () => {
  it("uses a healthy remote service without starting localhost", async () => {
    const probe = vi.fn(async (url: string) => url === "https://voice.example.com");
    const startLocal = vi.fn();
    const manager = new VoiceServiceManager(options({ remoteUrl: "https://voice.example.com" }), { probe, startLocal });
    const provider = await manager.connect();
    expect(provider.kind).toBe("service");
    expect(provider.kind === "service" && provider.source).toBe("remote");
    expect(startLocal).not.toHaveBeenCalled();
  });

  it("falls back from remote to a managed local service", async () => {
    let localReady = false;
    const probe = vi.fn(async (url: string) => url.includes("127.0.0.1") && localReady);
    const process = { kill: vi.fn(), once: vi.fn() } as unknown as ManagedVoiceProcess;
    const startLocal = vi.fn(() => {
      localReady = true;
      return process;
    });
    const manager = new VoiceServiceManager(options({ remoteUrl: "https://offline.example.com" }), { probe, startLocal });
    const provider = await manager.connect();
    expect(provider.kind === "service" && provider.source).toBe("local");
    expect(startLocal).toHaveBeenCalledOnce();
    manager.close();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("returns native fallback when no local service entry exists", async () => {
    const manager = new VoiceServiceManager(options({ serviceEntry: null }), {
      probe: async () => false,
      startLocal: vi.fn(),
    });
    expect(await manager.connect()).toEqual({ kind: "native" });
  });
});

describe("findVoiceServiceEntry", () => {
  it("finds a development sibling build", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-entry-"));
    const desktop = join(root, "packages/desktop");
    const entry = join(root, "packages/voice-service/dist/main.js");
    mkdirSync(join(root, "packages/voice-service/dist"), { recursive: true });
    mkdirSync(desktop, { recursive: true });
    writeFileSync(entry, "");
    expect(findVoiceServiceEntry(desktop, "/Applications/App/Contents/Resources")).toBe(entry);
  });
});

describe("local voice service runtime", () => {
  it("finds a Node executable from PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-runtime-"));
    const blockedBin = join(root, "blocked-bin");
    const bin = join(root, "executable-bin");
    const blockedNode = join(blockedBin, "node");
    const node = join(bin, "node");
    mkdirSync(blockedBin, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(blockedNode, "");
    writeFileSync(node, "");
    chmodSync(node, 0o755);

    expect(findVoiceServiceRuntime({
      explicit: null,
      pathEnv: `${blockedBin}:${bin}`,
      resourcesPath: join(root, "resources"),
    })).toBe(node);
  });

  it("launches the service with Node rather than Electron run-as-node", () => {
    const launch = getLocalVoiceServiceLaunch(options());

    expect(launch.command).toBe("/opt/homebrew/bin/node");
    expect(launch.args).toEqual(["/repo/packages/voice-service/dist/main.js"]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
