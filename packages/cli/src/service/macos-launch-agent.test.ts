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
      EnvironmentVariables: {
        AGENTROAM_SERVICE: "1",
        PATH: value.environmentPath,
        AGENT_CODEX_BIN: value.codexPath,
        CODEX_HOME: value.codexHome,
      },
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
    expect(calls).toContainEqual(["launchctl", "enable", "gui/501/com.agentroam.service"]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", paths.plistPath]);
    expect(calls.findIndex((call) => call[1] === "enable"))
      .toBeLessThan(calls.findIndex((call) => call[1] === "bootstrap"));
    expect((await stat(paths.plistPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({ roots: value.roots });
  });

  it("waits for the previous launchd job and process before bootstrapping a replacement", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-reinstall-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await createConfigFiles(value);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "old plist");
    await writePrivateJson(paths.configPath, { ...value, version: "0.2.0-preview.8" });
    await writePrivateJson(paths.statePath, {
      status: "ready", pid: 700, version: "0.2.0-preview.8", startedAt: "x", updatedAt: "x",
    });
    await writePrivateText(resolve(paths.dataDir, "data/keep.txt"), "keep");
    await writePrivateText(paths.stdoutPath, "keep logs");
    let loaded = true;
    let processChecks = 0;
    const lifecycle: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      if (command === "plutil" && args[0] === "-convert") {
        await writeFile(args[3], "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
      }
      if (command === "launchctl" && args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "state = running" : "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootout") lifecycle.push("bootout");
      if (command === "launchctl" && args[0] === "enable") lifecycle.push("enable");
      if (command === "launchctl" && args[0] === "bootstrap") {
        lifecycle.push("bootstrap");
        await writePrivateJson(paths.statePath, {
          status: "ready", pid: 701, version: value.version, startedAt: "y", updatedAt: "y",
          accessUrl: "https://ready.example/web",
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const processExists = vi.fn(() => {
      processChecks++;
      if (processChecks === 1) return true;
      loaded = false;
      lifecycle.push("process-exit");
      return false;
    });

    const result = await new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      processExists,
      readyTimeoutMs: 20,
      stopTimeoutMs: 50,
      pollIntervalMs: 1,
    }).install(value);

    expect(result.state).toMatchObject({ status: "ready", pid: 701 });
    expect(lifecycle).toEqual(["bootout", "process-exit", "enable", "bootstrap"]);
    expect(processExists).toHaveBeenCalledWith(700);
    expect(await readFile(resolve(paths.dataDir, "data/keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("keep logs");
  });

  it("waits for launchd to remove a previous job when no runtime pid is available", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-reinstall-no-pid-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await createConfigFiles(value);
    let printCount = 0;
    let bootedOut = false;
    let bootstrapPrintCount = 0;
    const runner: CommandRunner = async (command, args) => {
      if (command === "plutil" && args[0] === "-convert") {
        await writeFile(args[3], "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
      }
      if (command === "launchctl" && args[0] === "print") {
        printCount++;
        const loaded = !bootedOut || printCount < 3;
        return { code: loaded ? 0 : 1, stdout: loaded ? "state = exited" : "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootout") bootedOut = true;
      if (command === "launchctl" && args[0] === "bootstrap") {
        bootstrapPrintCount = printCount;
        await writePrivateJson(paths.statePath, {
          status: "ready", pid: 701, version: value.version, startedAt: "y", updatedAt: "y",
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      readyTimeoutMs: 20,
      stopTimeoutMs: 50,
      pollIntervalMs: 1,
    }).install(value);

    expect(bootstrapPrintCount).toBeGreaterThanOrEqual(3);
  });

  it("does not bootstrap while the previous launchd job is still loaded", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-reinstall-timeout-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await createConfigFiles(value);
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args[0] ?? ""}`);
      if (command === "plutil" && args[0] === "-convert") {
        await writeFile(args[3], "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
      }
      if (command === "launchctl" && args[0] === "print") {
        return { code: 0, stdout: "state = exited", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      stopTimeoutMs: 0,
      pollIntervalMs: 1,
    }).install(value)).rejects.toThrow("did not unload after launchctl bootout");
    expect(calls).not.toContain("launchctl bootstrap");
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

  it("starts and stops an installed service while preserving registration", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-start-stop-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "plist");
    await writePrivateJson(paths.configPath, value);
    await writePrivateJson(paths.statePath, {
      status: "stopped", pid: 700, version: value.version, startedAt: "x", updatedAt: "x",
    });
    let loaded = false;
    let processRunning = false;
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl" && args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "state = running" : "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        loaded = true;
        processRunning = true;
        await writePrivateJson(paths.statePath, {
          status: "ready", pid: 701, version: value.version, startedAt: "y", updatedAt: "y",
          accessUrl: "https://ready.example/web",
        });
      }
      if (command === "launchctl" && args[0] === "bootout") {
        loaded = false;
        processRunning = false;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const launchAgent = new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      processExists: () => processRunning,
      readyTimeoutMs: 50,
      stopTimeoutMs: 50,
      pollIntervalMs: 1,
    });

    const state = await launchAgent.start();
    expect(state).toMatchObject({ status: "ready", pid: 701 });
    expect((await launchAgent.status()).definition).toBe(paths.plistPath);
    await launchAgent.stop();

    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", paths.plistPath]);
    expect(calls).toContainEqual(["launchctl", "enable", "gui/501/com.agentroam.service"]);
    expect(calls).toContainEqual(["launchctl", "bootout", "gui/501/com.agentroam.service"]);
    expect(await readFile(paths.plistPath, "utf8")).toBe("plist");
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({ version: value.version });
  });

  it("re-enables an unloaded service before restarting it", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-launch-agent-restart-disabled-"));
    const paths = resolveServicePaths(home);
    const value = config(home, paths.dataDir);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "plist");
    await writePrivateJson(paths.configPath, value);
    await writePrivateJson(paths.statePath, {
      status: "stopped", pid: 700, version: value.version, startedAt: "x", updatedAt: "x",
    });
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl" && args[0] === "print") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        await writePrivateJson(paths.statePath, {
          status: "ready", pid: 701, version: value.version, startedAt: "y", updatedAt: "y",
          accessUrl: "https://ready.example/web",
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const state = await new MacLaunchAgent({
      homeDir: home,
      uid: 501,
      runner,
      readyTimeoutMs: 50,
      pollIntervalMs: 1,
    }).restart();

    expect(state).toMatchObject({ status: "ready", pid: 701 });
    expect(calls).toContainEqual(["launchctl", "enable", "gui/501/com.agentroam.service"]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", paths.plistPath]);
    expect(calls.findIndex((call) => call[1] === "enable"))
      .toBeLessThan(calls.findIndex((call) => call[1] === "bootstrap"));
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
    environmentPath: `${resolve(home, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    codexPath: resolve(home, "bin/codex"),
    codexHome: resolve(home, ".codex"),
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
    ...(value.codexPath ? [writePrivateText(value.codexPath, "codex")] : []),
    ...value.roots.map((root) => mkdir(root, { recursive: true })),
  ]);
  await chmod(value.nodePath, 0o700);
  if (value.codexPath) await chmod(value.codexPath, 0o700);
}
