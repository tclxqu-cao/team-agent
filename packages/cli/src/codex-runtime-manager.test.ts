import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_INSTALL_STALE_LOCK_MS,
  CODEX_INSTALL_TIMEOUT_MS,
  CODEX_MINIMUM_VERSION,
  isCodexVersionAtLeast,
  managedCodexBinaryCandidates,
  parseCodexVersion,
  resolveCodexRuntime,
  resolveNpmExecutor,
} from "./codex-runtime-manager.js";

const TEST_CODEX_VERSION = "1.2.3";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Codex runtime", () => {
  it("does not start npm when only installed components are allowed", async () => {
    const root = await temporaryRoot();
    const run = vi.fn();
    await expect(resolveCodexRuntime({
      dataDir: root, target: "darwin-arm64", platform: "darwin", environment: { PATH: "" },
      installIfMissing: false, dependencies: { run },
    })).rejects.toThrow("run agentroam doctor");
    expect(run).not.toHaveBeenCalled();
  });

  it("parses the official version output", () => {
    expect(parseCodexVersion("codex-cli 0.153.5")).toBe("0.153.5");
    expect(parseCodexVersion("codex-cli next")).toBeNull();
  });

  it("compares versions numerically instead of lexicographically", () => {
    expect(isCodexVersionAtLeast("0.140.12", "0.140.3")).toBe(true);
    expect(isCodexVersionAtLeast("0.140.3", "0.140.12")).toBe(false);
    expect(isCodexVersionAtLeast(CODEX_MINIMUM_VERSION, CODEX_MINIMUM_VERSION)).toBe(true);
    expect(isCodexVersionAtLeast("0.139.9", CODEX_MINIMUM_VERSION)).toBe(false);
    expect(isCodexVersionAtLeast("0.152.0", "0.140.0")).toBe(true);
    expect(isCodexVersionAtLeast("1.0.0", "0.140.0")).toBe(true);
  });

  it("uses a compatible explicit absolute executable first", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(resolve(root, "codex"));
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "--version" ? `codex-cli ${TEST_CODEX_VERSION}\n` : "app-server help\n",
      stderr: "",
    }));

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { AGENT_CODEX_BIN: executable, PATH: "" },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({
      executable,
      version: TEST_CODEX_VERSION,
      source: "explicit",
    });
    expect(run.mock.calls.map((call) => call[1])).toEqual([["--version"], ["app-server", "--help"]]);
  });

  it("accepts explicit executables at or above the minimum stable version", async () => {
    const outputs = [
      `codex-cli ${CODEX_MINIMUM_VERSION}\n`,
      `codex-cli ${TEST_CODEX_VERSION}\n`,
    ];
    for (const output of outputs) {
      const root = await temporaryRoot();
      const executable = await fakeExecutable(resolve(root, "codex"));
      await expect(resolveCodexRuntime({
        dataDir: resolve(root, "data"),
        target: "darwin-arm64",
        environment: { AGENT_CODEX_BIN: executable, PATH: "" },
        platform: "darwin",
        dependencies: {
          run: async (_command: string, args: string[]) => ({
            stdout: args[0] === "--version" ? output : "app-server help\n",
            stderr: "",
          }),
        },
      })).resolves.toMatchObject({ executable, source: "explicit" });
    }
  });

  it("rejects an explicit executable below the minimum instead of silently replacing it", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(resolve(root, "codex"));
    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { AGENT_CODEX_BIN: executable, PATH: "" },
      platform: "darwin",
      dependencies: {
        run: async () => ({ stdout: "codex-cli 0.152.9\n", stderr: "" }),
      },
    })).rejects.toThrow(`requires >=${CODEX_MINIMUM_VERSION}`);
  });

  it("rejects prerelease or otherwise unparseable version output", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(resolve(root, "codex"));
    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { AGENT_CODEX_BIN: executable, PATH: "" },
      platform: "darwin",
      dependencies: {
        run: async () => ({ stdout: "codex-cli 0.150.0-alpha.1\n", stderr: "" }),
      },
    })).rejects.toThrow("Unable to parse a supported stable Codex version");
  });

  it("skips an incompatible PATH executable and reuses the managed runtime", async () => {
    const root = await temporaryRoot();
    const global = await fakeExecutable(resolve(root, "bin", "codex"));
    const managedRoot = resolve(root, "data", "runtimes", "codex", TEST_CODEX_VERSION);
    const managed = await fakeExecutable(managedCodexBinaryCandidates(managedRoot, "darwin-arm64")[0]);
    const run = vi.fn(async (command: string, args: string[]) => ({
      stdout: args[0] === "--version"
        ? command === global ? "codex-cli 0.152.0\n" : `codex-cli ${TEST_CODEX_VERSION}\n`
        : "help\n",
      stderr: "",
    }));

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: resolve(root, "bin") },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({ executable: managed, version: TEST_CODEX_VERSION, source: "managed" });
    expect(run.mock.calls.some((call) => call[1].includes("install"))).toBe(false);
  });

  it("reuses a qualified PATH executable without installing", async () => {
    const root = await temporaryRoot();
    const global = await fakeExecutable(resolve(root, "bin", "codex"));
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "--version" ? `codex-cli ${TEST_CODEX_VERSION}\n` : "help\n",
      stderr: "",
    }));

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: resolve(root, "bin") },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({ executable: global, version: TEST_CODEX_VERSION, source: "global" });
    expect(run.mock.calls.map((call) => call[1])).toEqual([["--version"], ["app-server", "--help"]]);
  });

  it("reuses the newest compatible cache offline, including previous versioned installs", async () => {
    const root = await temporaryRoot();
    const parent = resolve(root, "data", "runtimes", "codex");
    const cached = new Map<string, string>();
    for (const version of [CODEX_MINIMUM_VERSION, "1.2.9", "1.2.10", "2.0.0", "2.1.0", "3.0.0-alpha.1"]) {
      const binary = await fakeExecutable(managedCodexBinaryCandidates(resolve(parent, version), "darwin-arm64")[0]);
      cached.set(binary, version);
    }
    const run = vi.fn(async (command: string, args: string[]) => {
      const version = cached.get(command);
      if (!version) throw new Error("npm unavailable offline");
      if (version === "2.0.0") throw new Error("broken cached executable");
      const actualVersion = version === "2.1.0" ? TEST_CODEX_VERSION : version;
      return { stdout: args[0] === "--version" ? `codex-cli ${actualVersion}\n` : "help\n", stderr: "" };
    });

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "" },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toMatchObject({ version: "1.2.10", source: "managed" });
    expect(run.mock.calls.every(([command]) => cached.has(command))).toBe(true);
  });

  it("preserves an existing cache at the compatibility floor without npm", async () => {
    const root = await temporaryRoot();
    const managedRoot = resolve(root, "data", "runtimes", "codex", CODEX_MINIMUM_VERSION);
    const executable = await fakeExecutable(managedCodexBinaryCandidates(managedRoot, "darwin-arm64")[0]);
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command !== executable) throw new Error("npm must not run");
      return { stdout: args[0] === "--version" ? `codex-cli ${CODEX_MINIMUM_VERSION}\n` : "help\n", stderr: "" };
    });

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "" },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({ executable, version: CODEX_MINIMUM_VERSION, source: "managed" });
  });

  it("installs the official latest package and caches its actual version", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    let installs = 0;
    const run = vi.fn(async (command: string, args: string[], timeoutMs: number) => {
      if (command === "/test/node" && args.includes("install")) {
        installs += 1;
        const prefix = args[args.indexOf("--prefix") + 1];
        await fakeExecutable(managedCodexBinaryCandidates(prefix, "darwin-arm64")[0]);
        expect(args).toContain("@openai/codex@latest");
        expect(args).toContain("--prefer-online");
        expect(args).toContain("--registry=https://registry.npmjs.org");
        expect(timeoutMs).toBe(180_000);
        return { stdout: "installed", stderr: "" };
      }
      return {
        stdout: args[0] === "--version" ? `codex-cli ${TEST_CODEX_VERSION}\n` : "help\n",
        stderr: "",
      };
    });

    const resolution = await resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "", npm_execpath: npmExecPath },
      platform: "darwin",
      nodeExecutable: "/test/node",
      dependencies: { run },
    });

    expect(installs).toBe(1);
    expect(CODEX_INSTALL_STALE_LOCK_MS).toBeGreaterThan(CODEX_INSTALL_TIMEOUT_MS);
    expect(resolution.executable).toContain(`/runtimes/codex/${TEST_CODEX_VERSION}/`);
    expect(resolution.source).toBe("managed");
  });

  it.each([
    { version: "1.2.4", target: "darwin-arm64", platform: "darwin" },
    { version: "1.3.0", target: "windows-amd64", platform: "win32" },
  ] as const)("accepts a changing latest release $version on $platform", async ({ version, target, platform }) => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("install")) {
        expect(args).toContain("@openai/codex@latest");
        const prefix = args[args.indexOf("--prefix") + 1];
        await fakeExecutable(managedCodexBinaryCandidates(prefix, target)[0]);
        return { stdout: "installed", stderr: "" };
      }
      return { stdout: args[0] === "--version" ? `codex-cli ${version}\n` : "help\n", stderr: "" };
    });
    const options = {
      dataDir: resolve(root, "data"), target, platform,
      environment: { PATH: "", npm_execpath: npmExecPath },
      dependencies: { run },
    };

    const installed = await resolveCodexRuntime(options);
    expect(installed).toEqual({
      executable: managedCodexBinaryCandidates(resolve(options.dataDir, "runtimes", "codex", version), target)[0],
      version,
      source: "managed",
    });
    await expect(resolveCodexRuntime(options)).resolves.toEqual(installed);
    expect(run.mock.calls.filter(([, args]) => args.includes("install"))).toHaveLength(1);
  });

  it("replaces invalid cached contents after validating the latest install", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    const managedRoot = resolve(root, "data", "runtimes", "codex", TEST_CODEX_VERSION);
    await mkdir(managedRoot, { recursive: true });
    await writeFile(resolve(managedRoot, "incomplete"), "interrupted install");

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "", npm_execpath: npmExecPath },
      platform: "darwin",
      dependencies: {
        run: async (_command, args) => {
          if (args.includes("install")) {
            const prefix = args[args.indexOf("--prefix") + 1];
            await fakeExecutable(managedCodexBinaryCandidates(prefix, "darwin-arm64")[0]);
          }
          return { stdout: args[0] === "--version" ? `codex-cli ${TEST_CODEX_VERSION}\n` : "help\n", stderr: "" };
        },
      },
    })).resolves.toMatchObject({ version: TEST_CODEX_VERSION, source: "managed" });
    expect(await readdir(managedRoot)).not.toContain("incomplete");
  });

  it("serializes concurrent first-start installs", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    let installs = 0;
    const run = async (command: string, args: string[]) => {
      if (command === "/test/node" && args.includes("install")) {
        installs += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        const prefix = args[args.indexOf("--prefix") + 1];
        await fakeExecutable(managedCodexBinaryCandidates(prefix, "darwin-arm64")[0]);
        return { stdout: "installed", stderr: "" };
      }
      return {
        stdout: args[0] === "--version" ? `codex-cli ${TEST_CODEX_VERSION}\n` : "help\n",
        stderr: "",
      };
    };
    const options = {
      dataDir: resolve(root, "data"),
      target: "darwin-arm64" as const,
      environment: { PATH: "", npm_execpath: npmExecPath },
      platform: "darwin" as const,
      nodeExecutable: "/test/node",
      dependencies: { run },
    };

    const [first, second] = await Promise.all([
      resolveCodexRuntime(options),
      resolveCodexRuntime(options),
    ]);

    expect(installs).toBe(1);
    expect(second.executable).toBe(first.executable);
  });

  it("cleans temporary installs and the lock after npm failure", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "", npm_execpath: npmExecPath },
      platform: "darwin",
      nodeExecutable: "/test/node",
      dependencies: {
        run: async () => { throw new Error("network unavailable"); },
      },
    })).rejects.toThrow("network unavailable");

    expect(await readdir(resolve(root, "data", "runtimes", "codex"))).toEqual([]);
  });

  it("cancels a stalled install, releases its lock and does not activate a runtime", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    const controller = new AbortController();
    let started!: () => void;
    const installing = new Promise<void>(resolve => { started = resolve; });
    const run = vi.fn(async (_command: string, _args: string[], _timeout: number, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      started();
      return new Promise<never>(() => {});
    });
    const pending = resolveCodexRuntime({
      dataDir: root, target: "darwin-arm64", platform: "darwin", nodeExecutable: "/test/node",
      environment: { PATH: "", npm_execpath: npmExecPath }, signal: controller.signal, dependencies: { run },
    });
    const rejected = expect(pending).rejects.toThrow("component deadline");
    await installing;
    controller.abort(new Error("component deadline"));
    await rejected;
    await vi.waitFor(async () => expect(await readdir(resolve(root, "runtimes", "codex"))).toEqual([]));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![1]).toContain("@openai/codex@latest");
  });

  it.each(["0.152.9", "1.2.3-alpha.1"])("rejects unsupported latest output %s without activating it", async (version) => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: "", npm_execpath: npmExecPath },
      platform: "darwin",
      dependencies: {
        run: async (_command, args) => {
          if (args.includes("install")) {
            const prefix = args[args.indexOf("--prefix") + 1];
            await fakeExecutable(managedCodexBinaryCandidates(prefix, "darwin-arm64")[0]);
          }
          return { stdout: `codex-cli ${version}\n`, stderr: "" };
        },
      },
    })).rejects.toThrow("Codex runtime validation failed after installing @openai/codex@latest");
    expect(await readdir(resolve(root, "data", "runtimes", "codex"))).toEqual([]);
  });
});

