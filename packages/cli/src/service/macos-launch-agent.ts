import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SERVICE_LABEL,
  ensurePrivateDirectory,
  ensurePrivateFile,
  readServiceConfig,
  readServiceState,
  removeIfExists,
  resolveServicePaths,
  writePrivateJson,
  type ServiceConfig,
  type ServicePaths,
  type ServiceRuntimeState,
} from "./service-files.js";
import {
  buildStartArguments,
  runCommand,
  type CommandResult,
  type CommandRunner,
  type ServiceController,
  type ServiceStatus,
} from "./service-controller.js";

export { buildStartArguments } from "./service-controller.js";
export type { CommandRunner } from "./service-controller.js";

interface LaunchAgentOptions {
  homeDir?: string;
  uid?: number;
  runner?: CommandRunner;
  processExists?: (pid: number) => boolean;
  now?: () => Date;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class MacLaunchAgent implements ServiceController {
  private readonly homeDir?: string;
  private readonly uid: number;
  private readonly runner: CommandRunner;
  private readonly processExists: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: LaunchAgentOptions = {}) {
    this.homeDir = options.homeDir;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.runner = options.runner ?? runCommand;
    this.processExists = options.processExists ?? isProcessRunning;
    this.now = options.now ?? (() => new Date());
    this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  async install(config: ServiceConfig): Promise<{ paths: ServicePaths; state: ServiceRuntimeState | null; definition: string }> {
    await this.validateConfig(config);
    const paths = resolveServicePaths(this.homeDir, config.dataDir);
    const previousState = await readServiceState(paths);
    await Promise.all([
      mkdir(paths.launchAgentsDir, { recursive: true }),
      ensurePrivateDirectory(paths.controlDir),
      ensurePrivateDirectory(paths.logsDir),
    ]);
    await Promise.all([ensurePrivateFile(paths.stdoutPath), ensurePrivateFile(paths.stderrPath)]);

    const jsonPath = resolve(paths.controlDir, "launch-agent.json.tmp");
    const plistTempPath = resolve(paths.controlDir, "launch-agent.plist.tmp");
    await removeIfExists(plistTempPath);
    await writePrivateJson(jsonPath, buildLaunchAgentPlist(config, paths));
    try {
      await this.runRequired("plutil", ["-convert", "xml1", "-o", plistTempPath, jsonPath]);
      await this.runRequired("plutil", ["-lint", plistTempPath]);
      await chmod(plistTempPath, 0o600);
      if ((await this.inspectJob()).loaded) {
        await this.runRequired("launchctl", ["bootout", this.serviceTarget]);
        await this.waitForServiceExit(previousState?.pid);
      }
      await rename(plistTempPath, paths.plistPath);
      await chmod(paths.plistPath, 0o600);
      await writePrivateJson(paths.configPath, config);
      await Promise.all([removeIfExists(paths.statePath), removeIfExists(paths.urlPath)]);
      await this.runRequired("launchctl", ["bootstrap", this.domainTarget, paths.plistPath]);
    } finally {
      await Promise.all([removeIfExists(jsonPath), removeIfExists(plistTempPath)]);
    }

    return { paths, state: await this.waitForReady(paths), definition: paths.plistPath };
  }

  async start(): Promise<ServiceRuntimeState | null> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    if (status.running) return status.state;
    if (status.loaded) await this.runRequired("launchctl", ["kickstart", this.serviceTarget]);
    else await this.runRequired("launchctl", ["bootstrap", this.domainTarget, status.definition]);
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    return this.waitForReady(paths, status.state?.pid);
  }

