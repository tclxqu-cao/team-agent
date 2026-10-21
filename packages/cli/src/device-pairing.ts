import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderQr } from "./qr.js";
import { localServiceRequest, LocalServiceHttpError } from "./local-service-request.js";
import { withCliProgress, withoutCliProgress } from "../bin/cli-progress.mjs";

export interface PairedDevice { id: string; name: string; created: number; seen: number; expires: number }
export interface PendingPairing { id: string; name: string; phrase: string; created: number; expires: number; status: string }
export type PairingAction = "code" | "qr" | "devices" | "revoke" | "requests" | "approve" | "deny" | "lock" | "unlock" | "audit";
export interface PairingCode { code: string; expiresAt: number }

/** Resolve a private local descriptor; never send the administrative token to a tunnel URL. */
export async function pairingAdmin<T>(dataDir: string, action: PairingAction, body?: unknown, options: { registry?: string; request?: typeof fetch } = {}): Promise<T> {
  const readOnly = ["devices", "requests", "audit"].includes(action);
  try {
    return await localServiceRequest<T>(dataDir, `/api/pairing/admin/${action}`, {
      ...options, method: readOnly ? "GET" : "POST", ...(readOnly ? {} : { body: body ?? {} }),
    });
  } catch (error) {
    if (!(error instanceof LocalServiceHttpError)) throw error;
    const message = error.status === 423 ? "Remote access is locked. Run agentroam unlock first" : error.status === 410 ? "Request expired or already handled" : error.status === 409 ? "Verification phrase does not match" : `Device authorization failed (HTTP ${error.status})`;
    throw new Error(message);
  }
}

export function terminalText(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ""); }

export function pairingQrPayload(accessUrl: string, grant: string): string {
  const url = new URL(accessUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(grant)) throw new Error("Invalid pairing URL or authorization grant");
  return `${url.origin}/pair#pair=${grant}`;
}

export async function printPairingCode(dataDir: string, log: (line: string) => void = console.log, options: { interactive?: boolean; signal?: AbortSignal; accessUrl?: string; qr?: boolean } = {}): Promise<void> {
  const result = await withCliProgress("Generating device pairing code", () => pairingAdmin<PairingCode>(dataDir, "code"));
  log(`Pairing code: ${result.code.slice(0, 4)} ${result.code.slice(4)}`);
  log("Valid for 5 minutes, single use. After entering it on your phone, confirm the verification phrase on this computer.");
  if ((options.qr ?? true) && (options.interactive ?? process.stdout.isTTY)) {
    const accessUrl = options.accessUrl ?? await readFile(join(dataDir, "tunnel.url"), "utf8").then((value) => value.trim(), () => null);
    if (accessUrl) {
      // Validate the public address before minting an invitation. Never persist the grant.
      pairingQrPayload(accessUrl, "a".repeat(43));
      const qr = await withCliProgress("Generating phone connection QR code", async () => {
        const { grant } = await pairingAdmin<{ grant: string }>(dataDir, "qr");
        return renderQr(pairingQrPayload(accessUrl, grant));
      });
      log("Scan with your phone to connect (valid for 5 minutes, single use; do not share screenshots):");
      log(qr);
    } else log("Generate an app authorization QR code: agentroam pair --url <phone-accessible-server-url>");
  }
  const approvalInput = resolveApprovalInput(options);
  if (approvalInput) {
    await withCliProgress("Waiting for your phone to scan or enter the pairing code", () => watchPairingApproval(dataDir, result.expiresAt, { log, signal: options.signal, input: approvalInput }));
  } else log("View requests: agentroam approvals; approve: agentroam approve <request-id> --phrase <phone-verification-phrase>");
}

/** Open the controlling terminal (`/dev/tty`) — the same source install-agentroam.sh reads from. */
function openControllingTerminal(): NodeJS.ReadableStream | undefined {
  if (process.platform === "win32") return undefined;
  let fd: number;
  try { fd = openSync("/dev/tty", "r"); } catch { return undefined; }
  // Use libuv's cancellable TTY handle. A filesystem read on /dev/tty can keep
  // the process alive after destroy(), waiting for one more line of input.
  return new ReadStream(fd);
}

