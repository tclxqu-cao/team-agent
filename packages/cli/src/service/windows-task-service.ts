import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  WINDOWS_SERVICE_NAME,
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
  runCommand,
  type CommandResult,
  type CommandRunner,
  type ServiceController,
  type ServiceStatus,
} from "./service-controller.js";

interface WindowsTaskServiceOptions {
  homeDir?: string;
  runner?: CommandRunner;
  processExists?: (pid: number) => boolean;
  now?: () => Date;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  validateConfig?: (config: ServiceConfig, hostPath: string) => Promise<void>;
}

export class WindowsTaskService implements ServiceController {
  private readonly homeDir?: string;
  private readonly runner: CommandRunner;
  private readonly processExists: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly validate: (config: ServiceConfig, hostPath: string) => Promise<void>;

  constructor(options: WindowsTaskServiceOptions = {}) {
    this.homeDir = options.homeDir;
    this.runner = options.runner ?? runCommand;
    this.processExists = options.processExists ?? isProcessRunning;
    this.now = options.now ?? (() => new Date());
    this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.validate = options.validateConfig ?? validateWindowsConfig;
  }

  async install(config: ServiceConfig): Promise<{ paths: ServicePaths; state: ServiceRuntimeState | null; definition: string }> {
    const hostPath = resolveWindowsServiceHost(config.cliPath);
    await this.validate(config, hostPath);
    const paths = resolveServicePaths(this.homeDir, config.dataDir);
    await Promise.all([
      ensurePrivateDirectory(paths.controlDir),
      ensurePrivateDirectory(paths.logsDir),
      ensurePrivateFile(paths.stdoutPath),
      ensurePrivateFile(paths.stderrPath),
    ]);
    await writePrivateJson(paths.configPath, config);
    await Promise.all([removeIfExists(paths.statePath), removeIfExists(paths.urlPath)]);
    await this.runRequired(buildRegisterTaskScript(config, hostPath, paths.configPath));
    await this.runRequired(buildStartTaskScript());
    return {
      paths,
      state: await this.waitForReady(paths),
      definition: WINDOWS_SERVICE_NAME,
    };
  }

  async start(): Promise<ServiceRuntimeState | null> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    if (status.running) return status.state;
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    await Promise.all([removeIfExists(paths.statePath), removeIfExists(paths.urlPath)]);
    await this.runRequired(buildStartTaskScript());
    return this.waitForReady(paths, status.state?.pid);
  }

  async stop(): Promise<void> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentRoam service is not installed");
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    if (status.running) {
      await this.runRequired(buildStopTaskScript());
      if (status.state?.pid) await this.waitForProcessExit(status.state.pid);
    }
    await removeIfExists(paths.urlPath);
    if (status.state) {
      await writePrivateJson(paths.statePath, {
        status: "stopped",
        pid: status.state.pid,
        version: status.state.version,
        startedAt: status.state.startedAt,
        updatedAt: this.now().toISOString(),
      } satisfies ServiceRuntimeState);
    }
  }

  async status(): Promise<ServiceStatus> {
    const basePaths = resolveServicePaths(this.homeDir);
    const config = await readServiceConfig(basePaths);
    const paths = resolveServicePaths(this.homeDir, config?.dataDir);
    const task = await this.inspectTask();
    return {
      installed: task.installed,
      loaded: task.installed,
      running: task.running,
      config,
      state: await readServiceState(paths),
      definition: WINDOWS_SERVICE_NAME,
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
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    if (status.running) {
      await this.runRequired(buildStopTaskScript());
      if (status.state?.pid) await this.waitForProcessExit(status.state.pid);
    }
    await Promise.all([removeIfExists(paths.statePath), removeIfExists(paths.urlPath)]);
    await this.runRequired(buildStartTaskScript());
    return this.waitForReady(paths, status.state?.pid);
  }

  async uninstall(): Promise<{ removed: boolean; preservedDataDir: string }> {
    const status = await this.status();
    const paths = resolveServicePaths(this.homeDir, status.config?.dataDir);
    if (status.running) {
      await this.runRequired(buildStopTaskScript());
      if (status.state?.pid) await this.waitForProcessExit(status.state.pid);
    }
    if (status.installed) await this.runRequired(buildUnregisterTaskScript());
    await Promise.all([
      removeIfExists(paths.configPath),
      removeIfExists(paths.statePath),
      removeIfExists(paths.urlPath),
    ]);
    return { removed: status.installed || Boolean(status.config), preservedDataDir: paths.dataDir };
  }

  private async inspectTask(): Promise<{ installed: boolean; running: boolean }> {
    const result = await this.runPowerShell(buildStatusTaskScript());
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`PowerShell task status failed: ${detail}`);
    }
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error("PowerShell task status returned no JSON");
    const value = JSON.parse(line) as { installed?: boolean; running?: boolean };
    return { installed: value.installed === true, running: value.running === true };
  }

  private async runRequired(script: string): Promise<CommandResult> {
    const result = await this.runPowerShell(script);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`PowerShell service command failed: ${detail}`);
    }
    return result;
  }

  private runPowerShell(script: string): Promise<CommandResult> {
    return this.runner("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
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
      if (Date.now() >= deadline) throw new Error(`service process ${pid} did not stop after task termination`);
      await delay(this.pollIntervalMs);
    }
  }
}

