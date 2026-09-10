import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cdpCookieToElectronDetails, cookiesBelongingToHosts, type CdpCookie, type ElectronCookieDetails } from "./cookie-migration.js";

export const GOOGLE_REAUTH_TEMP_PREFIX = "google-reauth-";

export type GoogleReauthStatus = "synchronized" | "waiting" | "canceled" | "timeout" | "failed" | "unavailable";

export interface GoogleReauthResult {
  status: GoogleReauthStatus;
  /** 稳定错误类别；绝不含 cookie 值、URL 查询串或密钥材料 */
  reason?: string;
}

export interface GoogleReauthRequest {
  siteId: string;
  /** 提供方配置的主页 URL（受信任的站点配置，非渲染层回调数据） */
  homeUrl: string;
  /** 登录成功回落的目标提供方 origin，如 https://gemini.google.com */
  successOrigin: string;
  /** 同步成功时的 cookie 写入回调；只在主进程内使用，不跨 IPC */
  onCookies: (details: ElectronCookieDetails[]) => Promise<void>;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): void;
  close(): void;
}

export interface DevToolsEndpoint {
  port: number;
  browserPath: string;
}

export type CdpConnector = (endpoint: DevToolsEndpoint) => Promise<CdpConnection>;

export interface ChromeReauthDeps {
  chromePath: string;
  tempRoot: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  connectCdp?: CdpConnector;
  waitForPortFile?: (path: string, timeoutMs: number) => Promise<DevToolsEndpoint | null>;
}

export function parseDevToolsActivePort(content: string): DevToolsEndpoint | null {
  const [portLine, pathLine] = content.trim().split(/\r?\n/);
  const port = Number(portLine);
  const browserPath = pathLine?.trim() ?? "";
  if (!/^\d+$/.test(portLine ?? "") || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) return null;
  return { port, browserPath };
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 两行都写完才连接：第一行端口，第二行 Chrome 生成的 browser WebSocket 路径。 */
export async function waitForDevToolsPortFile(path: string, timeoutMs: number): Promise<DevToolsEndpoint | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => null);
    const endpoint = content ? parseDevToolsActivePort(content) : null;
    if (endpoint) return endpoint;
    await sleepAsync(150);
  }
  return null;
}

/** 连接本次 Chrome 生成的回环端点；断开时立即结束所有待完成请求。 */
export async function connectBrowserCdp(endpoint: DevToolsEndpoint): Promise<CdpConnection> {
  if (!parseDevToolsActivePort(`${endpoint.port}\n${endpoint.browserPath}`)) throw new Error("invalid-cdp-endpoint");
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`, { handshakeTimeout: 8000 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
  const listeners = new Set<(event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void>();
  const disconnected = () => {
    for (const reply of pending.values()) reply({ error: true });
    pending.clear();
  };
  socket.on("close", disconnected);
  socket.on("error", disconnected);
  socket.on("message", (raw: Buffer) => {
    let message: { id?: number; result?: unknown; error?: unknown; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      pending.get(message.id)?.({ result: message.result, error: message.error });
      pending.delete(message.id);
    } else if (message.method) {
      for (const listener of listeners) listener({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
    }
  });
  return {
    send(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("cdp-disconnected"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp-timeout:${method}`));
        }, 8000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          // CDP 错误可能含页面参数，外层只需要稳定类别。
          if (reply.error) reject(new Error(`cdp-error:${method}`));
          else resolve(reply.result);
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
          if (!error) return;
          pending.get(id)?.({ error: true });
          pending.delete(id);
        });
      });
    },
    onEvent(listener) { listeners.add(listener); },
    close() {
      disconnected();
      socket.close();
    },
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface ActiveReauth {
  request: GoogleReauthRequest;
  connection: CdpConnection | null;
  pageSessions: Set<string>;
  finished: boolean;
  syncing: Promise<GoogleReauthResult> | null;
  settle: (result: GoogleReauthResult) => void;
}

/**
 * 使用系统 Chrome 的一次性私有 Profile 登录。用户完成登录后明确点击同步，
 * 不将提供方首页、OAuth 回跳或任意 Cookie 的存在推断为认证成功。
 */
export class ChromeReauthController {
  private active: ActiveReauth | null = null;

  constructor(private readonly deps: ChromeReauthDeps) {}

  isRunning(): boolean { return this.active !== null; }

