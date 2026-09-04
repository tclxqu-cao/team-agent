import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./service-controller.js";
import { resolveServicePaths, writePrivateText, type ServiceConfig } from "./service-files.js";
import {
  WindowsTaskService,
  buildRegisterTaskScript,
  quoteWindowsCommandLineArgument,
  resolveWindowsServiceHost,
} from "./windows-task-service.js";

describe("WindowsTaskService", () => {
  it("registers, stops, starts, and uninstalls a current-user task", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-windows-task-"));
    const paths = resolveServicePaths(home, resolve(home, "data"));
    const value = config(home, paths.dataDir);
    await mkdir(value.roots[0], { recursive: true });
    let installed = false;
    let running = false;
    let processRunning = false;
    let pid = 800;
    const scripts: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      expect(command).toBe("powershell.exe");
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      scripts.push(script);
      if (script.includes("Register-ScheduledTask")) installed = true;
      if (script.includes("Start-ScheduledTask")) {
        running = true;
        processRunning = true;
        pid++;
        await writePrivateText(paths.statePath, JSON.stringify({
          status: "ready", pid, version: value.version, startedAt: "x", updatedAt: "x",
          accessUrl: "https://ready.example/web",
        }));
        await writePrivateText(paths.urlPath, "https://ready.example/web\n");
      }
      if (script.includes("Stop-ScheduledTask")) {
        running = false;
        processRunning = false;
      }
      if (script.includes("Unregister-ScheduledTask")) installed = false;
      if (script.includes("Get-ScheduledTask")) {
        return { code: 0, stdout: JSON.stringify({ installed, running }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const service = new WindowsTaskService({
      homeDir: home,
      runner,
      processExists: () => processRunning,
      validateConfig: async () => undefined,
      readyTimeoutMs: 50,
      stopTimeoutMs: 50,
      pollIntervalMs: 1,
    });

    const installedResult = await service.install(value);
    expect(installedResult.state).toMatchObject({ status: "ready", pid: 801 });
    expect(installedResult.definition).toBe("AgentRoam");
    expect(await service.url()).toBe("https://ready.example/web");

    await service.stop();
    expect((await service.status()).running).toBe(false);
    await service.start();
    expect((await service.status()).running).toBe(true);

    await writePrivateText(resolve(paths.dataDir, "data/keep.txt"), "keep");
    await writePrivateText(paths.stdoutPath, "keep logs");
    const result = await service.uninstall();
    expect(result).toEqual({ removed: true, preservedDataDir: paths.dataDir });
    expect(await readFile(resolve(paths.dataDir, "data/keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("keep logs");
    expect(scripts.some((script) => script.includes("New-ScheduledTaskPrincipal") && script.includes("RunLevel Limited"))).toBe(true);
    expect(scripts.some((script) => script.includes("cmd.exe") || script.includes("ES_DISPLAY_REQUIRED"))).toBe(false);
  });

  it("builds a safely quoted task action for paths with spaces and apostrophes", () => {
    const value = config("C:\\Users\\O'Brien", "C:\\Users\\O'Brien\\.agentroam");
    const host = resolveWindowsServiceHost(value.cliPath);
    const script = buildRegisterTaskScript(value, host, "C:\\Users\\O'Brien\\config.json");

    expect(host).toBe("C:\\Agent Roam\\node_modules\\agentroam\\dist\\service\\windows-service-host.js");
    expect(script).toContain("O''Brien");
    expect(script).toContain("New-ScheduledTaskAction");
    expect(script).toContain("RestartCount 999");
    expect(quoteWindowsCommandLineArgument("C:\\path with spaces\\")).toBe('"C:\\path with spaces\\\\"');
  });
});

function config(home: string, dataDir: string): ServiceConfig {
  return {
    version: "0.2.0-preview.9",
    nodePath: "C:\\Node Runtime\\node.exe",
    cliPath: "C:\\Agent Roam\\node_modules\\agentroam\\bin\\agentroam.mjs",
    roots: [resolve(home, "workspace")],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    dataDir,
    installedAt: "2026-09-04T00:00:00.000Z",
  };
}
