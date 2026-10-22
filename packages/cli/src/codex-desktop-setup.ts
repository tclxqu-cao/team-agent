import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import type { CliOptions } from "./args.js";
import { runCodexDesktopCommand } from "./codex-desktop-command.js";
import { inspectCodexDesktop, type DesktopSnapshot } from "./codex-desktop-status.js";
import type { ServiceConfig } from "./service/service-files.js";
import { configureCodexSharing, inspectCodexSharing } from "./codex-sharing.js";
import { withoutCliProgress } from "../bin/cli-progress.mjs";
import { runWindowsCodexDesktop } from "./codex-desktop-windows.js";

interface DesktopSetupContext {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  service?: ServiceConfig;
  inspect?: typeof inspectCodexDesktop;
  configureSharing?: typeof configureCodexSharing;
  inspectSharing?: typeof inspectCodexSharing;
  launch?: (options: CliOptions, environment: NodeJS.ProcessEnv) => Promise<void>;
  confirm?: (question: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export async function setupCodexDesktop(options: CliOptions, context: DesktopSetupContext = {}): Promise<void> {
  if ((context.platform ?? process.platform) === "win32") {
    const inherited = context.environment ?? process.env;
    const environment: NodeJS.ProcessEnv = { ...inherited, AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE: "1" };
    if (context.service?.dataDir === options.dataDir) {
      if (!environment.CODEX_HOME && context.service.codexHome) environment.CODEX_HOME = context.service.codexHome;
      if (!environment.AGENT_CODEX_BIN && context.service.codexPath) environment.AGENT_CODEX_BIN = context.service.codexPath;
    }
    const result = await runWindowsCodexDesktop(options, { environment, log: context.log });
    if (result.state === "independent" && inherited.AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE !== "1") {
      const answer = await withoutCliProgress(() => (context.confirm ?? confirmDesktopRestart)("Force restart Codex Desktop? Running tasks and unsent input may be lost [y/N]: "));
      if (/^(y|yes)$/i.test(answer?.trim() ?? "")) await runWindowsCodexDesktop({ ...options, desktopSetup: false, desktopRestart: true }, { environment, log: context.log });
    }
    return;
  }
  if ((context.platform ?? process.platform) !== "darwin") return;
  const log = context.log ?? console.log;
  const environment = { ...(context.environment ?? process.env) };
  if (context.service?.dataDir === options.dataDir) {
    if (!environment.CODEX_HOME && context.service.codexHome) environment.CODEX_HOME = context.service.codexHome;
    if (!environment.AGENT_CODEX_BIN && context.service.codexPath) environment.AGENT_CODEX_BIN = context.service.codexPath;
  }
  const inspect = context.inspect ?? inspectCodexDesktop;
  const deferred = () => log("Current Codex Desktop preserved. Scan to connect to AgentRoam; existing desktop sessions are not shared yet. Run agentroam codex-desktop --setup later.");
  try {
    await (context.configureSharing ?? configureCodexSharing)(options, { environment });
    log("Saved shared backend and background recovery settings. Use the avatar menu to switch if Desktop starts independently.");
    if ((await (context.inspectSharing ?? inspectCodexSharing)({ environment })).state === "shared") {
      log("Codex Desktop already uses the shared backend; no restart needed.");
      return;
    }
    let snapshot = await inspect(environment);
    if (snapshot.status === "not-installed") {
      log("Codex Desktop is not installed. Continuing with phone pairing.");
      return;
    }
    if (snapshot.status === "stopped") {
      log("Shared backend configured. Codex Desktop remains closed; open it normally when needed.");
      return;
    }
    const original = snapshot;
    let restartConfirmed = false;
    if (snapshot.status === "running" && snapshot.activity.state === "idle") {
      // Read every loaded thread again immediately before choosing automatic restart.
      snapshot = await inspect(environment);
      if (!sameDesktop(original, snapshot)) { log("Desktop process changed. Preserving Desktop."); deferred(); return; }
    }
    if (snapshot.status === "running" && snapshot.activity.state !== "idle") {
      const reason = snapshot.activity.state === "busy"
        ? `Codex Desktop has ${snapshot.activity.activeCount} active sessions.`
        : "Cannot reliably confirm that all Codex Desktop tasks have finished.";
      log(reason);
      if (environment.AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE === "1") {
        log(JSON.stringify({ codexSharingAction: "confirmation-required" }));
        deferred();
        return;
      }
      const answer = await withoutCliProgress(() => (context.confirm ?? confirmDesktopRestart)("Force restart Desktop now to share sessions? This will interrupt all running desktop tasks and may lose unsent input. No Codex quit dialog will appear. Continue [y/N]: "));
      if (!answer || !/^(?:y|yes)$/i.test(answer.trim())) { deferred(); return; }
      restartConfirmed = true;
      const checked = await inspect(environment);
      if (!sameDesktop(snapshot, checked)) { log("Desktop process changed after confirmation. Preserving Desktop."); deferred(); return; }
      snapshot = checked;
    }
    if (snapshot.status !== "running" && snapshot.status !== "stopped") return;
    environment.CODEX_DESKTOP_APP = snapshot.appPath;
    environment.AGENTROAM_CODEX_DESKTOP_EXPECTED_PID = snapshot.status === "running" ? String(snapshot.pid) : "0";
    if (snapshot.status === "running" && !restartConfirmed) {
      environment.AGENTROAM_CODEX_DESKTOP_IDLE_GUARD = fileURLToPath(new URL("./codex-desktop-idle-guard.js", import.meta.url));
      environment.AGENTROAM_CODEX_DESKTOP_GUARD_NODE = process.execPath;
    } else {
      delete environment.AGENTROAM_CODEX_DESKTOP_IDLE_GUARD;
      delete environment.AGENTROAM_CODEX_DESKTOP_GUARD_NODE;
    }
    const launchOptions: CliOptions = { ...options, command: "codex-desktop", desktopSetup: false,
      desktopDryRun: false, desktopRestart: snapshot.status === "running" };
    log(snapshot.status === "stopped" ? "Starting Codex Desktop and connecting to the shared backend..." : "Reconnecting Codex Desktop to the shared backend...");
    await (context.launch ?? ((args, env) => runCodexDesktopCommand(args, { environment: env, log })))(launchOptions, environment);
    log("Desktop connection attempted. Pairing follows. AgentRoam selects the desktop, shared, or standalone backend based on actual connectivity.");
  } catch (error) {
    log(`Desktop sharing connection incomplete: ${error instanceof Error ? error.message : error}`);
    log("AgentRoam installation continues; scan to connect. Backend fallback: desktop -> shared -> standalone. Existing desktop sharing is unconfirmed. Retry later with agentroam codex-desktop --setup.");
  }
}

function sameDesktop(previous: DesktopSnapshot, current: DesktopSnapshot): boolean {
  return previous.status === "running" && current.status === "running"
    && previous.pid === current.pid && previous.appPath === current.appPath;
}

/** curl | sh owns stdin. Only the controlling terminal can authorize restart. */
export async function confirmDesktopRestart(question: string): Promise<string | null> {
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  let input: ReadStream | undefined;
  let output: WriteStream | undefined;
  let reader: ReturnType<typeof createInterface> | undefined;
  try {
    inputFd = openSync("/dev/tty", "r");
    outputFd = openSync("/dev/tty", "w");
    input = new ReadStream(inputFd);
    output = new WriteStream(outputFd);
    reader = createInterface({ input, output, terminal: true });
    const prompt = reader;
    return await new Promise<string | null>((resolve) => {
      prompt.once("close", () => resolve(null));
      prompt.once("SIGINT", () => resolve(null));
      input!.once("error", () => resolve(null));
      output!.once("error", () => resolve(null));
      prompt.question(question, resolve);
    });
  } catch {
    return null;
  } finally {
    reader?.close();
    if (input) input.destroy(); else if (inputFd !== undefined) closeSync(inputFd);
    if (output) output.destroy(); else if (outputFd !== undefined) closeSync(outputFd);
  }
}
