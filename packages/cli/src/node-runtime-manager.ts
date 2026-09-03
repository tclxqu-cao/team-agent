import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NODE_DOWNLOAD_BASE_URL = "https://nodejs.org/dist/v22.22.0";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LOCK_WAIT_MS = 12 * 60_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;
const MAX_REDIRECTS = 5;

export const MANAGED_NODE_VERSION = "22.22.0";

export type NodeRuntimeTarget = "darwin-arm64" | "windows-amd64";

export interface NodeRuntimeAsset {
  archive: string;
  sha256: string;
  archiveRoot: string;
}

export const NODE_RUNTIME_ASSETS: Readonly<Record<NodeRuntimeTarget, NodeRuntimeAsset>> = {
  "darwin-arm64": {
    archive: "node-v22.22.0-darwin-arm64.tar.xz",
    sha256: "2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac",
    archiveRoot: "node-v22.22.0-darwin-arm64",
  },
  "windows-amd64": {
    archive: "node-v22.22.0-win-x64.zip",
    sha256: "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a",
    archiveRoot: "node-v22.22.0-win-x64",
  },
};

export interface NodeRuntimeResolution {
  executable: string;
  npmCli: string;
  version: string;
  source: "managed";
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface NodeRuntimeDependencies {
  download(url: string, destination: string, timeoutMs: number): Promise<void>;
  sha256(path: string): Promise<string>;
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
  sleep(delayMs: number): Promise<void>;
  now(): number;
}

export interface EnsureManagedNodeOptions {
  dataDir: string;
  target?: NodeRuntimeTarget;
  platform?: NodeJS.Platform;
  arch?: string;
  downloadTimeoutMs?: number;
  lockWaitMs?: number;
  staleLockMs?: number;
  onProgress?: (message: string) => void;
  dependencies?: Partial<NodeRuntimeDependencies>;
}

const defaultDependencies: NodeRuntimeDependencies = {
  download: downloadFile,
  sha256: sha256File,
  async run(command, args, timeoutMs) {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  },
  sleep: (delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)),
  now: () => Date.now(),
};

export function detectNodeRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NodeRuntimeTarget {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw Object.assign(new Error(`managed Node.js is unsupported on ${platform}-${arch}`), {
    exitCode: 2,
  });
}

export function managedNodeExecutable(dataDir: string, target: NodeRuntimeTarget): string {
  const root = resolve(dataDir, "runtimes", "node", MANAGED_NODE_VERSION);
  return target === "windows-amd64" ? resolve(root, "node.exe") : resolve(root, "bin", "node");
}

