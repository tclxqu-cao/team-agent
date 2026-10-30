import { setTimeout as delay } from "node:timers/promises";
import type { CliOptions } from "./args.js";
import { resolveApprovalInput, terminalText } from "./device-pairing.js";
import { localServiceRequest } from "./local-service-request.js";
import { DesktopAuthorizationInterrupted, DesktopAuthorizationPrompt, withAuthorizationSignal } from "./desktop-authorization-prompt.js";
import { withCliProgress, withoutCliProgress } from "../bin/cli-progress.mjs";

const endpoint = "/api/remote-authorization";
export interface DesktopAuthorizationStatus {
  local: boolean;
  platform: NodeJS.Platform;
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  screen: boolean;
  accessibility: boolean;
  online: boolean;
  error: string | null;
  component?: { name: string; path: string; version: string; updatePending?: boolean; pendingVersion?: string };
}
type Permission = "screen" | "accessibility";
interface AuthorizationBody {
  action: "request-permission" | "enable" | "disable" | "recheck";
  permission?: Permission;
}
export interface DesktopAuthorizationContext {
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  log?: (message: string) => void;
  confirm?: () => Promise<boolean>;
  request?: (dataDir: string, body?: AuthorizationBody, signal?: AbortSignal) => Promise<DesktopAuthorizationStatus>;
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: NodeJS.ReadableStream | null;
}

async function requestAuthorization(dataDir: string, body?: AuthorizationBody, signal?: AbortSignal): Promise<DesktopAuthorizationStatus> {
  const status = await localServiceRequest<DesktopAuthorizationStatus>(dataDir, endpoint, {
    method: body ? "POST" : "GET", body, signal, timeoutMs: body?.action === "request-permission" ? 135_000 : 30_000,
  });
  if (status.local !== true || typeof status.supported !== "boolean" || typeof status.installed !== "boolean"
    || typeof status.enabled !== "boolean" || typeof status.screen !== "boolean" || typeof status.accessibility !== "boolean"
    || typeof status.online !== "boolean" || typeof status.platform !== "string"
    || (status.error !== null && typeof status.error !== "string")) {
    throw new Error("Invalid local authorization status. Upgrade the CLI and retry");
  }
  return status;
}

function recoveryHint(log: (line: string) => void): void {
  log("Authorize later: agentroam desktop authorize, or use the Remote Authorization panel in a local browser.");
}

function stalePermissionHint(permission: Permission, log: (line: string) => void): void {
  const service = permission === "screen" ? "ScreenCapture" : "Accessibility";
  log("If System Settings already shows AgentRoam Remote Desktop as enabled, macOS may still be using a grant for an older component signature.");
  log(`Manual repair only after closing other AgentRoam instances: /usr/bin/tccutil reset ${service} com.agentroam.remote-desktop; then rerun agentroam desktop authorize.`);
}

function reportComponent(status: DesktopAuthorizationStatus, log: (line: string) => void): void {
  if (!status.component) return;
  const component = status.component;
  log(`Remote desktop component: ${terminalText(component.version === 'legacy' ? 'legacy (version unknown)' : component.version)}`);
  log(`${status.platform === 'win32' ? 'Component path' : 'Authorization app path'}: ${terminalText(component.path)}`);
  if (component.updatePending) log('An older component is still in use. Stop desktop sharing in other AgentRoam instances, then authorize again to update.');
}

function complete(status: DesktopAuthorizationStatus): boolean {
  return status.enabled && status.screen && status.accessibility && !status.error;
}