  /** 重复导航只能复用正在进行的登录；不会隐式触发 Cookie 同步。 */
  async start(request: GoogleReauthRequest): Promise<GoogleReauthResult> {
    if (this.active) return { status: "waiting", reason: "chrome-login-in-progress" };
    if (!existsSync(this.deps.chromePath)) return { status: "unavailable", reason: "chrome-unavailable" };
    if (originOf(request.homeUrl) !== request.successOrigin || !request.successOrigin.startsWith("https://")) {
      return { status: "failed", reason: "login-callback-origin-mismatch" };
    }

    let child: ChildProcess | null = null;
    let tempDir: string | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveStart!: (result: GoogleReauthResult) => void;
    const completion = new Promise<GoogleReauthResult>((resolve) => { resolveStart = resolve; });
    const cleanup = () => {
      if (tempDir) void rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    };
    const state: ActiveReauth = {
      request,
      connection: null,
      pageSessions: new Set(),
      finished: false,
      syncing: null,
      settle: (result) => {
        if (state.finished) return;
        state.finished = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        state.connection?.close();
        state.connection = null;
        if (child && child.exitCode === null && child.signalCode === null) {
          // exit 监听器负责清理，避免 Chrome 未退出时重新写入已删除的目录。
          if (!child.killed) child.kill("SIGTERM");
        } else {
          cleanup();
        }
        if (this.active === state) this.active = null;
        resolveStart(result);
      },
    };
    this.active = state;
    timeoutTimer = setTimeout(() => state.settle({ status: "timeout", reason: "chrome-login-timeout" }), this.deps.timeoutMs ?? 300_000);

    void (async () => {
      await mkdir(this.deps.tempRoot, { recursive: true, mode: 0o700 });
      if (state.finished) return;
      tempDir = await mkdtemp(join(this.deps.tempRoot, GOOGLE_REAUTH_TEMP_PREFIX));
      if (state.finished) { cleanup(); return; }
      child = (this.deps.spawnProcess ?? spawn)(this.deps.chromePath, [
        `--user-data-dir=${tempDir}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        request.homeUrl,
      ], { stdio: "ignore" });
      child.once("error", () => {
        state.settle({ status: "unavailable", reason: "chrome-unavailable" });
        cleanup();
      });
      child.once("exit", () => {
        state.settle({ status: "canceled", reason: "chrome-login-canceled" });
        cleanup();
      });
      const endpoint = await (this.deps.waitForPortFile ?? waitForDevToolsPortFile)(join(tempDir, "DevToolsActivePort"), 20_000);
      if (state.finished) return;
      if (!endpoint) throw new Error("chrome-unavailable");
      const connection = await (this.deps.connectCdp ?? connectBrowserCdp)(endpoint);
      if (state.finished) { connection.close(); return; }
      state.connection = connection;
      connection.onEvent(({ method, params }) => {
        if (state.finished) return;
        // attachedToTarget 报文的新会话在 params 内，外层 sessionId 是父会话。
        const sessionId = params.sessionId;
        if (typeof sessionId !== "string") return;
        if (method === "Target.attachedToTarget") {
          const info = params.targetInfo as { type?: string } | undefined;
          if (info?.type === "page") state.pageSessions.add(sessionId);
        } else if (method === "Target.detachedFromTarget") {
          state.pageSessions.delete(sessionId);
        }
      });
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "page", exclude: false }, { exclude: true }],
      });
    })().catch(() => state.settle({ status: "failed", reason: "chrome-unavailable" }));
    return completion;
  }

  /** 只有目标站点的用户确认按钮能同步；并发点击共享同一个同步结果。 */
  async attemptSyncNow(siteId: string): Promise<GoogleReauthResult> {
    const state = this.active;
    if (!state) return { status: "waiting", reason: "chrome-login-not-started" };
    if (state.request.siteId !== siteId) return { status: "waiting", reason: "chrome-login-in-progress" };
    if (state.syncing) return state.syncing;
    state.syncing = this.synchronize(state);
    try { return await state.syncing; }
    finally { state.syncing = null; }
  }

  private async synchronize(state: ActiveReauth): Promise<GoogleReauthResult> {
    const connection = state.connection;
    if (!connection) return { status: "waiting", reason: "chrome-login-not-ready" };
    // 读取每个仍存活的页面；不依赖导航事件，覆盖初始加载及 OAuth 弹窗回跳。
    const currentProviderSession = async (): Promise<string | null> => {
      for (const sessionId of state.pageSessions) {
        try {
          const result = await connection.send("Runtime.evaluate", {
            expression: "location.origin", returnByValue: true,
          }, sessionId) as { result?: { value?: unknown } };
          if (result?.result?.value === state.request.successOrigin) return sessionId;
        } catch { /* 页面正在导航或已经关闭，下次确认可重试。 */ }
      }
      return null;
    };
    try {
      const targetSession = await currentProviderSession();
      if (state.finished) return { status: "canceled", reason: "chrome-login-canceled" };
      if (!targetSession) return { status: "waiting", reason: "login-callback-origin-mismatch" };
      const result = await connection.send("Storage.getCookies") as { cookies?: CdpCookie[] };
      const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
      const providerHost = new URL(state.request.successOrigin).hostname;
      // Gemini 依赖 google.com 父域；其他站点只同步自己的域，不携带 Google 账号。
      const hosts = providerHost.endsWith(".google.com") ? ["google.com"] : [providerHost];
      const relevant = cookiesBelongingToHosts(cookies, hosts).filter((cookie) =>
        !cookie.partitionKey && !cookie.partitionKeyOpaque
        && (cookie.expires <= 0 || cookie.expires > Date.now() / 1000));
      if (relevant.length === 0) return { status: "waiting", reason: "login-session-not-found" };
      // 读取期间可能取消或跳离站点，写入前再次确认，不能用过期的导航结果兜底。
      const latest = await connection.send("Runtime.evaluate", {
        expression: "location.origin", returnByValue: true,
      }, targetSession) as { result?: { value?: unknown } };
      if (state.finished) return { status: "canceled", reason: "chrome-login-canceled" };
      if (latest?.result?.value !== state.request.successOrigin) {
        return { status: "waiting", reason: "login-callback-origin-mismatch" };
      }
      await state.request.onCookies(relevant.map(cdpCookieToElectronDetails));
      if (state.finished) return { status: "canceled", reason: "chrome-login-canceled" };
      state.settle({ status: "synchronized" });
      return { status: "synchronized" };
    } catch {
      if (state.finished) return { status: "canceled", reason: "chrome-login-canceled" };
      // 保持 Chrome 打开，允许重试或取消，而不是丢失刚完成的登录。
      return { status: "waiting", reason: "cookie-sync-failed" };
    }
  }

  cancel(): GoogleReauthResult {
    const result: GoogleReauthResult = { status: "canceled", reason: "chrome-login-canceled" };
    this.active?.settle(result);
    return result;
  }
}

/** 清理上次异常退出遗留的临时 Chrome Profile。 */
export async function cleanupAbandonedReauthProfiles(tempRoot: string): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(GOOGLE_REAUTH_TEMP_PREFIX)) {
      await rm(join(tempRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
