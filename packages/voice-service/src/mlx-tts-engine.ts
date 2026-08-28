import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BoundedAsyncQueue, FrameDecoder } from "./framed-process.js";
import type { TtsRequest } from "./protocol.js";

export interface TtsStreamMetadata {
  sampleRate: 24_000;
  channels: 1;
  sampleFormat: "s16le";
}

export interface TtsPcmStream extends TtsStreamMetadata {
  chunks: AsyncIterable<Buffer>;
  completed: Promise<void>;
}

export interface MlxTtsEngineOptions {
  python: string;
  workerScript: string;
  model: string;
  voice: string;
  streamingInterval: number;
  startupTimeoutMs?: number;
  fake?: boolean;
  onFatal?(error: Error): void;
}

interface WorkerMessage {
  type: string;
  requestId?: string;
  sampleRate?: number;
  channels?: number;
  sampleFormat?: string;
  message?: string;
}

interface ActiveStream {
  requestId: string;
  queue: BoundedAsyncQueue<Buffer>;
  started: Promise<TtsStreamMetadata>;
  resolveStarted(value: TtsStreamMetadata): void;
  rejectStarted(error: Error): void;
  completed: Promise<void>;
  resolveCompleted(): void;
  rejectCompleted(error: Error): void;
  removeAbort(): void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error("TTS generation aborted");
  error.name = "AbortError";
  return error;
}

export class MlxTtsEngine {
  private readonly decoder = new FrameDecoder();
  private readonly readyDeferred = deferred<void>();
  private active: ActiveStream | null = null;
  private requestSequence = 0;
  private closed = false;
  private workerReady = false;

  private constructor(
    private readonly options: MlxTtsEngineOptions,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[mlx-tts] ${chunk.toString()}`);
    });
    child.once("error", (error) => this.failWorker(error));
    child.once("exit", (code, signal) => {
      this.failWorker(new Error(`MLX TTS worker exited (${signal ?? code ?? "unknown"})`));
    });
  }

  static async start(options: MlxTtsEngineOptions): Promise<MlxTtsEngine> {
    const args = ["-u", options.workerScript, "--model", options.model];
    if (options.fake) args.push("--fake");
    const child = spawn(options.python, args, { stdio: ["pipe", "pipe", "pipe"] });
    const engine = new MlxTtsEngine(options, child);
    const timeoutMs = options.startupTimeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        engine.readyDeferred.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MLX TTS worker startup timed out")), timeoutMs);
        }),
      ]);
      return engine;
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stream(request: TtsRequest, signal: AbortSignal): Promise<TtsPcmStream> {
    if (this.closed) throw new Error("MLX TTS engine is closed");
    if (signal.aborted) throw abortError();
    if (this.active) {
      this.send({ type: "cancel", requestId: this.active.requestId });
      await this.active.completed.catch(() => undefined);
    }

    const requestId = `${request.sessionId}:${request.generation}:${++this.requestSequence}`;
    const started = deferred<TtsStreamMetadata>();
    const completed = deferred<void>();
    const queue = new BoundedAsyncQueue<Buffer>(
      8,
      () => this.child.stdout.pause(),
      () => {
        this.drainStdout();
        if (!queue.isFull) this.child.stdout.resume();
      },
    );
    const onAbort = () => this.send({ type: "cancel", requestId });
    signal.addEventListener("abort", onAbort, { once: true });
    const active: ActiveStream = {
      requestId,
      queue,
      started: started.promise,
      resolveStarted: started.resolve,
      rejectStarted: started.reject,
      completed: completed.promise,
      resolveCompleted: () => completed.resolve(undefined),
      rejectCompleted: completed.reject,
      removeAbort: () => signal.removeEventListener("abort", onAbort),
    };
    this.active = active;
    this.send({
      type: "synthesize",
      requestId,
      text: request.text,
      voice: request.voice || this.options.voice,
      speed: request.speed,
      streamingInterval: this.options.streamingInterval,
    });
    try {
      const metadata = await active.started;
      return { ...metadata, chunks: queue, completed: active.completed };
    } catch (error) {
      active.completed.catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active) this.send({ type: "cancel", requestId: this.active.requestId });
    this.send({ type: "shutdown" });
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(value: unknown): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private onStdout(chunk: Buffer): void {
    try {
      this.drainStdout(chunk);
    } catch (error) {
      this.failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private drainStdout(chunk: Buffer = Buffer.alloc(0)): void {
    let input = chunk;
    while (true) {
      const [frame] = this.decoder.push(input, 1);
      input = Buffer.alloc(0);
      if (!frame) return;
      if (frame.kind === "json") {
        this.onMessage(JSON.parse(frame.payload.toString("utf8")) as WorkerMessage);
      } else if (this.active && !this.active.queue.push(frame.payload)) {
        throw new Error("TTS PCM queue overflow");
      }
      if (this.active?.queue.isFull) return;
    }
  }

  private onMessage(message: WorkerMessage): void {
    if (message.type === "ready") {
      this.workerReady = true;
      this.readyDeferred.resolve(undefined);
      return;
    }
    if (message.type === "startup-error") {
      this.readyDeferred.reject(new Error(message.message || "MLX TTS startup failed"));
      return;
    }
    const active = this.active;
    if (!active || message.requestId !== active.requestId) return;
    if (message.type === "started") {
      if (message.sampleRate !== 24_000 || message.channels !== 1 || message.sampleFormat !== "s16le") {
        this.finishActive(new Error("MLX TTS worker returned unsupported audio metadata"));
        return;
      }
      active.resolveStarted({ sampleRate: 24_000, channels: 1, sampleFormat: "s16le" });
      return;
    }
    if (message.type === "finished") {
      this.finishActive();
      return;
    }
    if (message.type === "cancelled") {
      this.finishActive(abortError());
      return;
    }
    if (message.type === "error") {
      this.finishActive(new Error(message.message || "MLX TTS synthesis failed"));
    }
  }

  private finishActive(error?: Error): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.removeAbort();
    active.queue.close(error);
    if (error) {
      active.rejectStarted(error);
      active.rejectCompleted(error);
    } else {
      active.resolveCompleted();
    }
  }

  private failWorker(error: Error): void {
    if (this.closed) return;
    const fatal = this.workerReady;
    this.closed = true;
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGKILL");
    this.readyDeferred.reject(error);
    this.finishActive(error);
    if (fatal) this.options.onFatal?.(error);
  }
}