/** Request permissions without enabling sharing, then verify before activation. */
export async function authorizeRemoteDesktop(dataDir: string, context: DesktopAuthorizationContext = {}): Promise<boolean> {
  const log = context.log ?? console.log;
  if (!(context.isTTY ?? process.stdout.isTTY === true)) {
    log("No interactive terminal detected. Remote desktop authorization skipped.");
    recoveryHint(log);
    return false;
  }
  const request = context.request ?? requestAuthorization;
  const input = context.input === undefined ? resolveApprovalInput({ interactive: true }) : context.input ?? undefined;
  const prompt = new DesktopAuthorizationPrompt({ input, ownsInput: context.input === undefined && input !== process.stdin,
    signal: context.signal, timeoutMs: context.timeoutMs ?? 60_000, log });
  const run = <T>(operation: () => Promise<T>): Promise<T> => withAuthorizationSignal(operation, prompt.signal);
  let reportedComponent = '';
  const check = async (body?: AuthorizationBody): Promise<DesktopAuthorizationStatus> => {
    const status = await run(() => request(dataDir, body, prompt.signal));
    const identity = JSON.stringify(status.component) ?? '';
    if (identity !== reportedComponent) { reportComponent(status, log); reportedComponent = identity; }
    return status;
  };
  log("Remote desktop authorization is optional. Type s and Enter or press Ctrl+C to skip; you can authorize later.");
  try {
    let status = await withCliProgress("Checking local remote desktop permissions", () => check());
    if (!status.supported) throw new Error("Remote desktop requires Apple Silicon with macOS 14 or later, or Windows 10/11 x64");
    if (!status.installed) throw new Error("This CLI does not include the authorization component. Upgrade the CLI");
    if (status.enabled) {
      status = await check({ action: "recheck" });
      if (complete(status)) { log("✓ Remote desktop authorized and sharing enabled."); return true; }
    }
    const platform = context.platform ?? process.platform;
    const confirm = context.confirm ?? (() => prompt.confirm());
    const confirmed = await withoutCliProgress(() => run(confirm));
    if (!confirmed) {
      log("Remote desktop authorization skipped.");
      recoveryHint(log);
      return false;
    }
    status = await check({ action: "recheck" });
    const wait = context.wait ?? ((milliseconds: number) => delay(milliseconds, undefined, { signal: prompt.signal }));
    if (platform === "darwin") {
      for (const permission of ["screen", "accessibility"] as const) {
        if (status[permission]) continue;
        const name = permission === "screen" ? "Screen Recording" : "Accessibility";
        // TCC grants belong to the bundle ID across all installed runtimes.
        // A false probe here must never revoke another runtime's permission.
        log(`Requesting ${name} permission. Allow AgentRoam Remote Desktop in System Settings...`);
        status = await withCliProgress(`Waiting for ${name} permission; type s and Enter to skip`, async () => {
          let current = await check({ action: "request-permission", permission });
          for (let attempt = 0; !current[permission] && attempt < (context.pollAttempts ?? 60); attempt++) {
            await run(() => wait(2000));
            current = await check({ action: "recheck" });
          }
          return current;
        });
        if (!status[permission]) {
          log(`${name} permission was not granted. Sharing was not enabled.`);
          stalePermissionHint(permission, log);
          recoveryHint(log);
          return false;
        }
      }
    }
    if (!status.screen || !status.accessibility) {
      log("Remote desktop is unavailable. Check system permissions and desktop state. Sharing was not enabled.");
      recoveryHint(log);
      return false;
    }
    status = await withCliProgress("Enabling and checking remote desktop sharing", () => check({ action: "enable" }));
    if (!complete(status)) throw new Error(status.error ? terminalText(status.error) : "Remote desktop sharing is not ready. Check system permissions");
    log("✓ Remote desktop authorization complete; sharing enabled. Your phone still needs device pairing on first connection.");
    return true;
  } catch (error) {
    if (!prompt.signal.aborted) throw error;
    log(prompt.signal.reason instanceof DesktopAuthorizationInterrupted ? prompt.signal.reason.message : "Remote desktop authorization cancelled.");
    recoveryHint(log);
    return false;
  } finally { prompt.close(); }
}

export async function runDesktopCommand(options: CliOptions, context: DesktopAuthorizationContext = {}): Promise<void> {
  const log = context.log ?? console.log;
  const request = context.request ?? requestAuthorization;
  if (options.desktopAction === "authorize") {
    try {
      if (!await authorizeRemoteDesktop(options.dataDir, context)) process.exitCode = 1;
    } catch (error) {
      recoveryHint(log);
      throw error;
    }
    return;
  }
  let status = await request(options.dataDir);
  if (options.desktopAction === "disable") {
    status = await request(options.dataDir, { action: "disable" });
    if (status.enabled) throw new Error("Remote desktop sharing is still enabled. Retry");
    log("✓ Remote desktop sharing disabled; system permissions retained. Enable again: agentroam desktop authorize");
    return;
  }
  if (status.supported && status.installed) status = await request(options.dataDir, { action: "recheck" });
  reportComponent(status, log);
  log(`Remote desktop: ${status.supported ? "supported" : "unsupported"}; sharing: ${status.enabled ? "enabled" : "disabled"}; Screen Recording: ${status.screen ? "granted" : "not granted or desktop unavailable"}; Accessibility: ${status.accessibility ? "granted" : "not granted"}`);
  if (status.error) log(`Status: ${terminalText(status.error)}`);
  recoveryHint(log);
}
