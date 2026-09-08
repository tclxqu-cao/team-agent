import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, readFile, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { acquireUpdateLock, readUpdateState, sanitizeUpdateError, updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";

const RELEASE_BASE = "https://gitee.com/caoqu/team-agent/releases/download";

export async function runUpdateWorker(stateFile: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const initial = await readUpdateState(stateFile);
  if (!initial) throw new Error("update state is missing");
  const paths = updatePaths(initial.dataDir);
  if (resolve(stateFile) !== paths.stateFile) throw new Error("update state is outside the data directory");
  const releaseLock = await acquireUpdateLock(paths.lockFile);
  const partial = resolve(paths.directory, `${basename(initial.fileName)}.partial`);
  let state = initial;
  const update = async (next: Partial<DurableUpdateState>) => {
    state = { ...state, ...next, updatedAt: Date.now() };
    await writeUpdateState(stateFile, state);
  };
  try {
    const response = await fetchImpl(`${RELEASE_BASE}/v${state.targetVersion}/${encodeURIComponent(state.fileName)}`);
    if (!response.ok || !response.body) throw new Error("installer download failed");
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(partial, { mode: 0o700 }));
    const actual = createHash("sha256").update(await readFile(partial)).digest("hex");
    if (actual !== state.sha256) throw new Error("installer checksum mismatch");
    await chmod(partial, 0o700).catch(() => undefined);
    await update({ phase: "installing" });
    const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", partial] : [partial];
    const code = await run(command, args, { ...process.env, AGENTROAM_DATA_DIR: state.dataDir, AGENTROAM_ROOT: state.roots[0], AGENTROAM_INSTALL_SKIP_SERVICE: "1" });
    if (code !== 0) throw new Error(`installer exited with code ${code}`);
    const nextEntry = resolve(state.dataDir, "launcher", state.targetVersion, "node_modules", "agentroam", "bin", "agentroam.mjs");
    const serviceArgs = [nextEntry, "service", "install"];
    for (const root of state.roots) serviceArgs.push("--root", root);
    serviceArgs.push("--data-dir", state.dataDir, "--relay", state.relay, "--no-qr");
    if (state.port) serviceArgs.push("--port", String(state.port));
    if (state.tunnelCommand) serviceArgs.push("--tunnel-command", state.tunnelCommand);
    if (state.localOnly) serviceArgs.push("--local-only");
    await update({ phase: "reconnecting" });
    const serviceCode = await run(process.execPath, serviceArgs, process.env);
    if (serviceCode !== 0) throw new Error(`service activation exited with code ${serviceCode}`);
    await update({ phase: "complete", message: `AgentRoam ${state.targetVersion} installed` });
  } catch (error) {
    await update({ phase: "failed", message: sanitizeUpdateError(error) });
    throw error;
  } finally {
    await unlink(partial).catch(() => undefined);
    await releaseLock();
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolveRun);
  });
}
