import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { discoverHarnessEndpoint, type HarnessEndpoint, type HarnessEndpointResolver } from "./deepseek-harness-endpoint.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { RuntimeSessionError } from "./types.js";

export type HarnessRecord = Record<string, unknown>;
export function harnessRecord(value: unknown): HarnessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeSessionError("DeepSeek Harness 返回了无效的数据", "NATIVE_PROTOCOL_ERROR");
  return value as HarnessRecord;
}

function harnessError(error: HarnessRecord, fallback: string): RuntimeSessionError {
  const code = error.code === "session/writer-held" || error.code === "session/agent-busy" ? "SESSION_OCCUPIED"
    : error.code === "session/not-found" ? "SESSION_NOT_FOUND"
    : error.code === "job/not-found" ? "BACKGROUND_JOB_NOT_FOUND" : "NATIVE_PROTOCOL_ERROR";
  return new RuntimeSessionError(typeof error.message === "string" ? error.message : fallback, code);
}

export interface HarnessStream {
  values: AsyncIterable<HarnessRecord>;
  close(): void;
}

export interface HarnessConnection {
  request(method: string, args: HarnessRecord): Promise<unknown>;
  follow(request: HarnessRecord): Promise<HarnessStream>;
  open?(endpoint: string, args: HarnessRecord): Promise<HarnessStream>;
  dispose(): Promise<void>;
}

/** Borrows an existing native Host before starting an owned dsh web profile. */
export class DeepSeekHarnessClient implements HarnessConnection {
  private child: ChildProcess | null = null;
  private connection: Promise<HarnessEndpoint> | null = null;
  private connectionRefreshAt = Infinity;
  private readonly streams = new Set<HarnessStream>();
  private readonly blockingStreams = new Set<HarnessStream>();
  private ownedEndpoint: HarnessEndpoint | null = null;
  private handoff: Promise<void> | null = null;
  private handoffTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = 0;
  private disposed = false;

  constructor(private readonly options: { executable?: string; url?: string; env?: NodeJS.ProcessEnv;
    discoverEndpoint?: HarnessEndpointResolver; discoverDesktopEndpoint?: HarnessEndpointResolver;
    handoffIntervalMs?: number } = {}) {}

  private async admit(): Promise<void> {
    while (this.handoff) await this.handoff;
    if (this.disposed) throw new RuntimeSessionError("DeepSeek Harness 连接已关闭", "RUNTIME_UNAVAILABLE");
    this.inFlight++;
  }

  private scheduleHandoff(): void {
    if (this.handoffTimer || this.disposed) return;
    this.handoffTimer = setInterval(() => {
      if (this.handoff || this.inFlight || this.blockingStreams.size || !this.child || !this.ownedEndpoint) return;
      this.handoff = this.tryHandoff().catch(() => {}).finally(() => { this.handoff = null; });
    }, this.options.handoffIntervalMs ?? 15_000);
    this.handoffTimer.unref();
  }

