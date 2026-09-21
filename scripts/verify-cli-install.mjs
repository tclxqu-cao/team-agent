#!/usr/bin/env node
/** Fresh-directory runtime smoke for the platform selected by Node.js. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, delimiter, dirname, resolve } from "node:path";
import { releasePackageNames, resolveReleaseArtifacts } from "./cli-release-artifacts.mjs";
import { assertSupportedNodeVersion } from "../packages/cli/bin/runtime-policy.mjs";

const args = process.argv.slice(2);
const nodeBin = args.includes("--node") ? resolve(args[args.indexOf("--node") + 1]) : process.execPath;
const verifyBootstrap = args.includes("--bootstrap-script");
const nodeArchive = args.includes("--node-archive") ? resolve(args[args.indexOf("--node-archive") + 1]) : null;
const artifacts = resolveReleaseArtifacts(args, { includeTui: true });
const packageSet = releasePackageNames(artifacts.target);
const commandEnv = { ...process.env, PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}` };
const npmCommand = process.platform === "win32"
  ? {
      file: nodeBin,
      args: [resolve(dirname(nodeBin), "node_modules", "npm", "bin", "npm-cli.js")],
    }
  : { file: "npm", args: [] };

const version = execFileSync(nodeBin, ["-p", "process.versions.node"], { encoding: "utf8" }).trim();
assertSupportedNodeVersion(version);

const workdir = mkdtempSync(resolve(tmpdir(), "agentroam-install-"));
console.log(`target: ${artifacts.target}`);
console.log(`workdir: ${workdir}`);
let child;

try {
  execFileSync(npmCommand.file, [...npmCommand.args, "init", "-y"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  execFileSync(npmCommand.file, [...npmCommand.args,
    "install",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    artifacts.runtime,
    artifacts.cloudflared,
    artifacts.tui,
    artifacts.launcher,
  ], {
    cwd: workdir,
    stdio: "inherit",
    env: commandEnv,
  });

  const launcher = resolve(workdir, "node_modules/agentroam/bin/agentroam.mjs");
  const tuiLauncher = resolve(workdir, "node_modules/agentroam/bin/agent-tui.mjs");
  const tuiProbe = spawnSync(nodeBin, [tuiLauncher], { cwd: workdir, encoding: "utf8", env: commandEnv });
  if (tuiProbe.status !== 1 || !tuiProbe.stderr.includes("需要交互式终端")) {
    throw new Error(`agent-tui load probe failed: ${JSON.stringify({ status: tuiProbe.status, stderr: tuiProbe.stderr })}`);
  }
  console.log("✓ agent-tui loads without Bun");

  if (process.platform === "darwin") {
    const serviceHome = resolve(workdir, "service-home");
    const serviceProbe = spawnSync(nodeBin, [launcher, "service", "status"], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...commandEnv, HOME: serviceHome },
    });
    if (serviceProbe.status !== 0 || !serviceProbe.stdout.includes("not installed")) {
      throw new Error(`agentroam service probe failed: ${JSON.stringify({
        status: serviceProbe.status,
        stdout: serviceProbe.stdout,
        stderr: serviceProbe.stderr,
      })}`);
    }
    console.log("✓ macOS service command is packaged and non-mutating status works");
  }

  const dataDir = resolve(workdir, "data");
  execFileSync(nodeBin, [launcher, "doctor", "--data-dir", dataDir], { cwd: workdir, stdio: "inherit", env: commandEnv });
  const runtimeRoot = resolve(workdir, "node_modules", packageSet.runtime, "runtime");
  const runtimeManifest = JSON.parse(readFileSync(resolve(workdir, "node_modules", packageSet.runtime, "manifest.json"), "utf8"));
  if (runtimeManifest.target !== artifacts.target) throw new Error(`installed runtime target mismatch: ${runtimeManifest.target}`);

  const cloudflared = resolve(dataDir, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  accessSync(cloudflared, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  execFileSync(cloudflared, ["--version"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  console.log("✓ bundled cloudflared installed and executable");

  runSqliteSmoke(nodeBin, runtimeRoot, workdir);
  console.log("✓ better-sqlite3 created and read a database");
  runNodePtySmoke(nodeBin, runtimeRoot, workdir);
  if (process.platform === "win32") {
    for (const executable of ["agentroam-remote-desktop.exe", "agentroam-remote-unlock.exe"]) {
      execFileSync(resolve(runtimeRoot, "native", executable), ["--self-test"], { cwd: workdir, stdio: "inherit", timeout: 30_000 });
    }
  }
  console.log(`✓ node-pty spawned ${process.platform === "win32" ? "PowerShell through ConPTY" : "zsh"}`);

  child = spawn(
    nodeBin,
    [launcher, "start", "--local-only", "--no-qr", "--data-dir", dataDir, "--root", workdir],
    { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: commandEnv },
  );
  let output = "";
  const append = (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const urlMatch = await waitFor(/Local server: (http:\/\/127\.0\.0\.1:\d+\/web)/, () => output, 210_000);
  const localUrl = urlMatch[1].replace(/\/web$/, "");
  const openMatch = await waitFor(/Open: (http:\/\/[^\s]+)/, () => output, 10_000);
  console.log(`✓ pairing URL: ${new URL(openMatch[1]).origin}`);
  const status = await fetch(`${localUrl}/api/web-auth/status`);
  if (!status.ok) throw new Error(`health check failed: ${status.status}`);
  const unauthorized = await fetch(`${localUrl}/app/`);
  if (unauthorized.status !== 401) throw new Error('unpaired app access must be rejected');
  const { pairingAdmin } = await import(pathToFileURL(resolve(dirname(launcher), '../dist/device-pairing.js')).href);
  const { grant } = await pairingAdmin(dataDir, 'qr');
  const paired = await fetch(`${localUrl}/api/pairing/qr-exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: localUrl },
    body: JSON.stringify({ grant, name: 'Fresh install smoke' }),
  });
  if (!paired.ok) throw new Error(`pairing failed: ${paired.status}`);
  const cookie = paired.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('pairing did not issue a device session');
  const webapp = await fetch(`${localUrl}/app/`, { headers: { cookie } });
  const html = webapp.ok ? await webapp.text() : "";
  if (!webapp.ok || !html.includes("<script")) throw new Error(`/app/ smoke failed: HTTP ${webapp.status}`);
  console.log(`✓ local server and webapp responded (${html.length} bytes)`);

  child.kill("SIGTERM");
  await waitExit(child, 10_000);
  child = undefined;
  if (verifyBootstrap) runBootstrapSmoke(artifacts, workdir, nodeArchive);
  console.log(`✓ ${artifacts.target} fresh-install smoke passed`);
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await waitExit(child, 10_000).catch(() => {});
  }
  rmSync(workdir, { recursive: true, force: true });
}

function runBootstrapSmoke(artifacts, parentWorkdir, archivePath) {
  const bootstrapHome = resolve(parentWorkdir, "bootstrap-home");
  const bootstrapData = resolve(parentWorkdir, "bootstrap-data");
  mkdirSync(bootstrapHome, { recursive: true });
  const scriptName = process.platform === "win32" ? "install-agentroam.ps1" : "install-agentroam.sh";
  const scriptPath = resolve(artifacts.artifactDirectory, scriptName);
  accessSync(scriptPath, constants.F_OK);
  const extraSeparator = process.platform === "win32" ? ";" : " ";
  // Pin the exact version under test: otherwise the installer resolves the
  // "preview" dist-tag, which still points at the previous release until this
  // release is published, and the version validation below fails.
  const bootstrapVersion = basename(artifacts.launcher).match(/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/)?.[1];
  if (!bootstrapVersion) throw new Error(`cannot derive bootstrap version from ${artifacts.launcher}`);
  const bootstrapEnv = {
    ...process.env,
    HOME: bootstrapHome,
    USERPROFILE: bootstrapHome,
    AGENTROAM_DATA_DIR: bootstrapData,
    AGENTROAM_ROOT: parentWorkdir,
    AGENTROAM_INSTALL_SKIP_SERVICE: "1",
    AGENTROAM_BOOTSTRAP_TEST: "1",
    AGENTROAM_FORCE_PRIVATE_NODE: "1",
    AGENTROAM_VERSION: bootstrapVersion,
    AGENTROAM_PACKAGE_SPEC: artifacts.launcher,
    AGENTROAM_BOOTSTRAP_EXTRA_SPECS: [artifacts.runtime, artifacts.cloudflared, artifacts.tui].join(extraSeparator),
    ...(archivePath ? { AGENTROAM_NODE_ARCHIVE_FILE: archivePath } : {}),
  };
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ], { cwd: parentWorkdir, stdio: "inherit", env: bootstrapEnv });
  } else {
    execFileSync("/bin/sh", [scriptPath], { cwd: parentWorkdir, stdio: "inherit", env: bootstrapEnv });
  }

  const managedNode = resolve(bootstrapData, "runtimes", "node", "22.22.0", process.platform === "win32" ? "node.exe" : "bin/node");
  const installedVersion = execFileSync(managedNode, ["-p", "process.versions.node"], {
    encoding: "utf8",
    env: bootstrapEnv,
  }).trim();
  if (installedVersion !== "22.22.0") throw new Error(`bootstrap Node mismatch: ${installedVersion}`);
  const wrapper = process.platform === "win32"
    ? resolve(bootstrapHome, ".agentroam", "bin", "agentroam.cmd")
    : resolve(bootstrapHome, ".local", "bin", "agentroam");
  // Derive the expected version from the launcher tarball actually installed by the script
  // (AGENTROAM_PACKAGE_SPEC), so this smoke never drifts from the release under test.
  const launcherVersion = basename(artifacts.launcher).match(/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/)?.[1];
  if (!launcherVersion) throw new Error(`cannot derive launcher version from ${artifacts.launcher}`);
  const versionOutput = process.platform === "win32"
    ? execFileSync("cmd.exe", ["/d", "/s", "/c", `"${wrapper}" version`], { encoding: "utf8", env: bootstrapEnv })
    : execFileSync(wrapper, ["version"], { encoding: "utf8", env: bootstrapEnv });
  if (!versionOutput.includes(launcherVersion)) throw new Error(`bootstrap wrapper mismatch: expected ${launcherVersion}, got ${versionOutput}`);
  console.log(`✓ standalone ${scriptName} installed private Node ${installedVersion} and the versioned wrapper (${launcherVersion})`);
}

function runSqliteSmoke(node, runtimeRoot, cwd) {
  const script = `
    const { createRequire } = require("node:module");
    const { resolve } = require("node:path");
    const runtimeRequire = createRequire(process.argv[1]);
    const Database = runtimeRequire("better-sqlite3");
    const db = new Database(resolve(process.cwd(), "native-smoke.db"));
    db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke VALUES (?)").run("agentroam-sqlite-ok");
    const row = db.prepare("SELECT value FROM smoke").get();
    db.close();
    if (row.value !== "agentroam-sqlite-ok") process.exit(1);
  `;
  execFileSync(node, ["-e", script, resolve(runtimeRoot, "package.json")], { cwd, stdio: "inherit" });
}

function runNodePtySmoke(node, runtimeRoot, cwd) {
  const windows = process.platform === "win32";
  const script = `
    const { createRequire } = require("node:module");
    const runtimeRequire = createRequire(process.argv[1]);
    const pty = runtimeRequire("node-pty");
    const windows = ${JSON.stringify(windows)};
    const shell = pty.spawn(windows ? "powershell.exe" : "/bin/zsh", windows
      ? ["-NoLogo", "-NoProfile", "-Command", "[Console]::Write('agentroam-pty-ok')"]
      : ["-lc", "printf agentroam-pty-ok"], {
        name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
      });
    let output = "";
    const timer = setTimeout(() => { console.error("node-pty smoke timed out"); process.exit(1); }, 10000);
    shell.onData((chunk) => { output += chunk; });
    shell.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes("agentroam-pty-ok")) {
        console.error(JSON.stringify({ exitCode, output }));
        process.exit(1);
      }
    });
  `;
  execFileSync(node, ["-e", script, resolve(runtimeRoot, "package.json")], { cwd, stdio: "inherit" });
}

function waitFor(pattern, getText, timeoutMs) {
  return new Promise((resolveMatch, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const match = getText().match(pattern);
      if (match) return resolveMatch(match);
      if (Date.now() > end) return reject(new Error(`timeout waiting for ${pattern}\n${getText().slice(-2000)}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function waitExit(processHandle, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveExit(undefined);
    });
  });
}
