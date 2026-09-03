import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { RelayMode } from "../args.js";

export const SERVICE_LABEL = "com.agentroam.service";

export interface ServicePaths {
  homeDir: string;
  dataDir: string;
  launchAgentsDir: string;
  plistPath: string;
  controlDir: string;
  configPath: string;
  statePath: string;
  urlPath: string;
  logsDir: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface ServiceConfig {
  version: string;
  nodePath: string;
  cliPath: string;
  roots: string[];
  port: number | null;
  relay: RelayMode;
  tunnelCommand: string | null;
  localOnly: boolean;
  dataDir: string;
  installedAt: string;
}

export type ServiceProvider = "cloudflare" | "pinggy" | "custom" | "lan";

export interface ServiceRuntimeState {
  status: "starting" | "ready" | "stopped";
  pid: number;
  version: string;
  startedAt: string;
  updatedAt: string;
  localUrl?: string;
  publicUrl?: string;
  accessUrl?: string;
  provider?: ServiceProvider;
}

export function resolveServicePaths(homeDir = homedir(), dataDir = resolve(homeDir, ".agentroam")): ServicePaths {
  const normalizedHome = resolve(homeDir);
  const normalizedData = resolve(dataDir);
  const launchAgentsDir = resolve(normalizedHome, "Library", "LaunchAgents");
  const controlDir = resolve(normalizedHome, ".agentroam", "service");
  const logsDir = resolve(normalizedData, "logs");
  return {
    homeDir: normalizedHome,
    dataDir: normalizedData,
    launchAgentsDir,
    plistPath: resolve(launchAgentsDir, `${SERVICE_LABEL}.plist`),
    controlDir,
    configPath: resolve(controlDir, "config.json"),
    statePath: resolve(controlDir, "state.json"),
    urlPath: resolve(normalizedData, "tunnel.url"),
    logsDir,
    stdoutPath: resolve(logsDir, "service.stdout.log"),
    stderrPath: resolve(logsDir, "service.stderr.log"),
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function ensurePrivateFile(path: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writePrivateText(path: string, value: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readServiceConfig(paths: ServicePaths): Promise<ServiceConfig | null> {
  return readJson<ServiceConfig>(paths.configPath);
}

export async function readServiceState(paths: ServicePaths): Promise<ServiceRuntimeState | null> {
  return readJson<ServiceRuntimeState>(paths.statePath);
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