export function managedNodeNpmCli(dataDir: string, target: NodeRuntimeTarget): string {
  const root = resolve(dataDir, "runtimes", "node", MANAGED_NODE_VERSION);
  return target === "windows-amd64"
    ? resolve(root, "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

export async function ensureManagedNode(
  options: EnsureManagedNodeOptions,
): Promise<NodeRuntimeResolution> {
  const target = options.target ?? detectNodeRuntimeTarget(options.platform, options.arch);
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const cached = await validateManagedNode(options.dataDir, target, dependencies);
  if (cached) return cached;

  const parent = resolve(options.dataDir, "runtimes", "node");
  const runtimeRoot = resolve(parent, MANAGED_NODE_VERSION);
  const lockPath = `${runtimeRoot}.lock`;
  await mkdir(parent, { recursive: true });
  const lock = await acquireLock({
    lockPath,
    dataDir: options.dataDir,
    target,
    dependencies,
    waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    staleMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
  });
  if (lock.completed) return lock.completed;

  let temporaryRoot: string | null = null;
  try {
    const afterLock = await validateManagedNode(options.dataDir, target, dependencies);
    if (afterLock) return afterLock;

    const asset = NODE_RUNTIME_ASSETS[target];
    temporaryRoot = await mkdtemp(resolve(parent, `.${MANAGED_NODE_VERSION}-${process.pid}-`));
    const archivePath = resolve(temporaryRoot, asset.archive);
    const extractRoot = resolve(temporaryRoot, "extract");
    await mkdir(extractRoot);
    options.onProgress?.(`Downloading Node.js ${MANAGED_NODE_VERSION} for ${target}...`);
    await dependencies.download(
      `${NODE_DOWNLOAD_BASE_URL}/${asset.archive}`,
      archivePath,
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );
    const actualSha256 = await dependencies.sha256(archivePath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(`Node.js archive checksum mismatch: expected ${asset.sha256}, got ${actualSha256}`);
    }

    options.onProgress?.(`Extracting Node.js ${MANAGED_NODE_VERSION}...`);
    await extractArchive(target, archivePath, extractRoot, dependencies);
    const entries = await readdir(extractRoot);
    if (entries.length !== 1 || entries[0] !== asset.archiveRoot) {
      throw new Error(`unexpected Node.js archive root: ${entries.join(", ") || "empty archive"}`);
    }

    const extractedRuntime = resolve(extractRoot, asset.archiveRoot);
    const staged = await validateRuntimeRoot(extractedRuntime, target, dependencies);
    if (!staged) throw new Error("Node.js runtime validation failed after extraction");

    await rm(runtimeRoot, { recursive: true, force: true });
    await rename(extractedRuntime, runtimeRoot);
    const installed = await validateManagedNode(options.dataDir, target, dependencies);
    if (!installed) throw new Error("Node.js runtime validation failed after activation");
    return installed;
  } catch (error) {
    const concurrent = await validateManagedNode(options.dataDir, target, dependencies);
    if (concurrent) return concurrent;
    throw new Error(`Unable to install managed Node.js ${MANAGED_NODE_VERSION}: ${describeError(error)}`, {
      cause: error,
    });
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await lock.handle.close().catch(() => undefined);
    await releaseOwnedLock(lockPath, lock.token);
  }
}

async function validateManagedNode(
  dataDir: string,
  target: NodeRuntimeTarget,
  dependencies: NodeRuntimeDependencies,
): Promise<NodeRuntimeResolution | null> {
  return validateRuntimeRoot(
    resolve(dataDir, "runtimes", "node", MANAGED_NODE_VERSION),
    target,
    dependencies,
  );
}

async function validateRuntimeRoot(
  runtimeRoot: string,
  target: NodeRuntimeTarget,
  dependencies: NodeRuntimeDependencies,
): Promise<NodeRuntimeResolution | null> {
  const executable = target === "windows-amd64"
    ? resolve(runtimeRoot, "node.exe")
    : resolve(runtimeRoot, "bin", "node");
  const npmCli = target === "windows-amd64"
    ? resolve(runtimeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(runtimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!(await pathExists(executable)) || !(await pathExists(npmCli))) return null;
  try {
    if (target === "darwin-arm64") await chmod(executable, 0o755);
    const result = await dependencies.run(executable, ["--version"], 5_000);
    if (`${result.stdout}\n${result.stderr}`.trim() !== `v${MANAGED_NODE_VERSION}`) return null;
    return { executable, npmCli, version: MANAGED_NODE_VERSION, source: "managed" };
  } catch {
    return null;
  }
}

async function extractArchive(
  target: NodeRuntimeTarget,
  archivePath: string,
  extractRoot: string,
  dependencies: NodeRuntimeDependencies,
): Promise<void> {
  if (target === "darwin-arm64") {
    await dependencies.run("/usr/bin/tar", ["-xJf", archivePath, "-C", extractRoot], 120_000);
    return;
  }
  const script = "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
  await dependencies.run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, archivePath, extractRoot],
    120_000,
  );
}

async function acquireLock(options: {
  lockPath: string;
  dataDir: string;
  target: NodeRuntimeTarget;
  dependencies: NodeRuntimeDependencies;
  waitMs: number;
  staleMs: number;
}): Promise<
  | { handle: Awaited<ReturnType<typeof open>>; token: string; completed?: undefined }
  | { completed: NodeRuntimeResolution; handle?: never; token?: never }
> {
  const deadline = options.dependencies.now() + options.waitMs;
  while (true) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const handle = await open(options.lockPath, "wx", 0o600);
      await handle.writeFile(`${token}\n${options.dependencies.now()}\n`);
      return { handle, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const completed = await validateManagedNode(options.dataDir, options.target, options.dependencies);
      if (completed) return { completed };
      try {
        const details = await stat(options.lockPath);
        if (options.dependencies.now() - details.mtimeMs > options.staleMs) {
          await rm(options.lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (options.dependencies.now() >= deadline) {
        throw new Error(`Timed out waiting for Node.js install lock: ${options.lockPath}`);
      }
      await options.dependencies.sleep(Math.min(250, Math.max(1, deadline - options.dependencies.now())));
    }
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")).split("\n", 1)[0] === token) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // A missing or replaced lock no longer belongs to this installer.
  }
}

async function downloadFile(url: string, destination: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveDownload, rejectDownload) => {
    const request = (currentUrl: string, redirects: number) => {
      const responseRequest = httpsGet(currentUrl, { headers: { "user-agent": "agentroam-node-bootstrap" } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) return rejectDownload(new Error("too many Node.js download redirects"));
          const redirectUrl = new URL(response.headers.location, currentUrl);
          if (redirectUrl.protocol !== "https:") {
            rejectDownload(new Error(`refusing non-HTTPS Node.js redirect: ${redirectUrl.protocol}`));
            return;
          }
          request(redirectUrl.toString(), redirects + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectDownload(new Error(`Node.js download failed: HTTP ${status}`));
          return;
        }
        pipeline(response, createWriteStream(destination, { mode: 0o600 }))
          .then(resolveDownload, rejectDownload);
      });
      responseRequest.setTimeout(timeoutMs, () => responseRequest.destroy(new Error("Node.js download timed out")));
      responseRequest.once("error", rejectDownload);
    };
    request(url, 0);
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