describe("Codex npm executor", () => {
  it("runs npm_execpath through the current Node executable", async () => {
    await expect(resolveNpmExecutor({
      environment: { npm_execpath: "/tools/npm-cli.js", PATH: "" },
      nodeExecutable: "/runtime/node",
      canAccess: async (path) => path === "/tools/npm-cli.js",
    })).resolves.toEqual({ command: "/runtime/node", argsPrefix: ["/tools/npm-cli.js"] });
  });

  it("finds a directly executable npm.exe on Windows PATH", async () => {
    const expected = win32.resolve("C:\\tools", "npm.exe");
    await expect(resolveNpmExecutor({
      environment: { PATH: ["C:\\missing", "C:\\tools"].join(";") },
      platform: "win32",
      canAccess: async (path) => path === expected,
    })).resolves.toEqual({ command: expected, argsPrefix: [] });
  });

  it("finds npm-cli.js beside an NVM Node without relying on PATH", async () => {
    const nodeExecutable = "/Users/test/.nvm/versions/node/v22.22.2/bin/node";
    const npmCli = "/Users/test/.nvm/versions/node/v22.22.2/lib/node_modules/npm/bin/npm-cli.js";
    await expect(resolveNpmExecutor({
      environment: { PATH: "" },
      platform: "darwin",
      nodeExecutable,
      canAccess: async (path) => path === npmCli,
    })).resolves.toEqual({ command: nodeExecutable, argsPrefix: [npmCli] });
  });

  it("finds npm-cli.js beside an nvm-windows Node without relying on PATH", async () => {
    const nodeExecutable = "C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.22.2\\node.exe";
    const npmCli = "C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.22.2\\node_modules\\npm\\bin\\npm-cli.js";
    await expect(resolveNpmExecutor({
      environment: { PATH: "" },
      platform: "win32",
      nodeExecutable,
      canAccess: async (path) => path === npmCli,
    })).resolves.toEqual({ command: nodeExecutable, argsPrefix: [npmCli] });
  });

  it("runs a standard Windows npm.cmd installation through npm-cli.js", async () => {
    const npmCmd = win32.resolve("C:\\Program Files\\nodejs", "npm.cmd");
    const npmCli = win32.resolve(
      "C:\\Program Files\\nodejs",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    await expect(resolveNpmExecutor({
      environment: { PATH: "C:\\Program Files\\nodejs" },
      platform: "win32",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      canAccess: async (path) => path === npmCmd || path === npmCli,
    })).resolves.toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: [npmCli],
    });
  });

  it("maps official macOS and Windows optional-package binaries", () => {
    expect(managedCodexBinaryCandidates("/runtime", "darwin-arm64")[0])
      .toContain("codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
    expect(managedCodexBinaryCandidates("/runtime", "windows-amd64")[0])
      .toContain("codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agentroam-codex-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

async function fakeExecutable(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "fake\n");
  await chmod(path, 0o755);
  return path;
}
