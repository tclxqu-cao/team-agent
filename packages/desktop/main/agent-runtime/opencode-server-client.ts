import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { RuntimeSessionError } from "./types.js";

export interface OpenCodeServerEvent {
  directory: string;
  payload: GlobalEvent["payload"];
}

type EventListener = (event: OpenCodeServerEvent) => void;
type FailureListener = (error: Error) => void;

export class OpenCodeServerClient {
  private readonly executable: string;
  private readonly unavailableError?: string;
  private readonly environment: NodeJS.ProcessEnv;
  private startPromise: Promise<OpencodeClient> | null = null;
  private process: ChildProcess | null = null;
  private stopEventStream: (() => void) | null = null;
  private readonly listeners = new Set<EventListener>();
  private readonly failureListeners = new Set<FailureListener>();
  private disposed = false;

  constructor(options: {
    executable?: string;
    unavailableError?: string;
    environment?: NodeJS.ProcessEnv;
  } = {}) {
    this.executable = options.executable?.trim() || "opencode";
    this.unavailableError = options.unavailableError?.trim() || undefined;
    this.environment = options.environment ?? process.env;
  }

  async client(): Promise<OpencodeClient> {
    if (this.disposed) {
      throw new RuntimeSessionError("OpenCode runtime has been disposed", "RUNTIME_UNAVAILABLE");
    }
    if (this.unavailableError) {
      throw new RuntimeSessionError(this.unavailableError, "RUNTIME_UNAVAILABLE");
    }
    this.startPromise ??= this.start();
    return this.startPromise;
  }

  subscribe(listener: EventListener, onFailure?: FailureListener): () => void {
    this.listeners.add(listener);
    if (onFailure) this.failureListeners.add(onFailure);
    void this.client().catch((error) => this.notifyFailure(normalizeError(error)));
    return () => {
      this.listeners.delete(listener);
      if (onFailure) this.failureListeners.delete(onFailure);
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopEventStream?.();
    this.stopEventStream = null;
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    force.unref();
    await exited;
    clearTimeout(force);
  }

  private async start(): Promise<OpencodeClient> {
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(this.executable, [
      "serve",
      "--hostname=127.0.0.1",
      `--port=${port}`,
    ], {
      env: {
        ...this.environment,
        // Ask for side-effecting operations. AgentRoam applies the selected
        // per-session policy when OpenCode emits the permission request.
        OPENCODE_CONFIG_CONTENT: openCodeServerConfig(this.environment.OPENCODE_CONFIG_CONTENT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    let output = "";
    let spawnError: Error | null = null;
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => { spawnError = error; });

    try {
      await waitForHealth(url, child, () => output, () => spawnError);
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGTERM");
      this.process = null;
      this.startPromise = null;
      throw error;
    }

    const client = createOpencodeClient({ baseUrl: url, throwOnError: true });
    child.once("exit", (code, signal) => {
      if (this.process !== child || this.disposed) return;
      this.process = null;
      this.startPromise = null;
      this.stopEventStream?.();
      this.stopEventStream = null;
      this.notifyFailure(new Error(
        `OpenCode server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      ));
    });
    this.startEventStream(client);
    return client;
  }

  private startEventStream(client: OpencodeClient): void {
    this.stopEventStream?.();
    this.stopEventStream = subscribeToOpenCodeEvents(client, {
      onEvent: (event) => {
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (error) {
            console.warn("[opencode-server] Ignoring malformed event", normalizeError(error));
          }
        }
      },
      onEventError: (error) => {
        console.warn("[opencode-server] Ignoring malformed event", error);
      },
      onFailure: (error) => this.notifyFailure(error),
    });
  }

  private notifyFailure(error: Error): void {
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.warn("[opencode-server] Failure listener rejected an event", normalizeError(listenerError));
      }
    }
  }
}

interface OpenCodeEventSubscriptionOptions {
  onEvent: (event: GlobalEvent) => void;
  onEventError: (error: Error) => void;
  onFailure: (error: Error) => void;
  reconnectDelayMs?: (attempt: number) => number;
}

export function subscribeToOpenCodeEvents(
  client: OpencodeClient,
  options: OpenCodeEventSubscriptionOptions,
): () => void {
  let disposed = false;
  let currentAbort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const reconnectDelayMs = options.reconnectDelayMs
    ?? ((attempt: number) => Math.min(250 * (2 ** attempt), 5_000));

  const reportEventError = (error: unknown) => {
    try {
      options.onEventError(normalizeError(error));
    } catch {
      // Diagnostics must not interrupt the shared event stream.
    }
  };

  const connect = () => {
    if (disposed) return;
    const abort = new AbortController();
    currentAbort = abort;
    void client.global.event({ signal: abort.signal }).then(async ({ stream }) => {
      if (disposed || abort.signal.aborted) return;
      for await (const event of stream) {
        if (disposed || abort.signal.aborted) return;
        reconnectAttempt = 0;
        try {
          options.onEvent(event);
        } catch (error) {
          reportEventError(error);
        }
      }
      if (!disposed && !abort.signal.aborted) {
        handleDisconnect(abort, new Error("OpenCode event stream ended unexpectedly"));
      }
    }).catch((error) => {
      if (!disposed && !abort.signal.aborted) handleDisconnect(abort, normalizeError(error));
    });
  };

  const handleDisconnect = (abort: AbortController, error: Error) => {
    if (disposed || currentAbort !== abort) return;
    currentAbort = null;
    try {
      options.onFailure(error);
    } catch (failureError) {
      reportEventError(failureError);
    }
    const delay = Math.max(0, reconnectDelayMs(reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();
  return () => {
    disposed = true;
    currentAbort?.abort();
    currentAbort = null;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a port for OpenCode"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  output: () => string,
  spawnError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError()) throw spawnError()!;
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited with code ${child.exitCode}: ${output().trim()}`);
    }
    try {
      const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting OpenCode server: ${output().trim()}`);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function openCodeServerConfig(raw: string | undefined): string {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {
    // Ignore malformed inherited inline config; OpenCode will still load its files.
  }
  const permission = existing.permission && typeof existing.permission === "object" && !Array.isArray(existing.permission)
    ? existing.permission as Record<string, unknown>
    : {};
  return JSON.stringify({ ...existing, permission: { "*": "ask", ...permission } });
}