  async stop(): Promise<void> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    if (!status.loaded) return;
    await this.runRequired("launchctl", ["bootout", this.serviceTarget]);
    if (status.state?.pid) await this.waitForProcessExit(status.state.pid);
  }

  async status(): Promise<ServiceStatus> {
    const basePaths = resolveServicePaths(this.homeDir);
    const config = await readServiceConfig(basePaths);
    const paths = resolveServicePaths(this.homeDir, config?.dataDir);
    const installed = await pathExists(paths.plistPath);
    const job = installed ? await this.inspectJob() : { loaded: false, running: false };
    return {
      installed,
      loaded: job.loaded,
      running: job.running,
      config,
      state: await readServiceState(paths),
      definition: paths.plistPath,
    };
  }

  async url(): Promise<string> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    if (!status.running) throw new Error("AgentRoam service is installed but not running");
    if (status.state?.status !== "ready" || !status.state.accessUrl) {
      throw new Error("AgentRoam service is still starting; try again shortly");
    }
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    const value = (await readFile(paths.urlPath, "utf8")).trim();
    if (!value || value !== status.state.accessUrl) throw new Error("AgentRoam service URL is unavailable or stale");
    return value;
  }

  async logs(maxBytes = 64 * 1024): Promise<{ stdoutPath: string; stderrPath: string; stdout: string; stderr: string }> {
    const basePaths = resolveServicePaths(this.homeDir);
    const config = await readServiceConfig(basePaths);
    const paths = resolveServicePaths(this.homeDir, config?.dataDir);
    const [stdout, stderr] = await Promise.all([
      readTail(paths.stdoutPath, maxBytes),
      readTail(paths.stderrPath, maxBytes),
    ]);
    return { stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath, stdout, stderr };
  }

  async restart(): Promise<ServiceRuntimeState | null> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    if (status.loaded) await this.runRequired("launchctl", ["kickstart", "-k", this.serviceTarget]);
    else await this.runRequired("launchctl", ["bootstrap", this.domainTarget, status.definition]);
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    return this.waitForReady(paths, status.state?.pid);
  }

  async uninstall(): Promise<{ removed: boolean; preservedDataDir: string }> {
    const basePaths = resolveServicePaths(this.homeDir);
    const config = await readServiceConfig(basePaths);
    const paths = resolveServicePaths(this.homeDir, config?.dataDir);
    const installed = await pathExists(paths.plistPath);
    const state = await readServiceState(paths);
    if ((await this.inspectJob()).loaded) {
      await this.runRequired("launchctl", ["bootout", this.serviceTarget]);
      if (state?.pid) await this.waitForProcessExit(state.pid);
    }
    await Promise.all([
      removeIfExists(paths.plistPath),
      removeIfExists(paths.configPath),
      removeIfExists(paths.statePath),
      removeIfExists(paths.urlPath),
    ]);
    return { removed: installed || Boolean(config), preservedDataDir: paths.dataDir };
  }

  private get domainTarget(): string {
    return `gui/${this.uid}`;
  }

  private get serviceTarget(): string {
    return `${this.domainTarget}/${SERVICE_LABEL}`;
  }

  private async inspectJob(): Promise<{ loaded: boolean; running: boolean }> {
    const result = await this.runner("launchctl", ["print", this.serviceTarget]);
    return {
      loaded: result.code === 0,
      running: result.code === 0 && /\bstate\s*=\s*running\b/.test(result.stdout),
    };
  }

  private async runRequired(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.runner(command, args);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`${command} ${args[0] ?? ""} failed: ${detail}`);
    }
    return result;
  }

  private async validateConfig(config: ServiceConfig): Promise<void> {
    if (!config.nodePath.startsWith("/") || !config.cliPath.startsWith("/")) {
      throw new Error("AgentRoam service requires absolute Node and CLI paths");
    }
    if (config.cliPath.split("/").includes("_npx")) {
      throw new Error("service install cannot use an npx temporary package; install AgentRoam with npm install -g first");
    }
    await Promise.all([
      access(config.nodePath, constants.X_OK),
      access(config.cliPath, constants.R_OK),
      ...(config.codexPath ? [access(config.codexPath, constants.X_OK)] : []),
      ...config.roots.map(async (root) => {
        if (!(await stat(root)).isDirectory()) throw new Error(`service root is not a directory: ${root}`);
      }),
    ]);
  }

  private async waitForReady(paths: ServicePaths, previousPid?: number): Promise<ServiceRuntimeState | null> {
    const deadline = Date.now() + this.readyTimeoutMs;
    do {
      const state = await readServiceState(paths);
      if (state?.status === "ready" && (!previousPid || state.pid !== previousPid)) return state;
      if (Date.now() >= deadline) return state;
      await delay(this.pollIntervalMs);
    } while (true);
  }

  private async waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + this.stopTimeoutMs;
    while (this.processExists(pid)) {
      if (Date.now() >= deadline) throw new Error(`service process ${pid} did not stop after launchctl bootout`);
      await delay(this.pollIntervalMs);
    }
  }

  private async waitForServiceExit(pid?: number): Promise<void> {
    const deadline = Date.now() + this.stopTimeoutMs;
    do {
      const processRunning = pid ? this.processExists(pid) : false;
      const job = await this.inspectJob();
      if (!processRunning && !job.loaded) return;
      if (Date.now() >= deadline) {
        if (processRunning) throw new Error(`service process ${pid} did not stop after launchctl bootout`);
        throw new Error(`service ${SERVICE_LABEL} did not unload after launchctl bootout`);
      }
      await delay(this.pollIntervalMs);
    } while (true);
  }
}

export function buildLaunchAgentPlist(config: ServiceConfig, paths: ServicePaths): Record<string, unknown> {
  const environmentVariables: Record<string, string> = {
    AGENTROAM_SERVICE: "1",
    PATH: config.environmentPath || `${dirname(config.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  if (config.codexPath) environmentVariables.AGENT_CODEX_BIN = config.codexPath;
  if (config.codexHome) environmentVariables.CODEX_HOME = config.codexHome;
  return {
    Label: SERVICE_LABEL,
    ProgramArguments: buildStartArguments(config),
    WorkingDirectory: config.roots[0],
    EnvironmentVariables: environmentVariables,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 5,
    StandardOutPath: paths.stdoutPath,
    StandardErrorPath: paths.stderrPath,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const value = await readFile(path);
    return value.subarray(Math.max(0, value.length - maxBytes)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}
