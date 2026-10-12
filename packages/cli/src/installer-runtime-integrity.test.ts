import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installRoot = resolve(import.meta.dirname, "../install");
const launcherVersion = "0.2.0-preview.40";
const runtimeVersion = "0.2.0-preview.39";
const minimumNodeVersion = "22.22.0";
const roots: string[] = [];
type Target = "darwin-arm64" | "windows-amd64";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agentroam-installer-runtime-"));
  roots.push(root);
  return root;
}

function runtimeName(target: Target): string {
  return target === "darwin-arm64" ? "agentroam-runtime-darwin-arm64" : "agentroam-runtime-win32-x64";
}

function nativeTarget(target: Target): string {
  return target === "darwin-arm64" ? "darwin-arm64" : "win32-x64";
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function createFixture(prefix: string, target: Target): Promise<string> {
  const cliRoot = resolve(prefix, "node_modules/agentroam");
  await put(resolve(cliRoot, "package.json"), JSON.stringify({
    name: "agentroam", version: launcherVersion,
    optionalDependencies: { [runtimeName(target)]: runtimeVersion },
  }));
  await put(resolve(cliRoot, "bin/agentroam.mjs"), `
import { appendFileSync } from "node:fs";
if (process.env.CLI_TEST_CALLS) appendFileSync(process.env.CLI_TEST_CALLS, process.argv[2] + "\\n");
if (process.argv[2] === "doctor") process.exit(Number(process.env.CLI_TEST_DOCTOR_EXIT || 0));
if (process.argv[2] === "version") console.log("AgentRoam ${launcherVersion}");
`);
  const packageRoot = resolve(prefix, "node_modules", runtimeName(target));
  const runtimeRoot = resolve(packageRoot, "runtime");
  await put(resolve(packageRoot, "package.json"), JSON.stringify({
    name: runtimeName(target), version: runtimeVersion,
    exports: { "./manifest.json": "./manifest.json", "./runtime": "./runtime/package.json" },
  }));
  await put(resolve(runtimeRoot, "package.json"), "{}");
  await put(resolve(runtimeRoot, "ws-server.mjs"), "export {};\n");
  await put(resolve(runtimeRoot, ".next/BUILD_ID"), "fixture-build");
  await put(resolve(runtimeRoot, "node_modules/better-sqlite3/index.js"),
    "module.exports = class Database { prepare() { return { get: () => ({ ok: 1 }) }; } close() {} };\n");
  await put(resolve(runtimeRoot, "node_modules/node-pty/index.js"), "module.exports = { spawn() {} };\n");
  const nativeFiles: Record<string, string> = {};
  for (const file of [
    `node_modules/better-sqlite3/prebuilds/${nativeTarget(target)}.node`,
    `node_modules/node-pty/prebuilds/${nativeTarget(target)}/pty.node`,
    ...(target === "darwin-arm64" ? [`node_modules/node-pty/prebuilds/${nativeTarget(target)}/spawn-helper`] : [
      "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
    ]),
  ]) {
    const content = `fixture native file: ${file}`;
    await put(resolve(runtimeRoot, file), content);
    nativeFiles[file] = createHash("sha256").update(content).digest("hex");
  }
  await put(resolve(packageRoot, "manifest.json"), JSON.stringify({
    packageVersion: runtimeVersion, target, schemaVersion: 2, minimumNodeVersion, nativeFiles,
  }));
  return packageRoot;
}

async function embeddedValidator(file: string): Promise<string> {
  const source = await readFile(resolve(installRoot, file), "utf8");
  const match = file.endsWith(".sh")
    ? source.match(/LAUNCHER_CHECK_JS='\n([\s\S]*?)\n'/)
    : source.match(/\$LauncherCheckSource = @'\n([\s\S]*?)\n'@/);
  if (!match) throw new Error(`Missing embedded runtime validator in ${file}`);
  return match[1];
}

function validate(code: string, root: string, target: Target, mode = "verify") {
  return spawnSync(process.execPath, ["-e", code, root, launcherVersion, minimumNodeVersion, target, mode], { encoding: "utf8" });
}

describe("standalone runtime validation", () => {
  it("embeds the same runtime validator in both standalone installers", async () => {
    expect(await embeddedValidator("install-agentroam.ps1")).toBe(await embeddedValidator("install-agentroam.sh"));
  });

  describe.each([
    ["install-agentroam.sh", "darwin-arm64"],
    ["install-agentroam.ps1", "windows-amd64"],
  ] as const)("%s", (file, target) => {
    it("uses the exact reused runtime version independently of the launcher version", async () => {
      const root = await temporaryRoot();
      await createFixture(root, target);
      const code = await embeddedValidator(file);
      const spec = validate(code, root, target, "spec");
      expect(spec.status).toBe(0);
      expect(spec.stdout.trim()).toBe(`${runtimeName(target)}@${runtimeVersion}`);
      expect(validate(code, root, target).status).toBe(0);
    });

    it("accepts piped JavaScript without relying on PowerShell native argument quoting", async () => {
      const root = await temporaryRoot();
      await createFixture(root, target);
      const result = spawnSync(process.execPath, ["-", root, launcherVersion, minimumNodeVersion, target, "verify"], {
        input: await embeddedValidator(file), encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("rejects a launcher whose required runtime was skipped by npm", async () => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      await rm(packageRoot, { recursive: true });
      const result = validate(await embeddedValidator(file), root, target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(runtimeName(target));
    });

    it.each(["packageVersion", "target", "schemaVersion", "minimumNodeVersion"])("rejects incompatible manifest %s", async (field) => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      const manifestPath = resolve(packageRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[field] = "incorrect";
      await writeFile(manifestPath, JSON.stringify(manifest));
      const result = validate(await embeddedValidator(file), root, target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid runtime manifest");
    });

    it("rejects native corruption even when the package and CLI versions match", async () => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      await writeFile(resolve(packageRoot, `runtime/node_modules/node-pty/prebuilds/${nativeTarget(target)}/pty.node`), "truncated download");
      const result = validate(await embeddedValidator(file), root, target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checksum mismatch");
    });

    it("rejects an incomplete server bundle", async () => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      await rm(resolve(packageRoot, "runtime/ws-server.mjs"));
      expect(validate(await embeddedValidator(file), root, target).status).toBe(1);
    });

    it("rejects a missing PTY helper even when the manifest omits its inventory entry", async () => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      const path = target === "darwin-arm64"
        ? "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
        : "node_modules/node-pty/prebuilds/win32-x64/conpty.node";
      const manifestPath = resolve(packageRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      delete manifest.nativeFiles[path];
      await rm(resolve(packageRoot, "runtime", path));
      await writeFile(manifestPath, JSON.stringify(manifest));
      const result = validate(await embeddedValidator(file), root, target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing runtime native inventory");
    });

    it("rejects native modules that cannot load", async () => {
      const root = await temporaryRoot();
      const packageRoot = await createFixture(root, target);
      await writeFile(resolve(packageRoot, "runtime/node_modules/better-sqlite3/index.js"), 'throw new Error("native binding unavailable");');
      const result = validate(await embeddedValidator(file), root, target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("native binding unavailable");
    });

    it("rejects non-exact runtime dependencies before invoking npm repair", async () => {
      const root = await temporaryRoot();
      await createFixture(root, target);
      const path = resolve(root, "node_modules/agentroam/package.json");
      const launcher = JSON.parse(await readFile(path, "utf8"));
      launcher.optionalDependencies[runtimeName(target)] = `^${runtimeVersion}`;
      await writeFile(path, JSON.stringify(launcher));
      expect(validate(await embeddedValidator(file), root, target, "spec").status).toBe(1);
    });
  });
});

function shellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  if (!match) throw new Error(`Missing installer function: ${name}`);
  return match[0];
}

async function installationScenario() {
  const root = await temporaryRoot();
  const fixture = resolve(root, "fixture");
  await createFixture(fixture, "darwin-arm64");
  const launcherParent = resolve(root, "launchers");
  const launcher = resolve(launcherParent, launcherVersion);
  const wrapperDir = resolve(root, "bin");
  const wrapper = resolve(wrapperDir, "agentroam");
  const npmCalls = resolve(root, "npm-calls.jsonl");
  const cliCalls = resolve(root, "cli-calls");
  await mkdir(launcherParent);
  await mkdir(wrapperDir);
  await writeFile(wrapper, "previous wrapper\n");
  await writeFile(npmCalls, "");
  await writeFile(cliCalls, "");
  const npm = resolve(root, "fake-npm.cjs");
  await writeFile(npm, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_TEST_CALLS, JSON.stringify(args) + "\\n");
const prefix = args[args.indexOf("--prefix") + 1];
const runtime = "agentroam-runtime-darwin-arm64";
if (args.includes(runtime + "@${runtimeVersion}")) {
  if (process.env.NPM_TEST_RUNTIME_FAILURE === "1") {
    console.error("npm error ECONNRESET: runtime download interrupted");
    process.exit(42);
  }
  fs.cpSync(path.join(process.env.NPM_TEST_FIXTURE, "node_modules", runtime), path.join(prefix, "node_modules", runtime), { recursive: true });
  if (process.env.NPM_TEST_CORRUPT_RUNTIME === "1") {
    fs.writeFileSync(path.join(prefix, "node_modules", runtime, "runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"), "corrupt native file");
  }
} else {
  fs.cpSync(path.join(process.env.NPM_TEST_FIXTURE, "node_modules/agentroam"), path.join(prefix, "node_modules/agentroam"), { recursive: true });
  if (process.env.NPM_TEST_INITIAL_RUNTIME === "1") {
    fs.cpSync(path.join(process.env.NPM_TEST_FIXTURE, "node_modules", runtime), path.join(prefix, "node_modules", runtime), { recursive: true });
  }
}
`);
  const source = await readFile(resolve(installRoot, "install-agentroam.sh"), "utf8");
  const helpers = ["stop_progress", "start_progress", "run_with_progress", "fail", "cleanup", "acquire_directory_lock"]
    .map((name) => shellFunction(source, name)).join("\n");
  const code = `set -eu\nPROGRESS_PID=""\nTEMP_ROOT=""\nPREVIOUS_LAUNCHER_ROOT=""\nOWN_NODE_LOCK=0\nOWN_LAUNCHER_LOCK=0\n${helpers}\ntrap cleanup EXIT HUP INT TERM\n${source.slice(source.indexOf("LAUNCHER_CHECK_JS="))}`;
  const run = (extra: Record<string, string> = {}) => spawnSync("/bin/sh", [], {
    input: code, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NODE_BIN: process.execPath, NPM_CLI: npm,
      NPM_REGISTRY: "https://registry.npmjs.org", PACKAGE_SPEC: `agentroam@${launcherVersion}`, EXTRA_PACKAGE_SPECS: "",
      LAUNCHER_PARENT: launcherParent, LAUNCHER_ROOT: launcher, LAUNCHER_LOCK: `${launcher}.lock`,
      AGENTROAM_VERSION: launcherVersion, MINIMUM_NODE_VERSION: minimumNodeVersion,
      WRAPPER_DIR: wrapperDir, WRAPPER_PATH: wrapper, DATA_DIR: root, SERVICE_ROOT: root,
      AGENTROAM_NO_PROGRESS: "1", AGENTROAM_INSTALL_SKIP_SERVICE: "1", AGENTROAM_INSTALL_DESKTOP: "no",
      NPM_TEST_CALLS: npmCalls, NPM_TEST_FIXTURE: fixture, CLI_TEST_CALLS: cliCalls, ...extra },
  });
  const calls = async (): Promise<string[][]> => (await readFile(npmCalls, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const expectClean = async () => expect((await readdir(launcherParent)).filter((name) => name.startsWith(".") || name.endsWith(".lock"))).toEqual([]);
  return { root, fixture, launcher, launcherParent, wrapper, cliCalls, run, calls, expectClean };
}

describe.skipIf(process.platform === "win32")("shell installer runtime recovery", () => {
  it("activates a complete fresh install without downloading the runtime twice", async () => {
    const f = await installationScenario();
    const result = f.run({ NPM_TEST_INITIAL_RUNTIME: "1" });
    expect(result.status).toBe(0);
    expect(await f.calls()).toHaveLength(1);
    expect(validate(await embeddedValidator("install-agentroam.sh"), f.launcher, "darwin-arm64").status).toBe(0);
    expect(await readFile(f.cliCalls, "utf8")).toBe("doctor\n");
    await f.expectClean();
  });

  it("explicitly installs a skipped runtime at its exact version before activating the CLI", async () => {
    const f = await installationScenario();
    const result = f.run();
    expect(result.status).toBe(0);
    const calls = await f.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`agentroam-runtime-darwin-arm64@${runtimeVersion}`);
    expect(calls[1]).toContain("--save-exact");
    expect(calls[1]).toContain("--include=optional");
    expect(validate(await embeddedValidator("install-agentroam.sh"), f.launcher, "darwin-arm64").status).toBe(0);
    expect(await readFile(f.cliCalls, "utf8")).toBe("doctor\n");
    expect(result.stdout).toContain("installed:");
    await f.expectClean();
  });

  it("preserves the previous launcher and wrapper, and exposes required npm failures", async () => {
    const f = await installationScenario();
    await createFixture(f.launcher, "darwin-arm64");
    await rm(resolve(f.launcher, "node_modules/agentroam-runtime-darwin-arm64"), { recursive: true });
    await writeFile(resolve(f.launcher, "previous-marker"), "keep this installation");
    const result = f.run({ NPM_TEST_RUNTIME_FAILURE: "1" });
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("ECONNRESET: runtime download interrupted");
    expect(await readFile(resolve(f.launcher, "previous-marker"), "utf8")).toBe("keep this installation");
    expect(await readFile(f.wrapper, "utf8")).toBe("previous wrapper\n");
    expect(await readFile(f.cliCalls, "utf8")).toBe("");
    expect(result.stdout).not.toContain("installed:");
    await f.expectClean();
  });

  it("repairs a matching-version cached launcher with corrupt native files", async () => {
    const f = await installationScenario();
    const packageRoot = await createFixture(f.launcher, "darwin-arm64");
    await writeFile(resolve(packageRoot, "runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"), "corrupt cache");
    expect(f.run().status).toBe(0);
    expect(await f.calls()).toHaveLength(2);
    expect(validate(await embeddedValidator("install-agentroam.sh"), f.launcher, "darwin-arm64").status).toBe(0);
    await f.expectClean();
  });

  it("reuses a healthy cached launcher without downloading packages", async () => {
    const f = await installationScenario();
    await cp(resolve(f.fixture, "node_modules"), resolve(f.launcher, "node_modules"), { recursive: true });
    expect(f.run().status).toBe(0);
    expect(await f.calls()).toHaveLength(0);
    await f.expectClean();
  });

  it("rejects npm success when the staged runtime remains corrupt", async () => {
    const f = await installationScenario();
    const result = f.run({ NPM_TEST_CORRUPT_RUNTIME: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(await readFile(f.wrapper, "utf8")).toBe("previous wrapper\n");
    expect(await readFile(f.cliCalls, "utf8")).toBe("");
    expect(await readdir(f.launcherParent)).toEqual([]);
  });

  it("restores the previous launcher if the staged activation rename fails", async () => {
    const f = await installationScenario();
    await createFixture(f.launcher, "darwin-arm64");
    await rm(resolve(f.launcher, "node_modules/agentroam-runtime-darwin-arm64"), { recursive: true });
    await writeFile(resolve(f.launcher, "previous-marker"), "previous installation");
    const fakeBin = resolve(f.root, "fake-bin");
    const mv = resolve(fakeBin, "mv");
    await put(mv, '#!/bin/sh\ncase "$1" in *"/.launcher-"*) printf "activation rename failed\\n" >&2; exit 71 ;; esac\nexec /bin/mv "$@"\n');
    await chmod(mv, 0o755);
    const result = f.run({ PATH: `${fakeBin}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not activate AgentRoam launcher");
    expect(await readFile(resolve(f.launcher, "previous-marker"), "utf8")).toBe("previous installation");
    expect(await readFile(f.wrapper, "utf8")).toBe("previous wrapper\n");
    await f.expectClean();
  });
});
