import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";
import {
  parseChannelVersion,
  registryUrlsForChannel,
  resolveUpdateChannel,
  type UpdateChannel,
} from "./update-channel.js";
import { buildCliInstallManifestUrl, validateCliInstallManifest } from "./update-install.js";

const REGISTRY_BASE = "https://registry.npmjs.org/agentroam";

export interface StartUpdateOptions { currentVersion: string; requestedVersion: string | null; dataDir: string; target: "darwin-arm64" | "windows-amd64"; cliPath: string; }

export async function resolveUpdate(options: StartUpdateOptions, fetchImpl: typeof fetch = fetch) {
  const channel = resolveUpdateChannel(options.currentVersion);
  const target = await readRegistryCandidate(fetchImpl, channel);
  if (!target) throw new Error("unable to check the npm release channel");
  if (options.requestedVersion && options.requestedVersion !== target) throw new Error("requested version is not the current npm candidate");
  if (compare(target, options.currentVersion) <= 0) throw new Error("AgentRoam is already up to date");
  const response = await fetchWithTimeout(fetchImpl, buildCliInstallManifestUrl());
  if (!response.ok) throw new Error("CLI install manifest is unavailable");
  const asset = validateCliInstallManifest(await response.json(), options.target);
  return { targetVersion: target, fileName: asset.fileName, sha256: asset.sha256 };
}

// Preview installations follow the higher of the preview and latest npm
// dist-tags so a newer stable release can move them onto the stable track.
async function readRegistryCandidate(fetchImpl: typeof fetch, channel: UpdateChannel): Promise<string | null> {
  let best: string | null = null;
  for (const url of registryUrlsForChannel(channel, REGISTRY_BASE)) {
    const response = await fetchWithTimeout(fetchImpl, url).catch(() => null);
    if (!response?.ok) continue;
    const candidate = parseChannelVersion((await response.json() as { version?: unknown }).version, channel);
    if (!candidate) continue;
    if (!best || compare(candidate, best) > 0) best = candidate;
  }
  return best;
}

export async function startUpdate(options: StartUpdateOptions): Promise<DurableUpdateState> {
  const release = await resolveUpdate(options);
  const paths = updatePaths(options.dataDir);
  const service = await readServiceConfig();
  const state: DurableUpdateState = {
    schemaVersion: 1,
    phase: "downloading",
    currentVersion: options.currentVersion,
    ...release,
    dataDir: resolve(options.dataDir),
    roots: service?.roots?.length ? service.roots : [process.cwd()],
    port: service?.port ?? null,
    relay: service?.relay ?? "auto",
    tunnelCommand: service?.tunnelCommand ?? null,
    localOnly: service?.localOnly ?? false,
    cliPath: resolve(options.cliPath),
    updatedAt: Date.now(),
  };
  await writeUpdateState(paths.stateFile, state);
  const child = spawn(process.execPath, [options.cliPath, "update-worker", paths.stateFile], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return state;
}

async function readServiceConfig(): Promise<{ roots?: string[]; port?: number | null; relay?: "auto" | "cloudflare" | "pinggy" | "custom"; tunnelCommand?: string | null; localOnly?: boolean } | null> {
  try {
    return JSON.parse(await readFile(resolve(homedir(), ".agentroam", "service", "config.json"), "utf8"));
  } catch {}
  return null;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  timer.unref?.();
  try { return await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function compare(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(value);
    if (!match) throw new Error("invalid AgentRoam version");
    return [...match.slice(1, 4).map(Number), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])];
  };
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export const currentCliPath = () => fileURLToPath(new URL("../../bin/agentroam.mjs", import.meta.url));
