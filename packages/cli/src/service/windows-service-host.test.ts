import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePrivateJson, type ServiceConfig } from "./service-files.js";
import { runWindowsServiceHost } from "./windows-service-host.js";

describe("Windows service host", () => {
  it("starts the configured CLI in service mode with private log descriptors", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-windows-host-"));
    const workspace = resolve(root, "workspace with spaces");
    const configPath = resolve(root, "service/config.json");
    await mkdir(workspace, { recursive: true });
    const config: ServiceConfig = {
      version: "0.2.0-preview.9",
      nodePath: "C:\\Node Runtime\\node.exe",
      cliPath: "C:\\AgentRoam\\bin\\agentroam.mjs",
      roots: [workspace],
      port: 3010,
      relay: "cloudflare",
      tunnelCommand: null,
      localOnly: false,
      dataDir: resolve(root, "data"),
      installedAt: "2026-09-04T00:00:00.000Z",
    };
    await writePrivateJson(configPath, config);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { kill: vi.fn(() => true) });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await expect(runWindowsServiceHost(configPath, { spawnProcess: spawnProcess as never })).resolves.toBe(0);

    const calls = spawnProcess.mock.calls as unknown as Array<[string, string[], {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: Array<string | number>;
      windowsHide: boolean;
    }]>;
    const [command, args, options] = calls[0];
    expect(command).toBe(config.nodePath);
    expect(args).toEqual([
      config.cliPath, "start", "--root", workspace, "--port", "3010", "--relay", "cloudflare",
      "--data-dir", config.dataDir, "--no-qr",
    ]);
    expect(options).toMatchObject({ cwd: workspace, windowsHide: true });
    expect(options.env.AGENTROAM_SERVICE).toBe("1");
    expect(typeof options.stdio[1]).toBe("number");
    expect(typeof options.stdio[2]).toBe("number");
  });
});
