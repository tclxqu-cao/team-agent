import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { styleText } from "node:util";
import { updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";
import {
  parseChannelVersion,
  registryUrlsForChannel,
  compareAgentRoamVersions,
} from "./update-channel.js";
import { buildCliInstallManifestUrl, validateCliInstallManifest } from "./update-install.js";
import { readServiceConfig, resolveServicePaths } from "../service/service-files.js";

const REGISTRY_BASE = "https://registry.npmjs.org/agentroam";

export interface StartUpdateOptions { currentVersion: string; requestedVersion: string | null; dataDir: string; target: "darwin-arm64" | "windows-amd64"; cliPath: string; }

export async function resolveUpdate(options: StartUpdateOptions, fetchImpl: typeof fetch = fetch) {
  const release = await resolveUpdateCandidate(options, fetchImpl);
  if (!release) throw new Error("AgentRoam is already up to date");
  return release;
}

export async function resolveUpdateCandidate(
  { currentVersion, requestedVersion, target }: Pick<StartUpdateOptions, "currentVersion" | "requestedVersion" | "target">,
  fetchImpl: typeof fetch = fetch,
) {
  const version = await getAvailableUpdateVersion(currentVersion, fetchImpl);
  if (!version && requestedVersion) throw new Error("AgentRoam is already up to date");
  if (!version) return null;
  if (requestedVersion && requestedVersion !== version) throw new Error("requested version is not the current npm candidate");
  const response = await fetchWithTimeout(fetchImpl, buildCliInstallManifestUrl());
  if (!response.ok) throw new Error("CLI install manifest is unavailable");
  const asset = validateCliInstallManifest(await response.json(), target);
  return { targetVersion: version, fileName: asset.fileName, sha256: asset.sha256 };
}

// Offer the highest published version across the two npm channels.
export async function getAvailableUpdateVersion(currentVersion: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const results = await Promise.allSettled(registryUrlsForChannel("preview", REGISTRY_BASE).map(async (url) => {
    const response = await fetchWithTimeout(fetchImpl, url);
    if (!response.ok) return null;
    return parseChannelVersion((await response.json() as { version?: unknown }).version, "preview");
  }));
  let best: string | null = null;
  for (const result of results) {
    const candidate = result.status === "fulfilled" ? result.value : null;
    if (!candidate) continue;
    if (!best || compareAgentRoamVersions(candidate, best) > 0) best = candidate;
  }
  if (!best) throw new Error("unable to check the npm release channel");
  return compareAgentRoamVersions(best, currentVersion) > 0 ? best : null;
}

export function formatAvailableUpdate(currentVersion: string, targetVersion: string, stream: NodeJS.WriteStream): string {
  return `${styleText("yellow", "发现 AgentRoam CLI 新版本", { stream })} ${currentVersion} → ${targetVersion} · 运行 agentroam update 安装`;
}

export async function startUpdate(options: StartUpdateOptions): Promise<DurableUpdateState | null> {
  const release = await resolveUpdateCandidate(options);
  if (!release) return null;
  const paths = updatePaths(options.dataDir);
  const service = await readServiceConfig(resolveServicePaths(undefined, options.dataDir));
  if (service && resolve(service.dataDir) !== resolve(options.dataDir)) throw new Error("AgentRoam service uses a different data directory");
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
    ...(service?.relayUrl ? { relayUrl: service.relayUrl } : {}),
    localOnly: service?.localOnly ?? false,
    cliPath: resolve(options.cliPath),
    updatedAt: Date.now(),
  };
  const request = resolve(paths.directory, `request-${randomUUID()}.json`);
  await writeUpdateState(request, state);
  try {
    await new Promise<void>((accepted, reject) => {
      const child = spawn(process.execPath, [options.cliPath, "update-worker", request], {
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`update worker could not start (${code ?? "terminated"})`)));
      child.once("message", (result: { started?: boolean; error?: string }) => {
        child.disconnect();
        child.unref();
        if (result.started) accepted();
        else reject(new Error(result.error ?? "update worker could not start"));
      });
    });
  } catch (error) {
    await unlink(request).catch(() => undefined);
    throw error;
  }
  return state;
}

function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  return fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
}

export const currentCliPath = () => fileURLToPath(new URL("../../bin/agentroam.mjs", import.meta.url));