export function resolveWindowsServiceHost(cliPath: string): string {
  return win32.resolve(win32.dirname(cliPath), "..", "dist", "service", "windows-service-host.js");
}

export function quoteWindowsCommandLineArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export function buildRegisterTaskScript(config: ServiceConfig, hostPath: string, configPath: string): string {
  const argumentsValue = `${quoteWindowsCommandLineArgument(hostPath)} ${quoteWindowsCommandLineArgument(configPath)}`;
  return String.raw`
$ErrorActionPreference = "Stop"
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${powerShellLiteral(config.nodePath)} -Argument ${powerShellLiteral(argumentsValue)} -WorkingDirectory ${powerShellLiteral(config.roots[0])}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 5) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ${powerShellLiteral(WINDOWS_SERVICE_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;
}

export function buildStatusTaskScript(): string {
  return String.raw`
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName ${powerShellLiteral(WINDOWS_SERVICE_NAME)} -ErrorAction SilentlyContinue
if ($null -eq $task) {
  [pscustomobject]@{ installed = $false; running = $false } | ConvertTo-Json -Compress
} else {
  [pscustomobject]@{ installed = $true; running = ([string]$task.State -eq "Running") } | ConvertTo-Json -Compress
}
`;
}

function buildStartTaskScript(): string {
  return `Start-ScheduledTask -TaskName ${powerShellLiteral(WINDOWS_SERVICE_NAME)}\n`;
}

function buildStopTaskScript(): string {
  return `Stop-ScheduledTask -TaskName ${powerShellLiteral(WINDOWS_SERVICE_NAME)}\n`;
}

function buildUnregisterTaskScript(): string {
  return `Unregister-ScheduledTask -TaskName ${powerShellLiteral(WINDOWS_SERVICE_NAME)} -Confirm:$false\n`;
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function validateWindowsConfig(config: ServiceConfig, hostPath: string): Promise<void> {
  if (!win32.isAbsolute(config.nodePath) || !win32.isAbsolute(config.cliPath)) {
    throw new Error("AgentRoam service requires absolute Node and CLI paths");
  }
  if (config.cliPath.split(/[\\/]/).includes("_npx")) {
    throw new Error("service install cannot use an npx temporary package; install AgentRoam with the versioned installer first");
  }
  await Promise.all([
    access(config.nodePath, constants.X_OK),
    access(config.cliPath, constants.R_OK),
    access(hostPath, constants.R_OK),
    ...config.roots.map(async (root) => {
      if (!(await stat(root)).isDirectory()) throw new Error(`service root is not a directory: ${root}`);
    }),
  ]);
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
