import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { resolveNpmExecutor } from "./codex-runtime-manager.js";
import type { PlatformTarget } from "./platform.js";

const execFileAsync = promisify(execFile);
// Default managed installation; compatibility has an independent minimum.
export const OPENCODE_RUNTIME_VERSION = "1.18.27";
export const OPENCODE_MINIMUM_VERSION = "1.18.27";
const OPENCODE_PACKAGE = `opencode-ai@${OPENCODE_RUNTIME_VERSION}`;
const NPM_REGISTRY = "https://registry.npmjs.org";

export type OpenCodeRuntimeSource = "explicit" | "global" | "managed";
export interface OpenCodeRuntimeResolution {
  executable: string;
  version: string;
  source: OpenCodeRuntimeSource;
}

interface Dependencies {
  run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ResolveOpenCodeRuntimeOptions {
  dataDir: string;
  target: PlatformTarget;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  lockWaitMs?: number;
  staleLockMs?: number;
  onProgress?: (message: string) => void;
  dependencies?: Partial<Dependencies>;
}

const defaults: Dependencies = {
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
      throw new Error([value.message, value.stderr, value.stdout].filter(Boolean).join(": "), { cause: error });
    }
  },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

export async function resolveOpenCodeRuntime(
  options: ResolveOpenCodeRuntimeOptions,
): Promise<OpenCodeRuntimeResolution> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const dependencies = { ...defaults, ...options.dependencies };
  const explicit = environment.AGENT_OPENCODE_BIN?.trim();
  if (explicit) {
    const absolute = platform === "win32" ? win32.isAbsolute(explicit) : isAbsolute(explicit);
    if (!absolute) throw new Error("AGENT_OPENCODE_BIN must be an absolute path");
    return validate(explicit, "explicit", platform, dependencies);
  }

  const global = await findGlobal(environment.PATH, platform, dependencies);
  if (global) return global;

  const managedRoot = resolve(options.dataDir, "runtimes", "opencode", OPENCODE_RUNTIME_VERSION);
  const managed = await validateManaged(managedRoot, platform, dependencies);
  if (managed) return managed;
  options.onProgress?.(`Installing managed OpenCode ${OPENCODE_RUNTIME_VERSION}...`);
  return install({ ...options, environment, platform, dependencies, managedRoot });
}

export function parseOpenCodeVersion(output: string): string | null {
  return output.match(/(?:^|\s)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\s|$)/)?.[1] ?? null;
}

export function managedOpenCodeBinaryCandidates(root: string, platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? [
        resolve(root, "node_modules", "opencode-ai", "bin", "opencode.exe"),
        resolve(root, "node_modules", ".bin", "opencode.cmd"),
        resolve(root, "node_modules", ".bin", "opencode.exe"),
      ]
    : [
        resolve(root, "node_modules", "opencode-ai", "bin", "opencode.exe"),
        resolve(root, "node_modules", ".bin", "opencode"),
      ];
}

async function findGlobal(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  dependencies: Dependencies,
): Promise<OpenCodeRuntimeResolution | null> {
  const names = platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
  const separator = platform === "win32" ? ";" : delimiter;
  for (const directory of (pathValue ?? "").split(separator).filter(Boolean)) {
    for (const name of names) {
      const candidate = platform === "win32" ? win32.resolve(directory, name) : resolve(directory, name);
      if (!(await accessible(candidate, platform !== "win32"))) continue;
      try {
        return await validate(candidate, "global", platform, dependencies);
      } catch {
        // Leave incompatible user installations untouched and use managed OpenCode.
      }
    }
  }
  return null;
}