  private async tryHandoff(): Promise<void> {
    const child = this.child;
    const owned = this.ownedEndpoint;
    if (!child || !owned) return;
    const desktop = await (this.options.discoverDesktopEndpoint ?? (() => discoverHarnessEndpoint({
      environment: this.options.env ?? process.env, desktopOnly: true,
    })))();
    if (!desktop || desktop.origin === owned.origin || this.disposed) return;
    const idle = async () => {
      const result = harnessRecord(await this.requestAt(owned, "session/list", { _request: {} }));
      if (!Array.isArray(result.items)) return false;
      const sessions = result.items.map(harnessRecord);
      if (sessions.some(row => row.running !== false || typeof row.sessionId !== "string")) return false;
      for (const sessionId of [undefined, ...sessions.filter(row => row.agentAvailable === true).map(row => String(row.sessionId))]) {
        const stream = await this.openAt(owned, "job/list", { request: sessionId ? { sessionId } : {} });
        try {
          const frame = await stream.values[Symbol.asyncIterator]().next();
          if (frame.done || frame.value.type !== "rows" || !Array.isArray(frame.value.jobs)
            || frame.value.jobs.map(harnessRecord).some(job => !["completed", "failed", "killed"].includes(String(job.status)))) return false;
        } finally { stream.close(); }
      }
      return true;
    };
    if (!await idle() || this.disposed || this.child !== child) return;
    const confirmation = harnessRecord(await this.requestAt(owned, "session/list", { _request: {} }));
    if (!Array.isArray(confirmation.items) || confirmation.items.map(harnessRecord).some(row => row.running !== false)) return;
    const exited = new Promise<boolean>(resolve => {
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, 5_000);
      child.once("exit", onExit);
    });
    child.kill();
    if (!await exited || this.disposed) return;
    for (const stream of [...this.streams]) stream.close();
    this.connection = Promise.resolve(desktop);
    this.connectionRefreshAt = desktop.refreshAt ?? Infinity;
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    this.handoffTimer = null;
  }

  private connect() {
    if (Date.now() >= this.connectionRefreshAt) { this.connection = null; this.connectionRefreshAt = Infinity; }
    if (!this.connection) this.connection = this.start().catch(error => {
      this.child?.kill(); this.child = null; this.connection = null;
      throw error;
    });
    return this.connection;
  }

  private async start(): Promise<HarnessEndpoint> {
    if (this.child && this.ownedEndpoint) return this.ownedEndpoint;
    this.connectionRefreshAt = Infinity;
    const environment = this.options.env ?? process.env;
    let rawUrl = this.options.url ?? environment.AGENT_DSH_URL;
    if (!rawUrl) {
      const existing = await (this.options.discoverEndpoint ?? (() => discoverHarnessEndpoint({ environment })))();
      if (this.disposed) throw new RuntimeSessionError("DeepSeek Harness 连接已关闭", "RUNTIME_UNAVAILABLE");
      if (existing) { this.connectionRefreshAt = existing.refreshAt ?? Infinity; return existing; }
      let executable = this.options.executable ?? environment.AGENT_DSH_EXECUTABLE;
      if (!executable && process.platform === "darwin") {
        const installed = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
        try { await access(installed); executable = installed; } catch { /* Use the npm-installed launcher. */ }
      }
      const child = spawn(executable || "dsh", ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
        env: environment, stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      rawUrl = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        const finish = (error?: Error, url?: string) => {
          clearTimeout(timer); child.stdout?.off("data", data); child.stderr?.off("data", data);
          child.off("error", failed); child.off("exit", exited);
          if (error) { child.kill(); reject(error); } else resolve(url!);
        };
        const data = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-16_384);
          const match = buffer.match(/https?:\/\/127\.0\.0\.1:\d+\/\?[^\s\u001b]+/);
          if (match) finish(undefined, match[0]);
        };
        const failed = () => finish(new RuntimeSessionError("未找到 DeepSeek Harness，请安装 dsh 或设置 AGENT_DSH_EXECUTABLE", "RUNTIME_UNAVAILABLE"));
        const exited = () => finish(new RuntimeSessionError("DeepSeek Harness 启动失败，请检查 dsh web 配置", "RUNTIME_UNAVAILABLE"));
        const timer = setTimeout(() => finish(new RuntimeSessionError("DeepSeek Harness 启动超时", "RUNTIME_UNAVAILABLE")), 20_000);
        child.stdout?.on("data", data); child.stderr?.on("data", data); child.once("error", failed); child.once("exit", exited);
      });
      // Drain logs without publishing the tokenized launch URL or private prompts.
      child.stdout?.resume(); child.stderr?.resume();
      child.once("exit", () => { if (this.child === child) { this.child = null; this.ownedEndpoint = null; this.connection = null; for (const stream of this.streams) stream.close(); } });
    }
    let url: URL;
    try { url = new URL(rawUrl); }
    catch { throw new RuntimeSessionError("DeepSeek Harness 连接地址无效", "RUNTIME_UNAVAILABLE"); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new RuntimeSessionError("DeepSeek Harness 连接地址必须是本机 HTTP 地址", "RUNTIME_UNAVAILABLE");
    }
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) })
      .catch(() => { throw new RuntimeSessionError("DeepSeek Harness 连接失败", "RUNTIME_UNAVAILABLE"); });
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    if (response.status === 401 || response.status === 403) throw new RuntimeSessionError("DeepSeek Harness 授权失败，请使用 dsh 输出的完整地址", "RUNTIME_UNAVAILABLE");
    if (response.status >= 400) throw new RuntimeSessionError(`DeepSeek Harness 连接失败 (${response.status})`, "RUNTIME_UNAVAILABLE");
    const endpoint = { origin: url.origin, cookie };
    if (this.child) { this.ownedEndpoint = endpoint; this.scheduleHandoff(); }
    return endpoint;
  }

  async request(method: string, args: HarnessRecord): Promise<unknown> {
    await this.admit();
    try { return await this.connectedRequest(method, args); }
    finally { this.inFlight--; }
  }

  private async connectedRequest(method: string, args: HarnessRecord): Promise<unknown> {
    const connection = this.connect();
    const endpoint = await connection;
    try { return await this.requestAt(endpoint, method, args); }
    catch (error) {
      if (error instanceof RuntimeSessionError && error.code === "RUNTIME_UNAVAILABLE" && this.connection === connection) this.connection = null;
      throw error;
    }
  }

  private async requestAt({ origin, cookie }: HarnessEndpoint, method: string, args: HarnessRecord): Promise<unknown> {
    const rpcId = randomUUID();
    const response = await fetch(`${origin}/api/${method}`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      // Do not replay commands/prompts: the native Host may already have admitted them.
      throw new RuntimeSessionError("DeepSeek Harness 接口连接失败，下次请求将重新连接", "RUNTIME_UNAVAILABLE");
    });
    if (!response.ok) {
      throw new RuntimeSessionError(`DeepSeek Harness 接口不可用 (${response.status})`, "RUNTIME_UNAVAILABLE");
    }
    const envelope = harnessRecord(await response.json());
    if (envelope.type !== "server-response" || envelope.rpcId !== rpcId) throw new RuntimeSessionError("DeepSeek Harness 响应标识不匹配", "NATIVE_PROTOCOL_ERROR");
    const result = harnessRecord(envelope.result);
    if (result.ok !== true) {
      const error = harnessRecord(result.error);
      throw harnessError(error, "DeepSeek Harness 调用失败");
    }
    return result.value;
  }

  async follow(request: HarnessRecord): Promise<HarnessStream> {
    return this.open("session/follow", { request });
  }

  async open(endpoint: string, args: HarnessRecord): Promise<HarnessStream> {
    await this.admit();
    try { return await this.openAt(await this.connect(), endpoint, args); }
    finally { this.inFlight--; }
  }

  private async openAt({ origin, cookie }: HarnessEndpoint, endpoint: string, args: HarnessRecord): Promise<HarnessStream> {
    const connection = this.connection;
    const streamId = randomUUID();
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote.mux`, { headers: { cookie } });
    const queue = new AsyncEventQueue<{ value?: HarnessRecord; error?: Error }>();
    let closed = false;
    const firstItemTimer = setTimeout(() => {
      queue.push({ error: new RuntimeSessionError("DeepSeek Harness 历史快照超时", "RUNTIME_UNAVAILABLE") });
      stream.close();
    }, 15_000);
    const stream: HarnessStream = {
      values: { async *[Symbol.asyncIterator]() { for await (const item of queue) { if (item.error) throw item.error; if (item.value) yield item.value; } } },
      close: () => { if (closed) return; closed = true; clearTimeout(firstItemTimer); this.streams.delete(stream); this.blockingStreams.delete(stream); queue.close(); socket.close(); },
    };
    this.streams.add(stream);
    if (endpoint !== "$events") this.blockingStreams.add(stream);
    socket.on("message", raw => {
      try {
        const frame = harnessRecord(JSON.parse(raw.toString()));
        if (frame.streamId !== streamId) return;
        if (frame.type === "item") { clearTimeout(firstItemTimer); queue.push({ value: harnessRecord(frame.value) }); }
        else if (frame.type === "error") { queue.push({ error: harnessError(harnessRecord(frame.error), "DeepSeek Harness 事件读取失败") }); stream.close(); }
        else if (frame.type === "end") stream.close();
      } catch { queue.push({ error: new RuntimeSessionError("DeepSeek Harness 返回了无效的事件", "NATIVE_PROTOCOL_ERROR") }); stream.close(); }
    });
    socket.on("close", () => { if (!closed) {
      if (this.connection === connection) this.connection = null;
      queue.push({ error: new RuntimeSessionError("DeepSeek Harness 事件连接已断开", "RUNTIME_UNAVAILABLE") });
    } stream.close(); });
    socket.on("error", () => {
      if (this.connection === connection) this.connection = null;
      queue.push({ error: new RuntimeSessionError("DeepSeek Harness 事件连接失败", "RUNTIME_UNAVAILABLE") }); stream.close();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stream.close(); reject(new RuntimeSessionError("DeepSeek Harness 事件连接超时", "RUNTIME_UNAVAILABLE")); }, 10_000);
      socket.once("open", () => { clearTimeout(timer); socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } })); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new RuntimeSessionError("DeepSeek Harness 事件连接失败", "RUNTIME_UNAVAILABLE")); });
    });
    return stream;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    this.handoffTimer = null;
    for (const stream of [...this.streams]) stream.close();
    const child = this.child; this.child = null; this.connection = null; this.connectionRefreshAt = Infinity;
    if (child) child.kill();
    await this.handoff;
  }
}
