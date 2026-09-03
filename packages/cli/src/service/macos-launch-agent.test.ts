import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MacLaunchAgent,
  buildLaunchAgentPlist,
  buildStartArguments,
  type CommandRunner,
} from "./macos-launch-agent.js";
import { resolveServicePaths, writePrivateJson, writePrivateText, type ServiceConfig } from "./service-files.js";

describe("MacLaunchAgent", () => {
  it("builds one launchd job with separate absolute arguments", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-plist-"));
    const paths = resolveServicePaths(home, resolve(home, "data with spaces"));
    const value = config(home, paths.dataDir);

    expect(buildStartArguments(value)).toEqual([
      value.nodePath, value.cliPath, "start", "--root", value.roots[0], "--root", value.roots[1],
      "--port", "3001", "--relay", "custom", "--tunnel-command", "relay --port {port}",
      "--data-dir", paths.dataDir, "--no-qr",
    ]);
    expect(buildLaunchAgentPlist(value, paths)).toMatchObject({
      Label: "com.agentroam.service",
      WorkingDirectory: value.roots[0],
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 5,
      EnvironmentVariables: { AGENTROAM_SERVICE: "1" },
    });
  });

  it("installs, reloads, and waits for a ready service", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-install-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await createConfigFiles(value);
    const calls: string[][] = [];
    let printCount = 0;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "plutil" && args[0] === "-convert") {
        await writeFile(args[3], "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
      }
      if (command === "launchctl" && args[0] === "print") {
        printCount++;
        return { code: printCount === 1 ? 0 : 1, stdout: "state = exited", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        await writePrivateJson(paths.statePath, {
          status: "ready", pid: 777, version: value.version, startedAt: value.installedAt,
          updatedAt: value.installedAt, accessUrl: "https://ready.example/web",
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new MacLaunchAgent({ homeDir: home, uid: 501, runner, readyTimeoutMs: 10 }).install(value);

    expect(result.state).toMatchObject({ status: "ready", pid: 777 });
    expect(calls).toContainEqual(["launchctl", "bootout", "gui/501/com.agentroam.service"]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", paths.plistPath]);
    expect((await stat(paths.plistPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({ roots: value.roots });
  });

  it("reports ready URLs only while the installed job is running", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-url-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "plist");
    await writePrivateJson(paths.configPath, value);
    await writePrivateJson(paths.statePath, {
      status: "ready", pid: 777, version: value.version, startedAt: value.installedAt,
      updatedAt: value.installedAt, accessUrl: "https://ready.example/web",
    });
    await writePrivateText(paths.urlPath, "https://ready.example/web\n");
    const running: CommandRunner = async () => ({ code: 0, stdout: "state = running", stderr: "" });

    expect(await new MacLaunchAgent({ homeDir: home, uid: 501, runner: running }).url())
      .toBe("https://ready.example/web");

    await writePrivateText(paths.urlPath, "https://stale.example/web\n");
    await expect(new MacLaunchAgent({ homeDir: home, uid: 501, runner: running }).url()).rejects.toThrow("stale");
  });

  it("uninstalls service control files but preserves application data and logs", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-uninstall-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "plist");
    await writePrivateJson(paths.configPath, value);
    await writePrivateJson(paths.statePath, { status: "starting", pid: 1, version: value.version, startedAt: "x", updatedAt: "x" });
    await writePrivateText(paths.urlPath, "url\n");
    await writePrivateText(resolve(paths.dataDir, "data/keep.txt"), "keep");
    await writePrivateText(paths.stdoutPath, "keep logs");
    const calls: string[][] = [];
    let processRunning = true;
    let exitWrite: Promise<void> | null = null;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl" && args[0] === "bootout") {
        exitWrite = writePrivateJson(paths.statePath, {
          status: "stopped", pid: 1, version: value.version, startedAt: "x", updatedAt: "x",
        }).then(() => { processRunning = false; });
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const processExists = vi.fn(() => processRunning);

    const result = await new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      processExists,
      pollIntervalMs: 1,
      stopTimeoutMs: 100,
    }).uninstall();
    await exitWrite;

    expect(result).toEqual({ removed: true, preservedDataDir: paths.dataDir });
    expect(calls).toContainEqual(["launchctl", "bootout", "gui/501/com.agentroam.service"]);
    expect(processExists).toHaveBeenCalled();
    await expect(readFile(paths.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(resolve(paths.dataDir, "data/keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("keep logs");
  });

  it("rejects an npx cache entrypoint", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-npx-"));
    const value = config(home, resolve(home, ".agentroam"));
    value.cliPath = resolve(home, ".npm/_npx/hash/node_modules/agentroam/bin/agentroam.mjs");
    await expect(new MacLaunchAgent({ homeDir: home }).install(value)).rejects.toThrow("npm install -g");
  });
});

function config(home: string, dataDir: string): ServiceConfig {
  const nodePath = resolve(home, "bin/node");
  const cliPath = resolve(home, "lib/agentroam/bin/agentroam.mjs");
  const roots = [resolve(home, "workspace one"), resolve(home, "workspace-two")];
  return {
    version: "0.2.0-preview.9",
    nodePath,
    cliPath,
    roots,
    port: 3001,
    relay: "custom",
    tunnelCommand: "relay --port {port}",
    localOnly: false,
    dataDir,
    installedAt: "2026-09-03T00:00:00.000Z",
  };
}

async function createConfigFiles(value: ServiceConfig): Promise<void> {
  await Promise.all([
    writePrivateText(value.nodePath, "node"),
    writePrivateText(value.cliPath, "cli"),
    ...value.roots.map((root) => mkdir(root, { recursive: true })),
  ]);
  await chmod(value.nodePath, 0o700);
}
