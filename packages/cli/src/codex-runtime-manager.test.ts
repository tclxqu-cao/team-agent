import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_RUNTIME_VERSION,
  managedCodexBinaryCandidates,
  parseCodexVersion,
  resolveCodexRuntime,
  resolveNpmExecutor,
} from "./codex-runtime-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Codex runtime", () => {
  it("parses the official version output", () => {
    expect(parseCodexVersion("codex-cli 0.153.0")).toBe("0.153.0");
    expect(parseCodexVersion("codex-cli next")).toBeNull();
  });

  it("uses a compatible explicit absolute executable first", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(resolve(root, "codex"));
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.153.0\n" : "app-server help\n",
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
      version: CODEX_RUNTIME_VERSION,
      source: "explicit",
    });
    expect(run.mock.calls.map((call) => call[1])).toEqual([["--version"], ["app-server", "--help"]]);
  });

  it("rejects an incompatible explicit executable instead of silently replacing it", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(resolve(root, "codex"));
    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { AGENT_CODEX_BIN: executable, PATH: "" },
      platform: "darwin",
      dependencies: {
        run: async () => ({ stdout: "codex-cli 0.154.0\n", stderr: "" }),
      },
    })).rejects.toThrow("requires 0.153.0");
  });

  it("skips an incompatible PATH executable and reuses the managed runtime", async () => {
    const root = await temporaryRoot();
    const global = await fakeExecutable(resolve(root, "bin", "codex"));
    const managedRoot = resolve(root, "data", "runtimes", "codex", CODEX_RUNTIME_VERSION);
    const managed = await fakeExecutable(managedCodexBinaryCandidates(managedRoot, "darwin-arm64")[0]);
    const run = vi.fn(async (command: string, args: string[]) => ({
      stdout: args[0] === "--version"
        ? command === global ? "codex-cli 0.152.0\n" : "codex-cli 0.153.0\n"
        : "help\n",
      stderr: "",
    }));

    await expect(resolveCodexRuntime({
      dataDir: resolve(root, "data"),
      target: "darwin-arm64",
      environment: { PATH: resolve(root, "bin") },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({ executable: managed, version: CODEX_RUNTIME_VERSION, source: "managed" });
    expect(run.mock.calls.some((call) => call[1].includes("install"))).toBe(false);
  });

  it("installs the locked official package into a versioned runtime directory", async () => {
    const root = await temporaryRoot();
    const npmExecPath = await fakeExecutable(resolve(root, "npm-cli.js"));
    let installs = 0;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "/test/node" && args.includes("install")) {
        installs += 1;
        const prefix = args[args.indexOf("--prefix") + 1];
        await fakeExecutable(managedCodexBinaryCandidates(prefix, "darwin-arm64")[0]);
        expect(args).toContain("@openai/codex@0.153.0");
        expect(args).toContain("--registry=https://registry.npmjs.org");
        return { stdout: "installed", stderr: "" };
      }
      return {
        stdout: args[0] === "--version" ? "codex-cli 0.153.0\n" : "help\n",
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
    expect(resolution.executable).toContain(`/runtimes/codex/${CODEX_RUNTIME_VERSION}/`);
    expect(resolution.source).toBe("managed");
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
        stdout: args[0] === "--version" ? "codex-cli 0.153.0\n" : "help\n",
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