async function install(options: ResolveOpenCodeRuntimeOptions & {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  dependencies: Dependencies;
  managedRoot: string;
}): Promise<OpenCodeRuntimeResolution> {
  const parent = resolve(options.dataDir, "runtimes", "opencode");
  const lockPath = `${options.managedRoot}.lock`;
  await mkdir(parent, { recursive: true });
  const lock = await acquireLock(
    lockPath,
    options.managedRoot,
    options.platform,
    options.dependencies,
    options.lockWaitMs ?? 190_000,
    options.staleLockMs ?? 300_000,
  );
  if (lock.completed) return lock.completed;
  let temporary: string | null = null;
  try {
    const existing = await validateManaged(options.managedRoot, options.platform, options.dependencies);
    if (existing) return existing;
    temporary = await mkdtemp(resolve(parent, `.${OPENCODE_RUNTIME_VERSION}-${process.pid}-`));
    const npm = await resolveNpmExecutor({
      environment: options.environment,
      platform: options.platform,
      nodeExecutable: options.nodeExecutable,
    });
    await options.dependencies.run(npm.command, [
      ...npm.argsPrefix,
      "install",
      "--no-audit",
      "--no-fund",
      `--registry=${NPM_REGISTRY}`,
      "--prefix",
      temporary,
      OPENCODE_PACKAGE,
    ], 180_000);
    const validated = await validateManaged(temporary, options.platform, options.dependencies);
    if (!validated) throw new Error(`validation failed after installing ${OPENCODE_PACKAGE}`);
    await rename(temporary, options.managedRoot);
    temporary = null;
    const activated = await validateManaged(options.managedRoot, options.platform, options.dependencies);
    if (!activated) throw new Error("validation failed after activation");
    return activated;
  } catch (error) {
    const concurrent = await validateManaged(options.managedRoot, options.platform, options.dependencies);
    if (concurrent) return concurrent;
    throw new Error(`Unable to install managed OpenCode ${OPENCODE_RUNTIME_VERSION}: ${describe(error)}`, { cause: error });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.handle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

async function acquireLock(
  lockPath: string,
  managedRoot: string,
  platform: NodeJS.Platform,
  dependencies: Dependencies,
  waitMs: number,
  staleMs: number,
): Promise<
  | { handle: Awaited<ReturnType<typeof open>>; completed?: undefined }
  | { completed: OpenCodeRuntimeResolution; handle?: never }
> {
  const deadline = dependencies.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${dependencies.now()}\n`);
      return { handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const completed = await validateManaged(managedRoot, platform, dependencies);
      if (completed) return { completed };
      try {
        if (dependencies.now() - (await stat(lockPath)).mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (dependencies.now() >= deadline) throw new Error(`Timed out waiting for OpenCode runtime install lock: ${lockPath}`);
      await dependencies.sleep(Math.min(250, Math.max(1, deadline - dependencies.now())));
    }
  }
}

async function validateManaged(
  root: string,
  platform: NodeJS.Platform,
  dependencies: Dependencies,
): Promise<OpenCodeRuntimeResolution | null> {
  for (const executable of managedOpenCodeBinaryCandidates(root, platform)) {
    if (!within(root, executable) || !(await accessible(executable))) continue;
    try {
      if (platform !== "win32") await chmod(executable, 0o755);
      return await validate(executable, "managed", platform, dependencies);
    } catch {
      return null;
    }
  }
  return null;
}

async function validate(
  executable: string,
  source: OpenCodeRuntimeSource,
  _platform: NodeJS.Platform,
  dependencies: Dependencies,
): Promise<OpenCodeRuntimeResolution> {
  if (!(await accessible(executable))) throw new Error(`OpenCode executable not found: ${executable}`);
  const result = await dependencies.run(executable, ["--version"], 5_000);
  const version = parseOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new Error(`Unable to parse OpenCode version from ${executable}`);
  if (!meetsOpenCodeMinimum(version)) {
    throw new Error(`OpenCode ${version} at ${executable} is incompatible; AgentRoam requires >=${OPENCODE_MINIMUM_VERSION}`);
  }
  await dependencies.run(executable, ["serve", "--help"], 5_000);
  return { executable, version, source };
}

// Compare numeric components, so 1.18.100 and 1.19.0 both exceed 1.18.27.
function meetsOpenCodeMinimum(version: string): boolean {
  const actual = version.split(".").map(BigInt);
  const minimum = OPENCODE_MINIMUM_VERSION.split(".").map(BigInt);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

async function accessible(path: string, executable = false): Promise<boolean> {
  try {
    await access(path, executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function within(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
