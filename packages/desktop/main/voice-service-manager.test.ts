import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceServiceManager,
  findVoiceServiceEntry,
  type ManagedVoiceProcess,
} from "./voice-service-manager";

function options(overrides: Partial<ConstructorParameters<typeof VoiceServiceManager>[0]> = {}) {
  return {
    remoteUrl: null,
    remoteToken: null,
    localUrl: "http://127.0.0.1:17863",
    localToken: null,
    serviceEntry: "/repo/packages/voice-service/dist/main.js",
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
