import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import { encodeLiveFramePacket, LIVE_FRAME_PACKET_TYPE } from "./frame-packet.js";

interface LiveSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer | Uint8Array): void;
  close(): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  once(event: "open", cb: () => void): void;
  once(event: "error", cb: (error: Error) => void): void;
}

type WebSocketFactory = (new (url: string, options: { headers: Record<string, string> }) => LiveSocket) & { OPEN: number };

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
}

function defaultWebSocketImplementation(): WebSocketFactory {
  return createRequire(import.meta.url)("ws");
}

function nodeFetch(url: string | URL, headers?: Record<string, string>, timeoutMs?: number): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.get(target, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
          status: response.statusCode ?? 500,
          async json() { return JSON.parse(body); },
        });
      });
    });
    if (timeoutMs) request.setTimeout(timeoutMs, () => request.destroy(new Error("Local service identity check timed out")));
    request.on("error", reject);
  });
}

function defaultFetchImplementation(url: string | URL, init?: { cache?: string; headers?: Record<string, string>; redirect?: "error" }): Promise<FetchResponse> {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, init as RequestInit) as Promise<FetchResponse>;
  return nodeFetch(url, init?.headers);
}

function toWsUrl(endpoint: string, nonce: string): string {
  const url = new URL("/ws", endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export interface PublishLiveSessionMetadata {
  sessionId: string;
  [key: string]: unknown;
}

/** Infrastructure client used inside producer runtimes to publish live frames over the authenticated `/ws`. */
export class LiveViewProducerClient {
  private readonly endpoint: string;
  private readonly fetchImpl: (url: string | URL, init?: { cache?: string; headers?: Record<string, string>; redirect?: "error" }) => Promise<FetchResponse>;
  private readonly WebSocketImpl: WebSocketFactory;
  private readonly timeoutMs: number;
  private socket: LiveSocket | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  private readonly channels = new Map<string, number>();
  private readonly metadata = new Map<string, PublishLiveSessionMetadata>();
  private closePromise: Promise<void> = Promise.resolve();
  private resolveClose: (() => void) | null = null;
  private readonly sessionClosePromises = new Map<string, Promise<unknown>>();

  constructor({ endpoint, fetchImpl = defaultFetchImplementation, WebSocketImpl = defaultWebSocketImplementation(), timeoutMs = 15_000 }: {
    endpoint: string;
    fetchImpl?: (url: string | URL, init?: { cache?: string; headers?: Record<string, string>; redirect?: "error" }) => Promise<FetchResponse>;
    WebSocketImpl?: WebSocketFactory;
    timeoutMs?: number;
  }) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
  }

  async connect(): Promise<void> {
    const bootstrapUrl = new URL("/api/web-console/bootstrap", this.endpoint);
    const headers = await localServiceHeaders(this.endpoint);
    const response = await this.fetchImpl(bootstrapUrl, { cache: "no-store", ...(Object.keys(headers).length ? { headers, redirect: "error" as const } : {}) });
    if (!response.ok) throw new Error(`browser bridge bootstrap failed (${response.status})`);
    const { wsNonce } = await response.json();
    if (typeof wsNonce !== "string" || !wsNonce) throw new Error("browser bridge bootstrap returned no nonce");
    const origin = new URL(this.endpoint).origin;
    const socket = new this.WebSocketImpl(toWsUrl(this.endpoint, wsNonce), { headers: { Origin: origin, ...headers } });
    this.socket = socket;
    this.sessionClosePromises.clear();
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    socket.on("message", (raw) => this.#onMessage(raw));
    socket.on("close", () => {
      this.socket = null;
      this.#failPending(new Error("browser bridge disconnected"));
      this.resolveClose?.();
      this.resolveClose = null;
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser bridge connection timeout")), this.timeoutMs);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async publish(metadata: PublishLiveSessionMetadata): Promise<{ channelId: number }> {
    const result = await this.rpc("browser:publish", metadata);
    const channelId = Number(result.channelId);
    this.channels.set(metadata.sessionId, channelId);
    this.metadata.set(metadata.sessionId, metadata);
    return { channelId };
  }

  async frame(sessionId: string, frame: { sequence: number; data: Uint8Array | string; title?: string; url?: string; viewport?: unknown }): Promise<{ accepted: boolean; dropped?: string }> {
    const previous = (this.metadata.get(sessionId) ?? {}) as Partial<PublishLiveSessionMetadata>;
    const next = {
      ...previous,
      title: frame.title,
      url: frame.url,
      viewport: frame.viewport,
      availability: "ready",
      capabilityError: undefined,
      capabilityErrorCode: undefined,
    };
    if (JSON.stringify([previous.title, previous.url, previous.viewport]) !== JSON.stringify([next.title, next.url, next.viewport])) {
      await this.publish(next as unknown as PublishLiveSessionMetadata);
    }
    const channelId = this.channels.get(sessionId);
    const socket = this.socket;
    if (!channelId || !socket || socket.readyState !== this.WebSocketImpl.OPEN) throw new Error("browser bridge is not connected");
    if (socket.bufferedAmount > 2 * 1024 * 1024) return { accepted: false, dropped: "backpressure" };
    const jpeg = typeof frame.data === "string" ? Buffer.from(frame.data, "base64") : Buffer.from(frame.data);
    socket.send(encodeLiveFramePacket({ type: LIVE_FRAME_PACKET_TYPE.producerFrame, channelId, sequence: frame.sequence, payload: jpeg }));
    return { accepted: true };
  }

  state(sessionId: string, state: string): Promise<unknown> {
    return this.rpc("browser:producer-state", { sessionId, state });
  }

  inputResult(sessionId: string, token: number, result: unknown): Promise<unknown> {
    return this.rpc("browser:input-result", { sessionId, token, result });
  }

  webrtcRelay(sessionId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.rpc("browser:webrtc-relay", { sessionId, data });
  }

  unavailable(sessionId: string, error: unknown): Promise<unknown> {
    const previous = this.metadata.get(sessionId);
    if (!previous) return Promise.reject(new Error("browser session is not published"));
    return this.publish({
      ...previous,
      availability: "unavailable",
      capabilityError: error instanceof Error ? error.message : String(error),
      capabilityErrorCode: (error as { code?: string })?.code || "BROWSER_LIVE_STREAM_UNAVAILABLE",
    });
  }

  waitForDisconnect(): Promise<void> {
    return this.closePromise;
  }

  close(sessionId: string): Promise<unknown> {
    const existing = this.sessionClosePromises.get(sessionId);
    if (existing) return existing;
    const request = this.rpc("browser:close", { sessionId }).finally(() => this.disconnect());
    this.sessionClosePromises.set(sessionId, request);
    return request;
  }

  rpc(type: string, payload: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error("browser bridge is not connected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type, _req: id, ...payload }));
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) try { socket.close(); } catch {}
    this.#failPending(new Error("browser bridge closed"));
    this.resolveClose?.();
    this.resolveClose = null;
  }

  #onMessage(raw: Buffer): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (message.id != null && (message.type === "error" || String(message.type).endsWith(":result"))) {
      const request = this.pending.get(message.id as number);
      if (!request) return;
      this.pending.delete(message.id as number);
      clearTimeout(request.timer);
      if (message.type === "error") request.reject(Object.assign(new Error(String(message.error || "browser bridge error")), { code: message.code }));
      else request.resolve(message);
      return;
    }
    if (typeof message.type === "string" && message.type.startsWith("browser:")) {
      for (const listener of this.listeners) listener(message);
    }
  }

  #failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

/** Never forward a local service credential to a remote producer endpoint. */
async function localServiceHeaders(endpoint: string): Promise<Record<string, string>> {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return {};
  if (url.origin === process.env.AGENTROAM_LOCAL_SERVICE_URL && process.env.AGENTROAM_LOCAL_SERVICE_TOKEN) {
    return { "x-agentroam-desktop-token": process.env.AGENTROAM_LOCAL_SERVICE_TOKEN };
  }
  const registry = process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), ".agentroam", "services");
  const files = await readdir(registry).catch(() => []);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const d = JSON.parse(await readFile(join(registry, file), "utf8"));
      if (d.protocol !== 1 || d.url !== url.origin || typeof d.instanceId !== "string" || typeof d.dataDir !== "string" || !/^[a-f0-9]{64}$/.test(d.token)) continue;
      // Ports survive service restarts; credentials and instance identities do not.
      // Node HTTP does not follow redirects, so this credential stays on loopback.
      const headers = { "x-agentroam-desktop-token": d.token };
      const response = await nodeFetch(new URL("/api/desktop/identity", url), headers, 1500);
      if (!response.ok) continue;
      const identity = await response.json();
      if (identity.protocol === 1 && identity.instanceId === d.instanceId && identity.dataDir === d.dataDir) return headers;
    } catch { /* stale descriptor */ }
  }
  return {};
}
