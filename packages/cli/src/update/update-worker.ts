import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { acquireUpdateLock, readUpdateState, sanitizeUpdateError, updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";
import { buildCliInstallScriptUrl } from "./update-install.js";
import { createController } from "../service/service-command.js";
import { readServiceConfig, resolveServicePaths, type ServiceConfig } from "../service/service-files.js";
import { compareAgentRoamVersions } from "./update-channel.js";

export async function runUpdateWorker(stateFile: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const initial = await readUpdateState(stateFile);
  if (!initial) throw new Error("update state is missing");
  const paths = updatePaths(initial.dataDir);
  const pending = dirname(resolve(stateFile)) === paths.directory && /^request-[a-f0-9-]{36}\.json$/.test(basename(stateFile));
  if (resolve(stateFile) !== paths.stateFile && !pending) throw new Error("update state is outside the data directory");
  let releaseLock: (() => Promise<void>) | undefined;
  let temporary: string | undefined;
  let accepted = false;
  let state = initial;
  const update = async (next: Partial<DurableUpdateState>) => {
    state = { ...state, ...next, updatedAt: Date.now() };
    await writeUpdateState(paths.stateFile, state);
  };
  try {
    releaseLock = await acquireUpdateLock(paths.lockFile);
    const previous = await readServiceConfig(resolveServicePaths(undefined, state.dataDir));
    if (previous) {
      if (resolve(previous.dataDir) !== state.dataDir) throw new Error("AgentRoam service uses a different data directory");
      if (compareAgentRoamVersions(state.targetVersion, previous.version) <= 0) throw new Error("AgentRoam service is already up to date");
    }
    await update({});
    if (pending) await unlink(stateFile);
    process.send?.({ started: true });
    accepted = true;
    const url = buildCliInstallScriptUrl(state.fileName);
    temporary = await mkdtemp(resolve(paths.directory, "installer-"));
    const installer = resolve(temporary, state.fileName);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("installer download failed");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(installer, { flags: "wx", mode: 0o700 }));
    const actual = createHash("sha256").update(await readFile(installer)).digest("hex");
    if (actual !== state.sha256) throw new Error("installer checksum mismatch");
    await update({ phase: "installing" });
    const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
    // 用 AGENTROAM_VERSION 钉住版本，而不是让安装脚本自己解析 dist-tag：
    // 一是装的必须正是检查阶段向用户承诺的那一版，二是下一步要按
    // launcher/<targetVersion> 定位入口，版本漂了就找不到。
    const code = await run(command, args, {
      ...process.env,
      AGENTROAM_VERSION: state.targetVersion,
      AGENTROAM_DATA_DIR: state.dataDir,
      AGENTROAM_ROOT: state.roots[0],
      AGENTROAM_INSTALL_SKIP_SERVICE: "1",
      AGENTROAM_INSTALL_DESKTOP: "no",
      AGENTROAM_INSTALL_REMOTE_DESKTOP: "skip",
    });
    if (code !== 0) throw new Error(`installer exited with code ${code}`);
    const nextEntry = resolve(state.dataDir, "launcher", state.targetVersion, "node_modules", "agentroam", "bin", "agentroam.mjs");
    await update({ phase: "reconnecting" });
    await activateService(state, nextEntry, previous);
    await update({ phase: "complete", message: `AgentRoam ${state.targetVersion} installed` });
  } catch (error) {
    const message = sanitizeUpdateError(error);
    if (accepted) await update({ phase: "failed", message });
    if (!accepted) process.send?.({ started: false, error: message });
    throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    if (pending) await unlink(stateFile).catch(() => undefined);
    await releaseLock?.();
  }
}

async function activateService(update: DurableUpdateState, nextEntry: string, previous: ServiceConfig | null): Promise<void> {
  if (!previous) {
    const args = [nextEntry, "service", "install"];
    for (const root of update.roots) args.push("--root", root);
    args.push("--data-dir", update.dataDir, "--relay", update.relay, "--no-qr");
    if (update.port) args.push("--port", String(update.port));
    if (update.tunnelCommand) args.push("--tunnel-command", update.tunnelCommand);
    if (update.relayUrl) args.push("--relay-url", update.relayUrl);
    if (update.localOnly) args.push("--local-only");
    const code = await run(process.execPath, args, { ...process.env, AGENTROAM_INSTALL_REMOTE_DESKTOP: "skip" });
    if (code !== 0) throw new Error(`service activation exited with code ${code}`);
    return;
  }
  const controller = createController(process.platform);
  try {
    const { state } = await controller.install({ ...previous, cliPath: nextEntry, version: update.targetVersion, installedAt: new Date().toISOString() });
    if (state?.status !== "ready" || state.version !== update.targetVersion) throw new Error("new CLI service did not become ready");
  } catch {
    const restored = await controller.install(previous).catch(() => null);
    if (restored?.state?.status === "ready" && restored.state.version === previous.version) throw new Error("新版服务启动失败，已恢复原服务");
    throw new Error("新版服务启动失败，原服务恢复未确认，请查看 AgentRoam 服务日志");
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolveRun);
  });
}
