import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RuntimeSessionError } from "./types.js";

export type NativeJsonPacket = Record<string, unknown>;

export interface NativeStdioCommand {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface Options extends NativeStdioCommand {
  responseKey(packet: NativeJsonPacket): string | undefined;
  onPacket?(packet: NativeJsonPacket): void | Promise<void>;
  onFailure?(error: RuntimeSessionError): void;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  shutdownGraceMs?: number;
}

interface PendingReply {
  resolve(packet: NativeJsonPacket): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded NDJSON transport. Protocol-specific envelopes stay in each client. */
export class NativeStdioChannel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingReply>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private failure: RuntimeSessionError | null = null;
  private closed = false;

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    if (this.closed) throw this.failure ?? this.unavailable("Native CLI channel is closed");
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.closePromise = new Promise<void>(resolveClose => {
        child.once("close", (code, signal) => {
          this.child = null;
          this.fail(this.unavailable(`Native CLI exited (${signal ?? code ?? "unknown"})`));
          resolveClose();
        });
      });
      child.once("spawn", resolve);
      child.once("error", error => {
        const failure = this.unavailable(`Unable to start native CLI: ${error.message}`);
        reject(failure);
        this.fail(failure);
      });
      child.stdin.on("error", error => this.fail(this.unavailable(`Native CLI input failed: ${error.message}`)));
      child.stdout.on("data", (chunk: Buffer) => {
        if (!this.closed) this.consume(this.decoder.write(chunk));
      });
      child.stdout.on("end", () => {
        if (this.closed) return;
        this.consume(this.decoder.end());
        if (this.buffer.trim()) this.readPacket(this.buffer);
        this.buffer = "";
      });
      // Always drain stderr, but never attach native account/config output to errors.
      child.stderr.resume();
    });
    return this.startPromise;
  }

  async send(packet: NativeJsonPacket): Promise<void> {
    await this.start();
    const child = this.child;
    if (this.closed || !child || child.stdin.destroyed) throw this.failure ?? this.unavailable("Native CLI input is closed");
    const line = JSON.stringify(packet);
    if (Buffer.byteLength(line) > this.maxLineBytes) throw this.protocolError("Native CLI request exceeds the line limit");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${line}\n`, error => error ? reject(error) : resolve());
    });
  }

  async request(key: string, packet: NativeJsonPacket, timeoutMs = this.options.requestTimeoutMs ?? 20_000): Promise<NativeJsonPacket> {
    await this.start();
    if (this.pending.has(key)) throw this.protocolError("Duplicate native CLI request ID");
    if (this.pending.size >= (this.options.maxPendingRequests ?? 128)) throw this.protocolError("Too many pending native CLI requests");
    return new Promise<NativeJsonPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(this.unavailable("Native CLI request timed out"));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      void this.send(packet).catch(error => {
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error instanceof Error ? error : this.unavailable("Native CLI request failed"));
      });
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.fail(this.unavailable("Native CLI channel was disposed"));
    const child = this.child;
    this.disposePromise = (async () => {
      if (!child) return;
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, this.options.shutdownGraceMs ?? 1_000);
      try { await this.closePromise; }
      finally { clearTimeout(timer); }
    })();
    return this.disposePromise;
  }

  private get maxLineBytes(): number { return this.options.maxLineBytes ?? 16 * 1024 * 1024; }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.readPacket(line);
    }
    if (!this.closed && Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.fail(this.protocolError("Native CLI output exceeds the line limit"));
    }
  }

  private readPacket(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxLineBytes) { this.fail(this.protocolError("Native CLI output exceeds the line limit")); return; }
    let packet: NativeJsonPacket;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      packet = value as NativeJsonPacket;
      const key = this.options.responseKey(packet);
      if (key !== undefined) {
        const pending = this.pending.get(key);
        if (pending) {
          this.pending.delete(key);
          clearTimeout(pending.timer);
          pending.resolve(packet);
        }
        return;
      }
    } catch {
      this.fail(this.protocolError("Native CLI sent an invalid JSON packet"));
      return;
    }
    try {
      void Promise.resolve(this.options.onPacket?.(packet)).catch(() => this.fail(this.protocolError("Native CLI packet handler failed")));
    } catch { this.fail(this.protocolError("Native CLI packet handler failed")); }
  }

  private fail(error: RuntimeSessionError): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child?.kill("SIGTERM");
    try { this.options.onFailure?.(error); }
    catch { /* Lifecycle observers cannot prevent pending requests from closing. */ }
  }

  private unavailable(message: string): RuntimeSessionError { return new RuntimeSessionError(message, "RUNTIME_UNAVAILABLE"); }
  private protocolError(message: string): RuntimeSessionError { return new RuntimeSessionError(message, "NATIVE_PROTOCOL_ERROR"); }
}
