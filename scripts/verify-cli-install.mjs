#!/usr/bin/env node
/**
 * Fresh-directory install smoke test for the CLI tarball.
 * Usage: node scripts/verify-cli-install.mjs [main.tgz] [cloudflared.tgz] [tui.tgz] [--node /path/to/node22]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const nodeBin = args.includes("--node")
  ? args[args.indexOf("--node") + 1]
  : process.execPath;
const tarballs = args.filter((arg) => arg.endsWith(".tgz")).map((path) => resolve(path));
const tarball = tarballs.find((path) => /agentroam-0\.2\.0-preview\.6\.tgz$/.test(path))
  ?? resolve(root, "packages/cli/agentroam-0.2.0-preview.6.tgz");
const platformTarball = tarballs.find((path) => /agentroam-cloudflared-darwin-arm64-0\.2\.0-preview\.6\.tgz$/.test(path))
  ?? resolve(root, "packages/cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.6.tgz");
const tuiTarball = tarballs.find((path) => /agentroam-tui-darwin-arm64-0\.2\.0-preview\.6\.tgz$/.test(path))
  ?? resolve(root, "packages/tui-darwin-arm64/agentroam-tui-darwin-arm64-0.2.0-preview.6.tgz");
const commandEnv = { ...process.env, PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}` };

const major = Number(String(execFileSync(nodeBin, ["-p", "process.versions.node"], { encoding: "utf8" }).trim()).split(".")[0]);
if (major !== 22) {
  console.warn(`warn: expected Node 22, got ${execFileSync(nodeBin, ["-v"], { encoding: "utf8" }).trim()}`);
}

const workdir = mkdtempSync(resolve(tmpdir(), "agentroam-install-"));
console.log(`workdir: ${workdir}`);
let child;

try {
  execFileSync(nodeBin, ["-v"], { cwd: workdir, stdio: "inherit" });
  execFileSync("npm", ["init", "-y"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  execFileSync("npm", ["install", "--offline", platformTarball, tuiTarball, tarball], {
    cwd: workdir,
    stdio: "inherit",
    env: commandEnv,
  });

  const pkgBin = resolve(workdir, "node_modules/agentroam/bin/agentroam.mjs");
  const tuiBin = resolve(workdir, "node_modules/.bin/agent-tui");
  accessSync(tuiBin, constants.X_OK);
  const tuiProbe = spawnSync(tuiBin, [], { cwd: workdir, encoding: "utf8", env: commandEnv });
  if (tuiProbe.status !== 1 || !tuiProbe.stderr.includes("需要交互式终端")) {
    throw new Error(`agent-tui load probe failed: ${JSON.stringify({ status: tuiProbe.status, stderr: tuiProbe.stderr })}`);
  }
  console.log("✓ bundled agent-tui command loads without Bun");
  const dataDir = resolve(workdir, "data");
  execFileSync(nodeBin, [pkgBin, "doctor", "--data-dir", dataDir], { cwd: workdir, stdio: "inherit", env: commandEnv });
  const cloudflared = resolve(dataDir, "bin/cloudflared");
  accessSync(cloudflared, constants.X_OK);
  execFileSync(cloudflared, ["--version"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  console.log("✓ bundled cloudflared extracted and executable");

  child = spawn(
    nodeBin,
    [pkgBin, "start", "--local-only", "--no-qr", "--data-dir", dataDir, "--root", workdir],
    { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: commandEnv },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const urlMatch = await waitFor(/Local server: (http:\/\/127\.0\.0\.1:\d+\/web)/, () => stdout + stderr, 45000);
  const localUrl = urlMatch[1].replace(/\/web$/, "");
  const openMatch = await waitFor(/Open: (http:\/\/[^\s]+\/web\?pair=[^\s]+)/, () => stdout + stderr, 10000);
  console.log(`✓ LAN pairing URL: ${new URL(openMatch[1]).origin}`);
  const status = await fetch(`${localUrl}/api/web-auth/status`);
  if (!status.ok) throw new Error(`health check failed: ${status.status}`);
  const body = await status.json();
  console.log(`✓ health: needsSetup=${body.needsSetup}`);

  const webapp = await fetch(`${localUrl}/app/`);
  const webappHtml = webapp.ok ? await webapp.text() : "";
  if (!webapp.ok || !webappHtml.includes("<script")) throw new Error(`/app/ smoke failed: HTTP ${webapp.status}`);
  console.log(`✓ webapp served at /app/ (${webappHtml.length} bytes)`);

  const runtimeRoot = resolve(workdir, "node_modules/agentroam/runtime");
  const spawnHelper = resolve(runtimeRoot, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  accessSync(spawnHelper, constants.X_OK);
  runNodePtySmoke(nodeBin, runtimeRoot, workdir);
  console.log("✓ node-pty spawned a real shell");

  child.kill("SIGTERM");
  await waitExit(child, 10000);
  child = undefined;
  console.log("✓ fresh install smoke test passed");
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await waitExit(child, 10000).catch(() => {});
  }
  rmSync(workdir, { recursive: true, force: true });
}

function runNodePtySmoke(nodeBin, runtimeRoot, cwd) {
  const script = `
    const { createRequire } = require("node:module");
    const runtimeRequire = createRequire(process.argv[1]);
    const pty = runtimeRequire("node-pty");
    const shell = pty.spawn("/bin/zsh", ["-lc", "printf agentroam-pty-ok"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    });
    let output = "";
    const timer = setTimeout(() => { console.error("node-pty smoke timed out"); process.exit(1); }, 5000);
    shell.onData((chunk) => { output += chunk; });
    shell.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes("agentroam-pty-ok")) {
        console.error(JSON.stringify({ exitCode, output }));
        process.exit(1);
      }
    });
  `;
  execFileSync(nodeBin, ["-e", script, resolve(runtimeRoot, "package.json")], { cwd, stdio: "inherit" });
}

function waitFor(pattern, getText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const match = getText().match(pattern);
      if (match) return resolve(match);
      if (Date.now() > end) return reject(new Error(`timeout waiting for ${pattern}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
