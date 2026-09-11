import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeSQLiteRuntime, probeTerminalRuntime, repairNativeRuntimePermissions } from "./native-runtime.js";

describe("native runtime health", () => {
  it("detects lazy SQLite binding failures after require succeeds", () => {
    const requireRuntime = (() => class Database {
      constructor() { throw new Error("native binding unavailable"); }
    }) as unknown as NodeRequire;
    expect(() => probeSQLiteRuntime(requireRuntime)).toThrow("native binding unavailable");
  });

  it("closes SQLite when its query fails", () => {
    const close = vi.fn();
    const requireRuntime = (() => class Database {
      exec() { throw new Error("database failed"); }
      close = close;
    }) as unknown as NodeRequire;
    expect(() => probeSQLiteRuntime(requireRuntime)).toThrow("database failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("detects PTY spawn failures after require succeeds", async () => {
    const requireRuntime = (() => ({ spawn() { throw new Error("spawn-helper unavailable"); } })) as unknown as NodeRequire;
    await expect(probeTerminalRuntime(requireRuntime)).rejects.toThrow("spawn-helper unavailable");
  });
});

describe("repairNativeRuntimePermissions", () => {
  it("restores the node-pty helper execute bits stripped by npm pack", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-native-"));
    const helper = resolve(root, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    await mkdir(resolve(helper, ".."), { recursive: true });
    await writeFile(helper, "helper", { mode: 0o644 });

    await repairNativeRuntimePermissions(root, "darwin", "arm64");

    expect((await stat(helper)).mode & 0o111).toBe(0o111);
  });

  it("fails before gateway startup when the helper is missing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-native-missing-"));
    await expect(repairNativeRuntimePermissions(root, "darwin", "arm64")).rejects.toThrow("spawn-helper missing");
  });
});
