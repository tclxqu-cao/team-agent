import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createReadStream, openSync } from "node:fs";
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
    const message = error.status === 423 ? "远程访问已锁定，请先执行 agentroam unlock" : error.status === 410 ? "请求已过期或已处理" : error.status === 409 ? "核对短语不匹配" : `设备授权操作失败 (HTTP ${error.status})`;
    throw new Error(message);
  }
}

export function terminalText(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ""); }

export function pairingQrPayload(accessUrl: string, grant: string): string {
  const url = new URL(accessUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(grant)) throw new Error("无效的配对地址或授权凭据");
  return `${url.origin}/pair#pair=${grant}`;
}

export async function printPairingCode(dataDir: string, log: (line: string) => void = console.log, options: { interactive?: boolean; signal?: AbortSignal; accessUrl?: string; qr?: boolean } = {}): Promise<void> {
  const result = await withCliProgress("正在生成设备配对码", () => pairingAdmin<PairingCode>(dataDir, "code"));
  log(`配对码：${result.code.slice(0, 4)} ${result.code.slice(4)}`);
  log("5 分钟内有效，仅可使用一次。手机输入后仍需在电脑上确认核对短语。");
  if ((options.qr ?? true) && (options.interactive ?? process.stdout.isTTY)) {
    const accessUrl = options.accessUrl ?? await readFile(join(dataDir, "tunnel.url"), "utf8").then((value) => value.trim(), () => null);
    if (accessUrl) {
      // Validate the public address before minting an invitation. Never persist the grant.
      pairingQrPayload(accessUrl, "a".repeat(43));
      const qr = await withCliProgress("正在生成手机连接二维码", async () => {
        const { grant } = await pairingAdmin<{ grant: string }>(dataDir, "qr");
        return renderQr(pairingQrPayload(accessUrl, grant));
      });
      log("手机扫码直接连接（5 分钟、一次有效，请勿分享截图）：");
      log(qr);
    } else log("生成 App 授权二维码：agentroam pair --url <手机可访问的服务器地址>");
  }
  const approvalInput = resolveApprovalInput(options);
  if (approvalInput) {
    await withCliProgress("正在等待手机扫码或输入配对码", () => watchPairingApproval(dataDir, result.expiresAt, { log, signal: options.signal, input: approvalInput }));
  } else log("查看请求：agentroam approvals；批准：agentroam approve <请求ID> --phrase <手机核对短语>");
}

/** Open the controlling terminal (`/dev/tty`) — the same source install-agentroam.sh reads from. */
function openControllingTerminal(): NodeJS.ReadableStream | undefined {
  if (process.platform === "win32") return undefined;
  let fd: number;
  try { fd = openSync("/dev/tty", "r"); } catch { return undefined; }
  return createReadStream("/dev/tty", { fd, autoClose: true });
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
  log("等待手机发起连接…");
  while (Date.now() < codeExpiresAt && !options.signal?.aborted) {
    const result = await admin<{ requests: PendingPairing[]; locked: boolean; qrClaimed?: boolean }>(dataDir, "requests");
    if (result.locked) { log("远程访问已锁定"); return; }
    if (result.qrClaimed) { log("App 已扫码连接。"); return; }
    const request = result.requests.find((r) => r.created >= codeExpiresAt - 300_000);
    if (request) {
      log(`新设备请求连接：${terminalText(request.name)}`);
      log(`请求 ID：${request.id}`);
      log(`核对短语：${request.phrase}`);
      const confirm = options.confirm ?? ((request: PendingPairing, signal?: AbortSignal) => confirmOnTerminal(request, signal, options.input));
      const approved = await withoutCliProgress(() => confirm(request, options.signal));
      if (options.signal?.aborted) return;
      if (Date.now() >= request.expires) { log("授权请求已过期，请重新配对。"); return; }
      await admin(dataDir, approved ? "approve" : "deny", { id: request.id, ...(approved ? { phrase: request.phrase } : {}) });
      log(approved ? "已批准，手机将自动进入。" : "已拒绝此设备。");
      return;
    }
    try { await delay(800, undefined, { signal: options.signal }); } catch { return; }
  }
  if (!options.signal?.aborted) log("配对码已过期，执行 agentroam pair 生成新码。");
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
    const answer = await input.question("确认手机显示相同短语？输入 yes 批准，其他输入拒绝：", { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
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
