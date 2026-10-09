import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { runCodexDesktopCommand } from "./codex-desktop-command.js";
import type { ServiceConfig } from "./service/service-files.js";

const directories: string[] = [];
const socketServers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(socketServers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const service = { dataDir: "/tmp/agentroam", codexPath: "/managed/codex", codexHome: "/custom/codex" } as ServiceConfig;

describe("packaged official Desktop command", () => {
  it("uses the installed service runtime/home for a read-only dry run", async () => {
    const execute = vi.fn(async () => ({ stdout: "dry run\n", stderr: "" }));
    const codexResolver = vi.fn();
    const log = vi.fn();
    await runCodexDesktopCommand(parseArgs(["codex-desktop", "--dry-run", "--data-dir", service.dataDir]), {
      platform: "darwin", environment: {}, readConfig: async () => service,
      execute: execute as never, codexResolver, log,
    });
    expect(execute).toHaveBeenCalledWith("/bin/bash", [expect.stringContaining("/install/start-codex-desktop-shared.sh"), "--dry-run"],
      expect.objectContaining({ env: { AGENT_CODEX_BIN: service.codexPath, CODEX_HOME: service.codexHome } }));
    expect(codexResolver).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("dry run");
  });

  it("honors explicit configuration and resolves Codex before requesting an opt-in restart", async () => {
    const execute = vi.fn(async () => ({ stdout: "launch requested\n", stderr: "" }));
    const codexResolver = vi.fn(async () => ({ executable: "/explicit/codex", version: "0.162.0", source: "explicit" as const }));
    await runCodexDesktopCommand(parseArgs(["codex-desktop", "--restart", "--data-dir", service.dataDir]), {
      platform: "darwin", environment: { AGENT_CODEX_BIN: "/explicit/codex", CODEX_HOME: "/explicit/home" },
      readConfig: async () => service, execute: execute as never, codexResolver, log: () => {},
    });
    expect(codexResolver).toHaveBeenCalledWith(expect.objectContaining({
      environment: { AGENT_CODEX_BIN: "/explicit/codex", CODEX_HOME: "/explicit/home" },
    }));
    expect(execute).toHaveBeenCalledWith("/bin/bash", [expect.any(String), "--restart"], expect.objectContaining({
      env: { AGENT_CODEX_BIN: "/explicit/codex", CODEX_HOME: "/explicit/home" },
    }));
  });

  it("does not reuse configuration belonging to another AgentRoam data directory", async () => {
    const execute = vi.fn(async (_command: string, _args: string[], _options: unknown) => ({ stdout: "", stderr: "" }));
    await runCodexDesktopCommand(parseArgs(["codex-desktop", "--dry-run", "--data-dir", "/another"]), {
      platform: "darwin", environment: {}, readConfig: async () => service, execute: execute as never,
    });
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ env: {} });
  });

  it("leaves Desktop untouched if runtime resolution fails", async () => {
    const execute = vi.fn();
    await expect(runCodexDesktopCommand(parseArgs(["codex-desktop", "--restart"]), {
      platform: "darwin", environment: {}, readConfig: async () => null, execute: execute as never,
      codexResolver: async () => { throw new Error("runtime unavailable"); },
    })).rejects.toThrow("runtime unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the launcher's running-session refusal to the caller", async () => {
    await expect(runCodexDesktopCommand(parseArgs(["codex-desktop", "--dry-run"]), {
      platform: "darwin", environment: {}, readConfig: async () => null,
      execute: vi.fn(async () => { throw Object.assign(new Error("process failed"), { stderr: "Desktop still running\n" }); }) as never,
    })).rejects.toThrow("Desktop still running");
  });

  it("skips all runtime and launch operations on Windows", async () => {
    const readConfig = vi.fn();
    await expect(runCodexDesktopCommand(parseArgs(["codex-desktop"]), { platform: "win32", readConfig }))
      .rejects.toThrow("仅支持 macOS");
    expect(readConfig).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "darwin")("Desktop launcher lifecycle with isolated OS tools", () => {
  async function fixture() {
    // macOS sockaddr_un paths have a short byte limit; its TMPDIR plus the
    // daemon control filename would silently truncate the fixture socket.
    const root = await mkdtemp("/tmp/codex-cli-desktop-");
    directories.push(root);
    const binary = resolve(root, "Codex.app/Contents/MacOS/Codex");
    const archive = resolve(root, "Codex.app/Contents/Resources/app.asar");
    const controlDir = resolve(root, "app-server-control");
    const state = resolve(root, "running");
    const calls = resolve(root, "calls");
    await mkdir(resolve(binary, ".."), { recursive: true });
    await mkdir(resolve(archive, ".."), { recursive: true });
    await writeFile(archive, "CODEX_APP_SERVER_WS_URL");
    await mkdir(controlDir);
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);
    await writeFile(state, "running");
    await writeFile(calls, "");
    const tools = {
      ps: '[ -f "$TEST_STATE" ] && printf "123 %s\\n" "$TEST_BINARY"; exit 0',
      codex: 'printf "codex %s\\n" "$*" >> "$TEST_CALLS"; case "$*" in "app-server daemon version") exit "${TEST_DAEMON_EXIT:-0}";; esac',
      osascript: 'echo quit >> "$TEST_CALLS"; [ "${TEST_REFUSE_QUIT:-0}" = 1 ] || rm -f "$TEST_STATE"',
      kill: '[ -f "$TEST_STATE" ]',
      open: 'printf "open %s\\n" "$*" >> "$TEST_CALLS"',
    };
    for (const [name, body] of Object.entries(tools)) {
      await writeFile(resolve(root, name), `#!/bin/sh\n${body}\n`);
      await chmod(resolve(root, name), 0o755);
    }
    let script = await readFile(resolve(import.meta.dirname, "../install/start-codex-desktop-shared.sh"), "utf8");
    for (const [original, name] of [["/bin/ps", "ps"], ["/bin/kill", "kill"], ["/usr/bin/osascript", "osascript"], ["/usr/bin/open", "open"]]) {
      script = script.replaceAll(original!, resolve(root, name!));
    }
    script = script.replaceAll("sleep 0.25", ":");
    const scriptPath = resolve(root, "launch.sh");
    await writeFile(scriptPath, script);
    const socket = createServer();
    socketServers.push(socket);
    await new Promise<void>((done) => socket.listen(resolve(controlDir, "app-server-control.sock"), done));
    const run = (args: string[], environment: NodeJS.ProcessEnv = {}) => spawnSync("/bin/bash", [scriptPath, ...args], {
      encoding: "utf8", env: { ...process.env, CODEX_DESKTOP_APP: resolve(root, "Codex.app"),
        CODEX_HOME: root, AGENT_CODEX_BIN: resolve(root, "codex"), TEST_STATE: state, TEST_CALLS: calls, TEST_BINARY: binary, ...environment },
    });
    return { run, calls, state, archive };
  }

  it("preserves a running Desktop by default and performs no daemon action", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still running");
    expect(await readFile(fixtureValue.calls, "utf8")).toBe("");
    expect(await readFile(fixtureValue.state, "utf8")).toBe("running");
  });

  it("keeps a restart dry run completely read-only", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("all its running sessions would be interrupted");
    expect(await readFile(fixtureValue.calls, "utf8")).toBe("");
  });

  it("validates daemon readiness before the explicitly requested quit and launch", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart"]);
    expect(result.status).toBe(0);
    const calls = (await readFile(fixtureValue.calls, "utf8")).trim().split("\n");
    expect(calls.slice(0, 3)).toEqual(["codex app-server daemon start", "codex app-server daemon version", "quit"]);
    expect(calls[3]).toContain("CODEX_APP_SERVER_WS_URL=ws+unix://localhost");
    expect(calls[3]).toContain("CODEX_APP_SERVER_FORCE_CLI=0");
  });

  it("does not quit Desktop after a failed daemon preflight", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart"], { TEST_DAEMON_EXIT: "2" });
    expect(result.status).toBe(2);
    expect(await readFile(fixtureValue.calls, "utf8")).not.toContain("quit");
  });

  it("refuses to quit a Desktop different from the inspected PID", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart"], { AGENTROAM_CODEX_DESKTOP_EXPECTED_PID: "124" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("process changed");
    expect(await readFile(fixtureValue.calls, "utf8")).toBe("");
  });

  it("rechecks idle after daemon preflight and preserves Desktop if a new task appears", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart"], { AGENTROAM_CODEX_DESKTOP_EXPECTED_PID: "123",
      AGENTROAM_CODEX_DESKTOP_GUARD_NODE: "/usr/bin/false", AGENTROAM_CODEX_DESKTOP_IDLE_GUARD: "/unused/guard.js" });
    expect(result.status).toBe(1);
    const calls = await readFile(fixtureValue.calls, "utf8");
    expect(calls).toContain("codex app-server daemon version");
    expect(calls).not.toContain("quit");
    expect(calls).not.toContain("open ");
  });

  it.each(["missing marker", "missing archive"])("attempts Desktop connection after %s instead of declaring an old version unsupported", async (condition) => {
    const fixtureValue = await fixture();
    if (condition === "missing marker") await writeFile(fixtureValue.archive, "older app");
    else await rm(fixtureValue.archive);
    const result = fixtureValue.run(["--restart"]);
    expect(result.status).toBe(0);
    const calls = await readFile(fixtureValue.calls, "utf8");
    expect(calls).toContain("quit");
    expect(calls).toContain("CODEX_APP_SERVER_WS_URL=ws+unix://localhost");
    expect(calls).toContain("open ");
  });

  it("never forces a kill or launches a second instance when Desktop refuses to quit", async () => {
    const fixtureValue = await fixture();
    const result = fixtureValue.run(["--restart"], { TEST_REFUSE_QUIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no forced kill or second launch");
    expect(await readFile(fixtureValue.calls, "utf8")).not.toContain("open ");
    expect(await readFile(fixtureValue.state, "utf8")).toBe("running");
  });
});
