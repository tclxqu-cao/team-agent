import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeSessionError } from "./types.js";

export type RpcId = number | string;
export interface RpcNotification { method: string; params?: Record<string, unknown> }
export interface RpcServerRequest extends RpcNotification { id: RpcId }

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  executable?: string;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export class CodexAppServerClient {
  private readonly executable: string;
  private readonly requestTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(message: RpcNotification) => void>();
  private serverRequestHandler: ((message: RpcServerRequest) => void) | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  onNotification(listener: (message: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  setServerRequestHandler(handler: ((message: RpcServerRequest) => void) | null): void {
    this.serverRequestHandler = handler;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.disposed = false;
    await this.ensureStarted();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.disposed) {
      throw new RuntimeSessionError("Codex App Server is disposed", "RUNTIME_UNAVAILABLE");
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => { this.startPromise = null; });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const child = this.spawnProcess(this.executable, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.process = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) console.warn(`[codex-app-server] ${message}`);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      this.handleExit(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
    });

    await this.sendRequest("initialize", {
      clientInfo: { name: "customer-agent", title: "Customer Agent", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeSessionError(`Codex request timed out: ${method}`, "NATIVE_PROTOCOL_ERROR"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      throw new RuntimeSessionError("Codex App Server is unavailable", "RUNTIME_UNAVAILABLE");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn("[codex-app-server] Ignoring malformed JSON-RPC line");
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      const request = message as unknown as RpcServerRequest;
      if (this.serverRequestHandler) this.serverRequestHandler(request);
      else this.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id as RpcId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id as RpcId);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        pending.reject(new RuntimeSessionError(
          error.message ?? `Codex request failed (${error.code ?? "unknown"})`,
          /active writer|already.*loaded|in use/i.test(error.message ?? "")
            ? "SESSION_OCCUPIED"
            : "NATIVE_PROTOCOL_ERROR",
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      const notification = message as unknown as RpcNotification;
      for (const listener of this.notificationListeners) listener(notification);
    }
  }

  private handleExit(error: Error): void {
    if (!this.process) return;
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeSessionError(error.message, "RUNTIME_UNAVAILABLE"));
    }
    this.pending.clear();
  }

  private async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
