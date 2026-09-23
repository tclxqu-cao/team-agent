import { spawn, type ChildProcess } from "node:child_process";
import type { AccessibilityObservation, AccessibilitySnapshotResult } from "@agent/computer-use";

export type DesktopInputCommand =
  | { op: "move" | "down" | "up" | "drag"; x: number; y: number; button?: "left" | "right" | "middle"; click?: number }
  | { op: "wheel"; deltaX: number; deltaY: number }
  | { op: "key"; action: "down" | "up"; code: string; modifiers?: string[] }
  | { op: "text" | "unicode_text"; text: string }
  | { op: "ax_snapshot" }
  | { op: "ax_action"; revision: string; nodeId: string; action: "press" | "focus" }
  | { op: "ax_text"; revision: string; nodeId: string; text: string; replace: boolean };

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface InputGatewayProcess {
  stdin: { write(chunk: string): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(): void;
}

export type SpawnInputHelper = (path: string) => InputGatewayProcess;

function defaultSpawn(path: string): InputGatewayProcess {
  return spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as InputGatewayProcess;
}

/** Gateway to the desktop-input Swift helper: JSON-lines requests over stdin/stdout. */
export class DesktopInputGateway {
  private readonly helperPath: string;
  private readonly spawnImpl: SpawnInputHelper;
  private readonly lineTimeoutMs: number;
  private readonly startSettleMs: number;
  private process: InputGatewayProcess | null = null;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private readonly onStderr: (line: string) => void;

  constructor({ helperPath, spawnImpl = defaultSpawn, lineTimeoutMs = 4_000, startSettleMs = 50, onStderr = () => undefined }: {
    helperPath: string;
    spawnImpl?: SpawnInputHelper;
    lineTimeoutMs?: number;
    startSettleMs?: number;
    onStderr?: (line: string) => void;
  }) {
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
    this.lineTimeoutMs = lineTimeoutMs;
    this.startSettleMs = startSettleMs;
    this.onStderr = onStderr;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let child: InputGatewayProcess;
      try {
        child = this.spawnImpl(this.helperPath);
      } catch (error) {
        this.startPromise = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // spawn() reports a missing/blocked binary through the async "error"
      // event; an unhandled one crashes the main process with a modal dialog.
      let spawnError: Error | null = null;
      child.stdout.on("data", (chunk) => this.#handleChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => {
        const line = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
        if (line) this.onStderr(line);
      });
      child.on("exit", () => this.#handleExit());
      child.on("error", (error) => {
        spawnError = error;
        this.#handleSpawnError(error);
      });
      this.process = child;
      // Settle past the tick the spawn error fires on so start() rejects with
      // it and enable() can surface it as a status error instead of crashing.
      setTimeout(() => {
        if (spawnError) reject(spawnError);
        else resolve();
      }, this.startSettleMs);
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    this.buffer = "";
    this.#failPending(new Error("desktop input helper is stopped"));
    child?.kill();
  }

  async checkAccessibility(): Promise<boolean> {
    const response = await this.request({ op: "check" });
    return response.trusted === true;
  }

  async snapshotAccessibility(): Promise<AccessibilitySnapshotResult> {
    const response = await this.request({ op: "ax_snapshot" });
    if (response.status === "ok" && response.observation && typeof response.observation === "object") {
      return { status: "ok", observation: response.observation as AccessibilityObservation };
    }
    const status = response.status === "denied" || response.status === "timeout"
      ? response.status
      : "unavailable";
    return { status, ...(typeof response.message === "string" ? { message: response.message } : {}) };
  }

  async performAccessibilityAction(
    revision: string,
    nodeId: string,
    action: "press" | "focus",
  ): Promise<void> {
    await this.request({ op: "ax_action", revision, nodeId, action });
  }

  async setAccessibilityText(
    revision: string,
    nodeId: string,
    text: string,
    replace: boolean,
  ): Promise<void> {
    await this.request({ op: "ax_text", revision, nodeId, text, replace });
  }

  async dispatch(command: DesktopInputCommand): Promise<Record<string, unknown>> {
    return this.request(command as unknown as Record<string, unknown> & { op: string });
  }

  async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.process;
    if (!child) throw new Error("desktop input helper is not running");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("desktop input helper timed out"));
      }, this.lineTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  #handleChunk(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line); } catch { return; }
    const id = Number(message.id);
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (message.ok === true) request.resolve(message);
    else request.reject(Object.assign(
      new Error(String(message.error || "desktop input helper error")),
      typeof message.code === "string" ? { code: message.code } : {},
    ));
  }

  #handleExit(): void {
    this.process = null;
    this.startPromise = null;
    this.buffer = "";
    this.#failPending(new Error("desktop input helper exited"));
  }

  #handleSpawnError(error: Error): void {
    this.process = null;
    this.startPromise = null;
    this.buffer = "";
    this.#failPending(new Error(`desktop input helper failed to start: ${error.message}`));
  }

  #failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
