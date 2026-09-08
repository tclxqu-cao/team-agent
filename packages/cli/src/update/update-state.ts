import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type DurableUpdatePhase = "downloading" | "installing" | "reconnecting" | "complete" | "failed";
export interface DurableUpdateState {
  schemaVersion: 1;
  phase: DurableUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  dataDir: string;
  roots: string[];
  port: number | null;
  relay: "auto" | "cloudflare" | "pinggy" | "custom";
  tunnelCommand: string | null;
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
