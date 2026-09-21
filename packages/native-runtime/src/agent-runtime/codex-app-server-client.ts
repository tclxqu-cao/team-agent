import { logGlobal } from "@agent/core";
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
  environment?: NodeJS.ProcessEnv;
}

export class CodexAppServerClient {
  private readonly executable: string;
  private readonly requestTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly environment: NodeJS.ProcessEnv;
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(message: RpcNotification) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private serverRequestHandler: ((message: RpcServerRequest) => void) | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.environment = options.environment ?? process.env;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  onNotification(listener: (message: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
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
    console.log(`[codex-app-server-client] spawning: ${this.executable} app-server --stdio`);
    const child = this.spawnProcess(this.executable, ["app-server", "--stdio"], {
      env: normalizeCodexEnvironment(this.environment),
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
    child.once("error", (error) => {
      logGlobal("error", "codex-app-server", "codex app-server process error", error);
      console.log("[codex-app-server-client] child error:", error.message);
      this.handleExit(error);
    });
    child.once("exit", (code, signal) => {
      logGlobal("error", "codex-app-server", "codex app-server process exited", undefined, { code, signal });
      console.log(`[codex-app-server-client] child exit: code=${code} signal=${signal}`);
      this.handleExit(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
    });

    await this.sendRequest("initialize", {
      clientInfo: { name: "customer-agent", title: "Customer Agent", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    console.log(`[codex-app-server-client ${new Date().toISOString().slice(11,23)}] initialize completed`);
    this.write({ method: "initialized", params: {} });
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    console.log(`[codex-app-server-client ${new Date().toISOString().slice(11,23)}] -> ${method} (id=${id})`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log(`[codex-app-server-client] TIMEOUT ${method} (id=${id})`);
        this.pending.delete(id);
        reject(new RuntimeSessionError(`Codex request timed out: ${method}`, "NATIVE_PROTOCOL_ERROR"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          console.log(`[codex-app-server-client ${new Date().toISOString().slice(11,23)}] <- ${method} resolved (id=${id})`);
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (reason: Error) => {
          console.log(`[codex-app-server-client] <- ${method} rejected (id=${id}):`, reason.message);
          clearTimeout(timer);
          reject(reason);
        },
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
    for (const listener of this.exitListeners) listener(error);
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


/**
 * Codex uses Rust's proxy implementation, whose NO_PROXY parser does not
 * consistently treat shell-style host globs such as `*.example.com` as a
 * domain suffix. Keep the original rules for other consumers, but add the
 * equivalent bare and dot-prefixed host rules for the Codex child process.
 */
export function normalizeCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...environment };
  const values = [normalized.NO_PROXY, normalized.no_proxy].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (values.length === 0) return normalized;

  const merged = new Set<string>();
  for (const value of values) {
    for (const entry of value.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      merged.add(trimmed);
      const match = /^(\*+)([^:]+)(:\d+)?$/.exec(trimmed);
      if (!match || match[2] === "") continue;
      const host = match[2].replace(/^\.+/, "");
      if (!host || host === "*") continue;
      const port = match[3] ?? "";
      merged.add(`${host}${port}`);
      merged.add(`.${host}${port}`);
    }
  }

  const result = [...merged].join(",");
  normalized.NO_PROXY = result;
  normalized.no_proxy = result;
  return normalized;
}
