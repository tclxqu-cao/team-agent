import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { PlatformTarget } from "./platform.js";

const execFileAsync = promisify(execFile);

export const CODEX_RUNTIME_VERSION = "0.153.0";
// Managed install pin tracks releases; the compatibility floor for user installs is independent.
export const CODEX_MINIMUM_VERSION = "0.153.0";
const CODEX_PACKAGE = `@openai/codex@${CODEX_RUNTIME_VERSION}`;
const NPM_REGISTRY = "https://registry.npmjs.org";
export const CODEX_INSTALL_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_LOCK_WAIT_MS = 190_000;
export const CODEX_INSTALL_STALE_LOCK_MS = CODEX_INSTALL_TIMEOUT_MS + 5 * 60_000;
const DEFAULT_STALE_LOCK_MS = CODEX_INSTALL_STALE_LOCK_MS;

export type CodexRuntimeSource = "explicit" | "global" | "managed";

export interface CodexRuntimeResolution {
  executable: string;
  version: string;
  source: CodexRuntimeSource;
}

export interface NpmExecutor {
  command: string;
  argsPrefix: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CodexRuntimeDependencies {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
  sleep(delayMs: number): Promise<void>;
  now(): number;
}

export interface ResolveCodexRuntimeOptions {
  dataDir: string;
  target: PlatformTarget;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  lockWaitMs?: number;
  staleLockMs?: number;
  onProgress?: (message: string) => void;
  dependencies?: Partial<CodexRuntimeDependencies>;
}

export interface ResolveNpmExecutorOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  canAccess?: (path: string) => Promise<boolean>;
}

const defaultDependencies: CodexRuntimeDependencies = {
  async run(command, args, timeoutMs) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return { stdout, stderr };
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string };
      const details = [value.message, value.stderr?.trim(), value.stdout?.trim()]
        .filter(Boolean)
        .join(": ");
      throw new Error(details || "process failed", { cause: error });
    }
  },
  sleep: (delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)),
  now: () => Date.now(),
};

export async function resolveCodexRuntime(
  options: ResolveCodexRuntimeOptions,
): Promise<CodexRuntimeResolution> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const explicit = environment.AGENT_CODEX_BIN?.trim();

  if (explicit) {
    const absolute = platform === "win32" ? win32.isAbsolute(explicit) : isAbsolute(explicit);
    if (!absolute) {
      throw new Error("AGENT_CODEX_BIN must be an absolute path");
    }
    return validateCodex(explicit, "explicit", platform, dependencies);
  }

  const global = await findCompatibleGlobalCodex(environment.PATH, platform, dependencies);
  if (global) return global;

  const managedRoot = resolve(options.dataDir, "runtimes", "codex", CODEX_RUNTIME_VERSION);
  const managed = await validateManagedRuntime(managedRoot, options.target, platform, dependencies);
  if (managed) return managed;

  options.onProgress?.(`Installing managed Codex ${CODEX_RUNTIME_VERSION}...`);
  return installManagedCodex({
    ...options,
    environment,
    platform,
    dependencies,
    managedRoot,
  });
}

