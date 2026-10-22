import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureCodexSharing, inspectCodexSharing, CODEX_SHARING_LABEL } from "./codex-sharing.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const homeDir = await mkdtemp("/tmp/codex sharing-"); roots.push(homeDir);
  const codexHome = resolve(homeDir, "codex home");
  const socket = resolve(codexHome, "app-server-control/app-server-control.sock");
  await mkdir(resolve(codexHome, "app-server-control"), { recursive: true }); await writeFile(socket, "fixture");
  const executable = resolve(homeDir, "codex"); await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o700);
  const endpoint = `ws+unix://localhost${encodeURI(socket)}:/rpc`;
  const definition = { RunAtLoad: true, StartInterval: 15, ProgramArguments: ["/bin/bash", resolve(homeDir, ".agentroam/codex-desktop/watchdog.sh"), executable, codexHome, endpoint] };
  await mkdir(resolve(homeDir, ".agentroam/codex-desktop"), { recursive: true });
  await writeFile(resolve(homeDir, ".agentroam/codex-desktop/watchdog.sh"), "fixture");
  const canonicalSocket = await realpath(socket);
  const execute = vi.fn(async (command: string, args: string[]) => {
    if (args[0] === "getenv") return { stdout: args[1] === "CODEX_HOME" ? codexHome : args[1] === "CODEX_APP_SERVER_FORCE_CLI" ? "0" : endpoint, stderr: "" };
    if (command.includes("plutil")) return { stdout: JSON.stringify(definition), stderr: "" };
    if (command.includes("ps")) return { stdout: "10 1 /Applications/Codex.app/Contents/MacOS/Codex\n20 1 /tools/codex app-server daemon run", stderr: "" };
    if (command.includes("lsof")) return { stdout: `codex 20 user 11u unix 0xabc 0t0 ${canonicalSocket}\nCodex 10 user 14u unix 0xdef 0t0 ->0xabc`, stderr: "" };
    return { stdout: "loaded", stderr: "" };
  });
  return { homeDir, socket, endpoint, executable, definition, execute,
    context: { platform: "darwin" as const, homeDir, uid: 501,
      environment: { CODEX_HOME: codexHome, AGENT_CODEX_BIN: executable, PATH: "/bin:/usr/bin" }, execute: execute as never,
      inspect: vi.fn(async () => ({ status: "running", pid: 10, appPath: "/Applications/Codex.app", activity: { state: "unknown", reason: "shared" } }) as const),
      probe: vi.fn(async () => {}),
    } };
}
describe("persistent Codex sharing", () => {
  it("reports shared only with live RPC and Desktop's peer on the actual daemon socket", async () => {
    const f = await fixture();
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "shared", configured: true, autoStart: true, daemonReachable: true });
    expect(f.execute.mock.calls.some(([, args]) => args.includes("start") || args.includes("setenv") || args.includes("bootout"))).toBe(false);
  });
  it("keeps actual sharing visible when GUI defaults are missing", async () => {
    const f = await fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => {
      if (args[0] === "getenv") throw new Error("unset");
      return original(command, args);
    });
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "shared", configured: false });
  });
  it("does not infer sharing from configuration without a matching socket connection", async () => {
    const f = await fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => command.includes("lsof") ? { stdout: "Codex 10 user 14u unix 0xdef 0t0 ->0xother", stderr: "" } : original(command, args));
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "failed", configured: true });
  });
  it("does not report shared when the daemon RPC is unreachable", async () => {
    const f = await fixture(); f.context.probe.mockRejectedValue(new Error("offline"));
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "failed", daemonReachable: false });
  });
  it("identifies the current private backend even with valid future defaults", async () => {
    const f = await fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => command.includes("ps") ? { stdout: "10 1 Codex\n25 10 /app/codex app-server --listen stdio://", stderr: "" } : original(command, args));
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "independent", configured: true });
  });
  it("treats the old address-only launch job as missing automatic recovery", async () => {
    const f = await fixture(); f.definition.StartInterval = 0;
    await expect(inspectCodexSharing(f.context)).resolves.toMatchObject({ state: "shared", autoStart: false });
  });
  it("saves a stable periodic login job and uses argument arrays for paths containing spaces", async () => {
    const f = await fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => {
      if (command.includes("plutil") && args[args.length - 1]?.endsWith("job.json")) {
        await writeFile(args[3]!, "plist fixture"); return { stdout: "", stderr: "" };
      }
      return original(command, args);
    });
    await configureCodexSharing({ dataDir: f.homeDir }, f.context);
    const definition = JSON.parse(await readFile(resolve(f.homeDir, ".agentroam/codex-desktop/job.json"), "utf8").catch(() => "null"));
    expect(definition).toBeNull();
    const script = await readFile(resolve(f.homeDir, ".agentroam/codex-desktop/watchdog.sh"), "utf8");
    expect(script).toContain('exec "$codex_bin" app-server daemon start');
    expect(script).not.toMatch(/daemon (?:stop|restart)|kill|osascript/);
    expect(f.execute).toHaveBeenCalledWith("/bin/bash", [expect.stringContaining("/watchdog.sh"), f.executable, f.context.environment.CODEX_HOME, f.endpoint, "/bin:/usr/bin", f.homeDir], expect.objectContaining({ cwd: f.homeDir }));
    expect(f.execute.mock.calls.some(([, args]) => args.includes("-k"))).toBe(false);
    expect(await readFile(resolve(f.homeDir, "Library/LaunchAgents", `${CODEX_SHARING_LABEL}.plist`), "utf8")).toBe("plist fixture");
  });
  it("does not reload an unchanged job during repeated startup or repairs", async () => {
    const f = await fixture(); let current: unknown = null;
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => {
      if (command.includes("plutil")) {
        if (args[args.length - 1]?.endsWith("job.json")) {
          current = JSON.parse(await readFile(args[args.length - 1]!, "utf8"));
          await writeFile(args[3]!, "plist"); return { stdout: "", stderr: "" };
        }
        return { stdout: JSON.stringify(current), stderr: "" };
      }
      return original(command, args);
    });
    await configureCodexSharing({ dataDir: f.homeDir }, f.context);
    f.execute.mockClear();
    await configureCodexSharing({ dataDir: f.homeDir }, f.context);
    expect(f.execute.mock.calls.some(([, args]) => args.includes("bootout") || args.includes("bootstrap"))).toBe(false);
    expect(f.execute).toHaveBeenCalledWith("/bin/launchctl", ["enable", expect.any(String)], expect.anything());
  });
  it("does not promise system-restored Desktop will share just because login defaults exist", async () => {
    const f = await fixture();
    f.context.inspect.mockResolvedValue({ status: "stopped", appPath: "/Applications/Codex.app" } as never);
    const status = await inspectCodexSharing(f.context);
    expect(status.message).toContain("agentroam codex-desktop");
    expect(status.message).not.toContain("下次打开时使用共享后台");
  });
  it("skips unsupported platforms without writes or process calls", async () => {
    const execute = vi.fn();
    await configureCodexSharing({ dataDir: "/unused" }, { platform: "win32", execute });
    await expect(inspectCodexSharing({ platform: "win32", execute })).resolves.toMatchObject({ state: "unsupported" });
    expect(execute).not.toHaveBeenCalled();
  });
});
