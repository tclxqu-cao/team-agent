import { spawn } from "node:child_process";
import type { ServiceConfig, ServicePaths, ServiceRuntimeState } from "./service-files.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  config: ServiceConfig | null;
  state: ServiceRuntimeState | null;
  definition: string;
}

export interface ServiceLogs {
  stdoutPath: string;
  stderrPath: string;
  stdout: string;
  stderr: string;
}

export interface ServiceInstallResult {
  paths: ServicePaths;
  state: ServiceRuntimeState | null;
  definition: string;
}

export interface ServiceUninstallResult {
  removed: boolean;
  preservedDataDir: string;
}

export interface ServiceController {
  install(config: ServiceConfig): Promise<ServiceInstallResult>;
  start(): Promise<ServiceRuntimeState | null>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
  url(): Promise<string>;
  logs(maxBytes?: number): Promise<ServiceLogs>;
  restart(): Promise<ServiceRuntimeState | null>;
  uninstall(): Promise<ServiceUninstallResult>;
}

export function buildStartArguments(config: ServiceConfig): string[] {
  const args = [config.nodePath, config.cliPath, "start"];
  for (const root of config.roots) args.push("--root", root);
  if (config.port !== null) args.push("--port", String(config.port));
  if (config.localOnly) args.push("--local-only");
  else args.push("--relay", config.relay);
  if (!config.localOnly && config.tunnelCommand) args.push("--tunnel-command", config.tunnelCommand);
  args.push("--data-dir", config.dataDir, "--no-qr");
  return args;
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}