/**
 * Pick the stream the approval phrase is read from.
 *
 * Never fall back to `process.stdin` when it is not a TTY: the installer runs as
 * `curl … | sh`, so stdin is *the install script itself*. Reading it consumes
 * the rest of the install, echoes it back to the terminal, and answers the
 * prompt with the next script line instead of the user's "yes" — which silently
 * rejects the device and swallows the remaining install steps.
 */
export function resolveApprovalInput(context: {
  interactive?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  openTerminal?: () => NodeJS.ReadableStream | undefined;
} = {}): NodeJS.ReadableStream | undefined {
  const stdinIsTTY = context.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = context.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!(context.interactive ?? (stdinIsTTY && stdoutIsTTY))) return undefined;
  if (stdinIsTTY) return process.stdin;
  return (context.openTerminal ?? openControllingTerminal)();
}

/** Watch only while the printed code is usable; approval gets the request's own deadline. */
export async function watchPairingApproval(dataDir: string, codeExpiresAt: number, options: {
  log?: (line: string) => void;
  signal?: AbortSignal;
  admin?: typeof pairingAdmin;
  confirm?: (request: PendingPairing, signal?: AbortSignal) => Promise<boolean>;
  /** Terminal the phrase is read from; see {@link resolveApprovalInput}. */
  input?: NodeJS.ReadableStream;
} = {}): Promise<void> {
  const admin = options.admin ?? pairingAdmin;
  const log = options.log ?? console.log;
  log("Waiting for your phone to connect...");
  while (Date.now() < codeExpiresAt && !options.signal?.aborted) {
    const result = await admin<{ requests: PendingPairing[]; locked: boolean; qrClaimed?: boolean }>(dataDir, "requests");
    if (result.locked) { log("Remote access is locked"); return; }
    if (result.qrClaimed) { log("App connected via QR code."); return; }
    const request = result.requests.find((r) => r.created >= codeExpiresAt - 300_000);
    if (request) {
      log(`New device connection request: ${terminalText(request.name)}`);
      log(`Request ID: ${request.id}`);
      log(`Verification phrase: ${request.phrase}`);
      const confirm = options.confirm ?? ((request: PendingPairing, signal?: AbortSignal) => confirmOnTerminal(request, signal, options.input));
      const approved = await withoutCliProgress(() => confirm(request, options.signal));
      if (options.signal?.aborted) return;
      if (Date.now() >= request.expires) { log("Authorization request expired. Please pair again."); return; }
      await admin(dataDir, approved ? "approve" : "deny", { id: request.id, ...(approved ? { phrase: request.phrase } : {}) });
      log(approved ? "Approved. Your phone will connect automatically." : "Device rejected.");
      return;
    }
    try { await delay(800, undefined, { signal: options.signal }); } catch { return; }
  }
  if (!options.signal?.aborted) log("Pairing code expired. Run agentroam pair to generate a new code.");
}

async function confirmOnTerminal(request: PendingPairing, signal?: AbortSignal, terminal = resolveApprovalInput()): Promise<boolean> {
  // A piped stdin is the install script, and a closed one can never answer.
  if (!terminal || (terminal === process.stdin && process.stdin.isTTY !== true)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, request.expires - Date.now()));
  // Read the terminal in canonical mode: the tty echoes the keystrokes itself,
  // so letting readline echo them again would double every character.
  const input = createInterface(terminal === process.stdin
    ? { input: terminal, output: process.stdout }
    : { input: terminal, output: process.stdout, terminal: false });
  input.once("SIGINT", () => controller.abort());
  try {
    const answer = await input.question("Does your phone show the same phrase? Type yes to approve, anything else to reject: ", { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    return answer.trim().toLowerCase() === "yes";
  } catch { return false; }
  finally { clearTimeout(timer); input.close(); }
}

export async function installedDataDir(fallback: string): Promise<string> {
  if (resolve(fallback) !== resolve(homedir(), ".agentroam")) return fallback;
  try {
    const config = JSON.parse(await readFile(join(homedir(), ".agentroam", "service", "config.json"), "utf8"));
    return typeof config.dataDir === "string" ? resolve(config.dataDir) : fallback;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
