import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { logGlobal } from "@agent/core";
import { createServer } from "node:net";
import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import type {
  EventPermissionAsked,
  EventPermissionReplied,
} from "@opencode-ai/sdk/v2/types";
import { RuntimeSessionError } from "./types.js";
import { createOpenCodeV2Client, type OpenCodeRuntimeClient } from "./opencode-v2-transport.js";
import { OPENCODE_INTERRUPTED_EVENT } from "./opencode-v2-codec.js";
import { createOpenCodeQuestionClient, type OpenCodeQuestionEvent } from "./opencode-questions.js";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";

const execFileAsync = promisify(execFile);

export interface OpenCodeServerEvent {
  directory: string;
  payload: GlobalEvent["payload"] | EventPermissionAsked | EventPermissionReplied
    | OpenCodeQuestionEvent
    | { type: typeof OPENCODE_INTERRUPTED_EVENT; properties: { sessionID: string } };
}

type EventListener = (event: OpenCodeServerEvent) => void;
type FailureListener = (error: Error) => void;

export class OpenCodeServerClient {
  private readonly executable: string;
  private readonly unavailableError?: string;
  private readonly environment: NodeJS.ProcessEnv;
  private startPromise: Promise<OpenCodeRuntimeClient> | null = null;
  private process: ChildProcess | null = null;
  private stopEventStream: (() => void) | null = null;
  private readonly listeners = new Set<EventListener>();
  private readonly failureListeners = new Set<FailureListener>();
  private readonly shutdown = new AbortController();
  private disposed = false;
  private readonly todoMcp?: NativeTodoMcpConfiguration;
  private connection?: { url: string; authorization?: string; v2: boolean };

  constructor(options: {
    executable?: string;
    unavailableError?: string;
    environment?: NodeJS.ProcessEnv;
    todoMcp?: NativeTodoMcpConfiguration;
  } = {}) {
    this.executable = options.executable?.trim() || "opencode";
    this.unavailableError = options.unavailableError?.trim() || undefined;
    this.environment = options.environment ?? process.env;
    this.todoMcp = options.todoMcp;
  }

  async waitForTodoMcp(directory: string, signal?: AbortSignal): Promise<void> {
    if (!this.todoMcp) return;
    signal?.throwIfAborted();
    await this.client();
    signal?.throwIfAborted();
    this.assertNotDisposed();
    const connection = this.connection;
    if (!connection) throw new Error("OpenCode Todo MCP host is unavailable");
    const url = new URL(connection.v2 ? "/api/mcp" : "/mcp", connection.url);
    url.searchParams.set(connection.v2 ? "location[directory]" : "directory", directory);
    const deadline = Date.now() + 30_000;
    while (true) {
      const response = await fetch(url, {
        headers: connection.authorization ? { Authorization: connection.authorization } : {},
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error(`OpenCode Todo MCP discovery HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const servers = Array.isArray(body.data) ? body.data as Array<{ name?: string; status?: { status?: string } }> : [];
      const state = connection.v2 ? servers.find(server => server.name === "agentroam-todo")?.status
        : body["agentroam-todo"] as { status?: string } | undefined;
      if (state?.status === "connected") return;
      if (state?.status && state.status !== "pending") throw new Error(`OpenCode Todo MCP is ${state.status}`);
      if (Date.now() >= deadline) throw new Error("OpenCode Todo MCP initialization timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async client(): Promise<OpenCodeRuntimeClient> {
    this.assertNotDisposed();
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
    this.shutdown.abort();
    this.stopEventStream?.();
    this.stopEventStream = null;
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    this.connection = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    force.unref();
    await exited;
    clearTimeout(force);
  }

  private async start(): Promise<OpenCodeRuntimeClient> {
    let version: { stdout: string; stderr: string };
    try {
      version = await execFileAsync(this.executable, ["--version"], { encoding: "utf8", env: this.environment, timeout: 5_000, windowsHide: true, signal: this.shutdown.signal });
    } catch (error) {
      this.assertNotDisposed();
      throw error;
    }
    this.assertNotDisposed();
    const major = /(?:^|\s)v?(\d+)\./.exec(`${version.stdout}\n${version.stderr}`)?.[1];
    const v2 = Number(major) >= 2;
    const password = v2 ? randomBytes(32).toString("base64url") : undefined;
    const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
    const port = await reservePort();
    this.assertNotDisposed();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(this.executable, [
      "serve",
      ...(v2 ? ["--stdio"] : []),
      "--hostname=127.0.0.1",
      `--port=${port}`,
    ], {
      env: {
        ...this.environment,
        // Ask for side-effecting operations. AgentRoam applies the selected
        // per-session policy when OpenCode emits the permission request.
        OPENCODE_CONFIG_CONTENT: openCodeTodoConfig(
          v2 ? this.environment.OPENCODE_CONFIG_CONTENT : openCodeServerConfig(this.environment.OPENCODE_CONFIG_CONTENT), this.todoMcp, v2,
        ),
        ...(password ? { OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password } : {}),
      },
      stdio: [v2 ? "pipe" : "ignore", "pipe", "pipe"],
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
    child.once("error", (error) => {
      logGlobal("error", "opencode-server", "opencode server process error", error);
      spawnError = error;
    });

    try {
      await waitForHealth(url, child, () => output, () => spawnError, authorization, this.shutdown.signal);
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      if (this.process === child) this.process = null;
      this.startPromise = null;
      this.assertNotDisposed();
      throw error;
    }
    this.assertNotDisposed();

    const client = authorization ? createOpenCodeV2Client(url, authorization)
      : Object.assign(createOpencodeClient({ baseUrl: url, throwOnError: true }), {
        questions: createOpenCodeQuestionClient(url, "question"),
      });
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
    this.connection = { url, authorization, v2 };
    return client;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new RuntimeSessionError("OpenCode runtime has been disposed", "RUNTIME_UNAVAILABLE");
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

/** Process-local config: never edits a user's global or project MCP files. */
export function openCodeTodoConfig(content: string | undefined, configuration: NativeTodoMcpConfiguration | undefined, v2: boolean): string | undefined {
  if (!configuration) return content;
  const source = content ? JSON.parse(content) as Record<string, unknown> : {};
  const mcp = source.mcp && typeof source.mcp === "object" ? source.mcp as Record<string, unknown> : {};
  const server = { type: "local", command: [configuration.command, ...configuration.args], environment: { ...configuration.env },
    ...(v2 ? { disabled: false, pool: false } : { enabled: true }) };
  return JSON.stringify({ ...source, mcp: v2
    ? { ...mcp, servers: { ...(mcp.servers as Record<string, unknown> | undefined), "agentroam-todo": server } }
    : { ...mcp, "agentroam-todo": server } });
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
  authorization?: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (spawnError()) throw spawnError()!;
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited with code ${child.exitCode}: ${output().trim()}`);
    }
    try {
      const response = await fetch(`${url}${authorization ? "/api/info" : "/global/health"}`, {
        signal: AbortSignal.any([AbortSignal.timeout(1_000), ...(signal ? [signal] : [])]), headers: authorization ? { Authorization: authorization } : {},
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const identity = await response.json() as { version?: unknown; healthy?: unknown };
        if (authorization ? typeof identity.version === "string" : identity.healthy === true) return;
      }
    } catch {
      signal?.throwIfAborted();
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
