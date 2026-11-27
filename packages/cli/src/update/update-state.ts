import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RelayMode } from "../args.js";

export type DurableUpdatePhase = "downloading" | "installing" | "reconnecting" | "complete" | "failed";
export interface DurableUpdateState {
  schemaVersion: 1;
  phase: DurableUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  dataDir: string;
  roots: string[];
  port: number | null;
  relay: RelayMode;
  tunnelCommand: string | null;
  relayUrl?: string;
  localOnly: boolean;
  fileName: string;
  sha256: string;
  cliPath: string;
  updatedAt: number;
  message?: string;
}

export function updatePaths(dataDir: string) {
  const directory = resolve(dataDir, "updates");
  return { directory, stateFile: resolve(directory, "state.json"), lockFile: resolve(directory, "update.lock") };
}

export async function readUpdateState(path: string): Promise<DurableUpdateState | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as DurableUpdateState;
    return value?.schemaVersion === 1 ? value : null;
  } catch { return null; }
}

const UPDATE_PHASE_LABELS: Record<DurableUpdatePhase, string> = {
  downloading: "正在下载",
  installing: "正在安装",
  reconnecting: "正在启动新版服务",
  complete: "更新已完成",
  failed: "更新失败",
};

export function formatUpdateStatus(state: DurableUpdateState): string {
  const label = UPDATE_PHASE_LABELS[state.phase] ?? "更新状态未知";
  const detail = state.phase === "failed" && state.message ? ` · ${state.message}` : "";
  return `AgentRoam CLI ${state.currentVersion} → ${state.targetVersion} · ${label}${detail}`;
}

export async function writeUpdateState(path: string, state: DurableUpdateState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function acquireUpdateLock(path: string, now = Date.now()): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n${now}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = now - (await stat(path)).mtimeMs;
    if (age <= 30 * 60 * 1_000) throw new Error("an AgentRoam update is already running");
    await unlink(path);
    return acquireUpdateLock(path, now);
  }
  return async () => { await unlink(path).catch(() => undefined); };
}

export function sanitizeUpdateError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[A-Za-z]:\\[^\s]+|\/(?:Users|home|var|tmp)\/[^\s]+/g, "<path>").slice(0, 300);
}
