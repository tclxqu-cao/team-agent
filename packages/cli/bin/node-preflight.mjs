import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINIMUM_NODE_VERSION, compareNodeVersions, isSupportedNodeVersion, parseNodeVersion } from "./runtime-policy.mjs";

const execFileAsync = promisify(execFile);
// 安装引导地址：指向仓库主分支上的安装脚本（raw 路径）。
// 不走 release 产物 —— 避免依赖「发布流程是否产出 asset」，用户拿到的始终是最新安装器。
const INSTALL_BASE_URL = "https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export async function runNodePreflight(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const launcherPath = options.launcherPath ?? fileURLToPath(new URL("./agentroam.mjs", import.meta.url));
  const environment = options.environment ?? process.env;
  const processHost = options.processHost ?? process;
  const major = Number(nodeVersion.split(".")[0]);

  if (isSupportedNodeVersion(nodeVersion)) return { handled: false };
  if (environment.AGENTROAM_MANAGED_NODE) {
    throw cliError(
      `managed Node.js re-entry failed: expected >=${MINIMUM_NODE_VERSION}, got ${nodeVersion} (${environment.AGENTROAM_MANAGED_NODE})`,
    );
  }
  if (!Number.isFinite(major) || major < 18) {
    throw cliError(standaloneInstallerMessage(platform));
  }

  const target = detectManagedTarget(platform, arch);
  const dataDir = parsePreflightDataDir(argv, environment, options.homeDir ?? homedir());
  const findSystemNode = options.findSystemNode ?? defaultFindSystemNode;
  const systemNode = await findSystemNode(environment, platform, options.currentExecutable ?? process.execPath);
  let executable = systemNode;

  if (!executable) {
    const ensureNode = options.ensureNode ?? (async (installOptions) => {
      const { ensureManagedNode } = await import("../dist/node-runtime-manager.js");
      return ensureManagedNode(installOptions);
    });
    const resolution = await ensureNode({
      dataDir,
      target,
      platform,
      arch,
      onProgress: options.onProgress ?? ((message) => processHost.stderr.write(`${message}\n`)),
    });
    executable = resolution.executable;
  }

  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const child = spawnChild(executable, [launcherPath, ...argv], {
    stdio: "inherit",
    env: { ...environment, AGENTROAM_MANAGED_NODE: executable },
  });
  const result = await waitForChild(child, processHost);
  return { handled: true, ...result };
}

export function parsePreflightDataDir(argv, environment = process.env, homeDir = homedir()) {
  const index = argv.indexOf("--data-dir");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw cliError("missing value for --data-dir");
    return resolve(value);
  }
  return resolve(environment.AGENTROAM_DATA_DIR?.trim() || homeDir, environment.AGENTROAM_DATA_DIR?.trim() ? "" : ".agentroam");
}

function detectManagedTarget(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw cliError(`managed Node.js is unsupported on ${platform}-${arch}`);
}

async function defaultFindSystemNode(environment, platform, currentExecutable) {
  const executableName = platform === "win32" ? "node.exe" : "node";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const currentDirectory = dirname(currentExecutable);
  for (const directory of (environment.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    if (resolve(directory) === resolve(currentDirectory)) continue;
    const candidate = resolve(directory, executableName);
    const version = await inspectNodeVersion(candidate);
    if (isSupportedNodeVersion(version)) return candidate;
  }
  return findNvmNode(environment, platform);
}

export async function findNvmNode(environment = process.env, platform = process.platform) {
  const windows = platform === "win32";
  const homeDir = environment.HOME || environment.USERPROFILE || homedir();
  const roots = windows
    ? [environment.NVM_HOME, environment.APPDATA ? resolve(environment.APPDATA, "nvm") : undefined]
    : [environment.NVM_DIR, resolve(homeDir, ".nvm")];
  const candidates = [];
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const versionsRoot = windows ? root : resolve(root, "versions", "node");
    let entries;
    try {
      entries = await readdir(versionsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(versionsRoot, entry.name, windows ? "node.exe" : "bin/node");
      const version = await inspectNodeVersion(candidate);
      if (isSupportedNodeVersion(version)) candidates.push({ candidate, version });
    }
  }
  candidates.sort((left, right) => compareNodeVersions(right.version, left.version));
  return candidates[0]?.candidate ?? null;
}

async function inspectNodeVersion(candidate) {
  try {
    await access(candidate);
    const { stdout } = await execFileAsync(candidate, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const version = stdout.trim();
    return parseNodeVersion(version) ? version : null;
  } catch {
    return null;
  }
}

async function defaultSpawnChild(executable, args, options) {
  const { spawn } = await import("node:child_process");
  return spawn(executable, args, options);
}

function waitForChild(childPromise, processHost) {
  return Promise.resolve(childPromise).then((child) => new Promise((resolveChild, rejectChild) => {
    const listeners = new Map();
    const cleanup = () => {
      for (const [signal, listener] of listeners) processHost.off(signal, listener);
    };
    for (const signal of FORWARDED_SIGNALS) {
      const listener = () => child.kill(signal);
      listeners.set(signal, listener);
      processHost.on(signal, listener);
    }
    child.once("error", (error) => {
      cleanup();
      rejectChild(error);
    });
    child.once("exit", (exitCode, signal) => {
      cleanup();
      resolveChild({ exitCode, signal });
    });
  }));
}

function standaloneInstallerMessage(platform) {
  if (platform === "win32") {
    return `Node.js 18+ is required for automatic bootstrap. Run: irm ${INSTALL_BASE_URL}/install-agentroam.ps1 | iex`;
  }
  return `Node.js 18+ is required for automatic bootstrap. Run: curl -fsSL ${INSTALL_BASE_URL}/install-agentroam.sh | sh`;
}

function cliError(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}