export async function resolveNpmExecutor(
  options: ResolveNpmExecutorOptions = {},
): Promise<NpmExecutor> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const canAccess = options.canAccess ?? pathAccessible;
  const npmExecPath = environment.npm_execpath?.trim();
  const npmExecPathIsAbsolute = npmExecPath
    && (platform === "win32" ? win32.isAbsolute(npmExecPath) : isAbsolute(npmExecPath));
  if (npmExecPath && npmExecPathIsAbsolute && await canAccess(npmExecPath)) {
    return {
      command: options.nodeExecutable ?? process.execPath,
      argsPrefix: [npmExecPath],
    };
  }

  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const nodeDirectory = platform === "win32" ? win32.dirname(nodeExecutable) : dirname(nodeExecutable);
  const adjacentNpmCandidates = platform === "win32"
    ? [
      win32.resolve(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
      win32.resolve(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    ]
    : [
      resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(nodeDirectory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
  for (const npmCliPath of adjacentNpmCandidates) {
    if (await canAccess(npmCliPath)) {
      return { command: nodeExecutable, argsPrefix: [npmCliPath] };
    }
  }

  const names = platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  for (const directory of (environment.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = platform === "win32" ? win32.resolve(directory, name) : resolve(directory, name);
      if (!(await canAccess(candidate))) continue;
      if (platform === "win32" && name === "npm.cmd") {
        const npmCliCandidates = [
          win32.resolve(directory, "node_modules", "npm", "bin", "npm-cli.js"),
          win32.resolve(directory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
        ];
        for (const npmCliPath of npmCliCandidates) {
          if (await canAccess(npmCliPath)) {
            return {
              command: options.nodeExecutable ?? process.execPath,
              argsPrefix: [npmCliPath],
            };
          }
        }
        continue;
      }
      return { command: candidate, argsPrefix: [] };
    }
  }
  throw new Error("Codex runtime installer unavailable: npm was not found");
}

export function managedCodexBinaryCandidates(
  runtimeRoot: string,
  target: PlatformTarget,
): string[] {
  const platformInfo = codexPlatformInfo(target);
  const vendorRoot = resolve(
    runtimeRoot,
    "node_modules",
    "@openai",
    platformInfo.packageName,
    "vendor",
    platformInfo.vendorTarget,
  );
  return [
    resolve(vendorRoot, "bin", platformInfo.executable),
    resolve(vendorRoot, "codex", platformInfo.executable),
    resolve(vendorRoot, platformInfo.executable),
  ];
}

export function parseCodexVersion(output: string): string | null {
  const match = output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
  return match?.[1] ?? null;
}

// Compare numeric components, so 0.153.10 and 0.154.0 both exceed 0.153.2.
export function isCodexVersionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split(".").map(BigInt);
  const required = minimum.split(".").map(BigInt);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function meetsCodexMinimum(version: string): boolean {
  return isCodexVersionAtLeast(version, CODEX_MINIMUM_VERSION);
}

async function findCompatibleGlobalCodex(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  dependencies: CodexRuntimeDependencies,
): Promise<CodexRuntimeResolution | null> {
  const names = platform === "win32" ? ["codex.exe", "codex"] : ["codex"];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  for (const directory of (pathValue ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = platform === "win32" ? win32.resolve(directory, name) : resolve(directory, name);
      if (!(await pathAccessible(candidate, platform !== "win32"))) continue;
      try {
        return await validateCodex(candidate, "global", platform, dependencies);
      } catch {
        // An incompatible user installation is left untouched; try managed Codex.
      }
    }
  }
  return null;
}

async function installManagedCodex(
  options: ResolveCodexRuntimeOptions & {
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    dependencies: CodexRuntimeDependencies;
    managedRoot: string;
  },
): Promise<CodexRuntimeResolution> {
  const parent = resolve(options.dataDir, "runtimes", "codex");
  const lockPath = `${options.managedRoot}.lock`;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  await mkdir(parent, { recursive: true });
  const lock = await acquireInstallLock(
    lockPath,
    options.managedRoot,
    options.target,
    options.platform,
    options.dependencies,
    lockWaitMs,
    staleLockMs,
  );
  if (lock.completed) return lock.completed;

  let temporaryRoot: string | null = null;
  try {
    const existing = await validateManagedRuntime(
      options.managedRoot,
      options.target,
      options.platform,
      options.dependencies,
    );
    if (existing) return existing;

    temporaryRoot = await mkdtemp(resolve(parent, `.${CODEX_RUNTIME_VERSION}-${process.pid}-`));
    const npm = await resolveNpmExecutor({
      environment: options.environment,
      platform: options.platform,
      nodeExecutable: options.nodeExecutable,
    });
    await options.dependencies.run(npm.command, [
      ...npm.argsPrefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${NPM_REGISTRY}`,
      "--prefix",
      temporaryRoot,
      CODEX_PACKAGE,
    ], CODEX_INSTALL_TIMEOUT_MS);

    const temporary = await validateManagedRuntime(
      temporaryRoot,
      options.target,
      options.platform,
      options.dependencies,
    );
    if (!temporary) {
      throw new Error(`Codex runtime validation failed after installing ${CODEX_PACKAGE}`);
    }
    await rename(temporaryRoot, options.managedRoot);
    temporaryRoot = null;
    const installed = await validateManagedRuntime(
      options.managedRoot,
      options.target,
      options.platform,
      options.dependencies,
    );
    if (!installed) throw new Error("Codex runtime validation failed after activation");
    return installed;
  } catch (error) {
    const concurrent = await validateManagedRuntime(
      options.managedRoot,
      options.target,
      options.platform,
      options.dependencies,
    );
    if (concurrent) return concurrent;
    throw new Error(`Unable to install managed Codex ${CODEX_RUNTIME_VERSION}: ${describeError(error)}`, {
      cause: error,
    });
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await lock.handle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

async function acquireInstallLock(
  lockPath: string,
  managedRoot: string,
  target: PlatformTarget,
  platform: NodeJS.Platform,
  dependencies: CodexRuntimeDependencies,
  waitMs: number,
  staleMs: number,
): Promise<
  | { handle: Awaited<ReturnType<typeof open>>; completed?: undefined }
  | { completed: CodexRuntimeResolution; handle?: never }
> {
  const deadline = dependencies.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${dependencies.now()}\n`);
      return { handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const completed = await validateManagedRuntime(managedRoot, target, platform, dependencies);
      if (completed) return { completed };
      try {
        const lockStat = await stat(lockPath);
        if (dependencies.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (dependencies.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex runtime install lock: ${lockPath}`);
      }
      await dependencies.sleep(Math.min(250, Math.max(1, deadline - dependencies.now())));
    }
  }
}

async function validateManagedRuntime(
  runtimeRoot: string,
  target: PlatformTarget,
  platform: NodeJS.Platform,
  dependencies: CodexRuntimeDependencies,
): Promise<CodexRuntimeResolution | null> {
  for (const candidate of managedCodexBinaryCandidates(runtimeRoot, target)) {
    if (!isWithin(runtimeRoot, candidate) || !(await pathAccessible(candidate))) continue;
    try {
      if (platform !== "win32") await chmod(candidate, 0o755);
      return await validateCodex(candidate, "managed", platform, dependencies);
    } catch {
      return null;
    }
  }
  return null;
}

async function validateCodex(
  executable: string,
  source: CodexRuntimeSource,
  _platform: NodeJS.Platform,
  dependencies: CodexRuntimeDependencies,
): Promise<CodexRuntimeResolution> {
  if (!(await pathAccessible(executable))) {
    throw new Error(`Codex executable not found: ${executable}`);
  }
  const versionResult = await dependencies.run(executable, ["--version"], 5_000);
  const version = parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version) {
    throw new Error(`Unable to parse a supported stable Codex version from ${executable}`);
  }
  if (!meetsCodexMinimum(version)) {
    throw new Error(
      `Codex ${version} at ${executable} is incompatible; AgentRoam requires >=${CODEX_MINIMUM_VERSION}`,
    );
  }
  try {
    await dependencies.run(executable, ["app-server", "--help"], 5_000);
  } catch (error) {
    throw new Error(`Codex app-server validation failed at ${executable}: ${describeError(error)}`, {
      cause: error,
    });
  }
  return { executable, version, source };
}

function codexPlatformInfo(target: PlatformTarget): {
  packageName: string;
  vendorTarget: string;
  executable: string;
} {
  if (target === "darwin-arm64") {
    return {
      packageName: "codex-darwin-arm64",
      vendorTarget: "aarch64-apple-darwin",
      executable: "codex",
    };
  }
  if (target === "darwin-amd64") {
    return {
      packageName: "codex-darwin-x64",
      vendorTarget: "x86_64-apple-darwin",
      executable: "codex",
    };
  }
  return {
    packageName: "codex-win32-x64",
    vendorTarget: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
  };
}

async function pathAccessible(path: string, executable = false): Promise<boolean> {
  try {
    await access(path, executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
