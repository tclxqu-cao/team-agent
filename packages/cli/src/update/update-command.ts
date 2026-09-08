import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";

const REGISTRY_URL = "https://registry.npmjs.org/agentroam/latest";
const RELEASE_BASE = "https://gitee.com/caoqu/team-agent/releases/download";
const SHA = /^[a-f0-9]{64}$/;

export interface StartUpdateOptions { currentVersion: string; requestedVersion: string | null; dataDir: string; target: "darwin-arm64" | "windows-amd64"; cliPath: string; }

export async function resolveUpdate(options: StartUpdateOptions, fetchImpl: typeof fetch = fetch) {
  const registry = await fetchWithTimeout(fetchImpl, REGISTRY_URL);
  if (!registry.ok) throw new Error("unable to check npm latest");
  const latest = (await registry.json() as { version?: unknown }).version;
  if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("npm latest is not a stable AgentRoam version");
  if (options.requestedVersion && options.requestedVersion !== latest) throw new Error("requested version is not the current npm latest");
  if (compare(latest, options.currentVersion) <= 0) throw new Error("AgentRoam is already up to date");
  const response = await fetchWithTimeout(fetchImpl, `${RELEASE_BASE}/v${latest}/release-manifest.json`);
  if (!response.ok) throw new Error("release manifest is unavailable");
  const manifest = await response.json() as any;
  const asset = manifest?.installers?.cli?.[options.target];
  const fileName = options.target === "darwin-arm64" ? "install-agentroam.sh" : "install-agentroam.ps1";
  if (manifest?.schemaVersion !== 2 || manifest.version !== latest || manifest.channel !== "latest" || asset?.fileName !== fileName || !SHA.test(asset?.sha256 ?? "")) {
    throw new Error("release manifest is invalid for this platform");
  }
  return { targetVersion: latest, fileName, sha256: asset.sha256 as string };
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
