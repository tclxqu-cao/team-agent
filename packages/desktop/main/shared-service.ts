import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { createMobilePairingInvitation, pairingOrigin } from "./mobile-pairing.js";
import type { TunnelStatus } from "../../shared/src/contracts/tunnel-status";

export interface ServiceDescriptor {
  protocol: 1; instanceId: string; pid: number; url: string; dataDir: string; token: string;
}
export type ServiceChoice = Pick<ServiceDescriptor, "instanceId" | "url" | "dataDir">;
export type StreamFrame = { id: string; type: "open" | "data" | "end" | "error"; data?: string };
export type TerminalSocketFrame =
  | { type: "open" }
  | { type: "data"; data: string | Uint8Array }
  | { type: "close"; code: number };
export interface NotificationReadScope { serviceId: string; ownerId: string; }

const terminalRequests = new Set([
  "ping", "term:start", "term:input", "term:focus", "term:request-write", "term:resize", "term:set-cwd",
]);

export function isTerminalSocketInput(data: unknown): data is string | Uint8Array {
  if (typeof data === "string" && data.length <= 2_000_000) {
    try { return terminalRequests.has(JSON.parse(data)?.type); } catch { return false; }
  }
  return data instanceof Uint8Array && data.length >= 6 && data.length <= 2_000_000
    && data[0] === 1 && data[1] === 1;
}

export function validDescriptor(value: unknown): value is ServiceDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as ServiceDescriptor;
  if (d.protocol !== 1 || typeof d.instanceId !== "string" || typeof d.dataDir !== "string" || !Number.isSafeInteger(d.pid) || d.pid <= 0 || !/^[a-f0-9]{64}$/.test(d.token)) return false;
  try { const url = new URL(d.url); return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}

export function serviceApiUrl(origin: string, path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("\\")) throw new Error("Invalid service API path");
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith("/api/")) throw new Error("Invalid service API path");
  return url.href;
}

/** No business storage and no child process ownership: this is only a client. */
export class SharedServiceConnection {
  private selected: ServiceDescriptor | null = null;
  private preferredDataDir: string | null = null;
  private readonly streams = new Map<string, AbortController>();
  private readonly terminalSockets = new Map<string, { controller: AbortController; socket?: WebSocket }>();
  constructor(
    private readonly selectionPath: string,
    private readonly registry = process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), ".agentroam", "services"),
    private readonly request: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
    try { const saved = JSON.parse(await readFile(this.selectionPath, "utf8")); if (typeof saved.dataDir === "string") this.preferredDataDir = saved.dataDir; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取上次连接的服务，请检查连接设置文件"); }
  }

  private async verify(d: ServiceDescriptor): Promise<boolean> {
    try {
      const res = await this.request(`${d.url}/api/desktop/identity`, { headers: { "x-agentroam-desktop-token": d.token }, signal: AbortSignal.timeout(1500), redirect: "error" });
      if (!res.ok) return false;
      const identity = await res.json() as Partial<ServiceDescriptor>;
      return identity.protocol === 1 && identity.instanceId === d.instanceId && identity.dataDir === d.dataDir;
    } catch { return false; }
  }

  private async discover(): Promise<ServiceDescriptor[]> {
    const names = await readdir(this.registry).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const results = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const value: unknown = JSON.parse(await readFile(join(this.registry, name), "utf8"));
        if (validDescriptor(value) && await this.verify(value)) return value;
      } catch {}
      return null;
    }));
    return results.filter((d): d is ServiceDescriptor => d !== null);
  }

  async status() {
    const found = await this.discover();
    if (this.selected && !found.some((d) => d.instanceId === this.selected!.instanceId)) {
      this.closeStreams(); this.selected = null;
    }
    if (!this.selected) {
      const candidates = this.preferredDataDir ? found.filter((d) => d.dataDir === this.preferredDataDir) : found;
      if (candidates.length === 1) {
        this.selected = candidates[0];
        this.preferredDataDir = candidates[0].dataDir;
        await mkdir(dirname(this.selectionPath), { recursive: true });
        await writeFile(this.selectionPath, JSON.stringify({ dataDir: this.preferredDataDir }), { mode: 0o600 });
      }
    }
    return { connected: !!this.selected, selected: this.selected ? publicChoice(this.selected) : null, choices: found.map(publicChoice), preferredDataDir: this.preferredDataDir };
  }

  async select(instanceId: string) {
    const found = (await this.discover()).find((d) => d.instanceId === instanceId);
    if (!found) throw new Error("服务已离线，请重新选择");
    this.closeStreams();
    this.selected = found; this.preferredDataDir = found.dataDir;
    await mkdir(dirname(this.selectionPath), { recursive: true });
    await writeFile(this.selectionPath, JSON.stringify({ dataDir: found.dataDir }), { mode: 0o600 });
    return publicChoice(found);
  }

  async json(path: string, method: string, body?: string, descriptor?: ServiceDescriptor): Promise<{ status: number; body: string }> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method) || (body?.length ?? 0) > 20_000_000) throw new Error("Invalid service request");
    const d = descriptor ?? await this.connection();
    const res = await this.request(serviceApiUrl(d.url, path), { method, ...(body === undefined ? {} : { body }), headers: { "content-type": "application/json", "x-agentroam-desktop-token": d.token }, signal: AbortSignal.timeout(path === "/api/agent/codex-sharing" ? 180_000 : 30_000), redirect: "error" });
    return { status: res.status, body: await res.text() };
  }

  /** Scope verification and acknowledgement must use one captured credential.
   * Selecting another service while the check is in flight cannot redirect a write. */
  async readNotification(id: string, expected: NotificationReadScope): Promise<{ ok: true }> {
    if (typeof id !== "string" || !id || id.length > 400 || /[\0\r\n]/.test(id)
      || !expected || typeof expected.serviceId !== "string" || !expected.serviceId
      || typeof expected.ownerId !== "string" || !expected.ownerId
      || expected.serviceId.length > 400 || expected.ownerId.length > 400
      || /[\0\r\n]/.test(expected.serviceId + expected.ownerId)) throw new Error("Invalid notification read scope");
    const descriptor = await this.connection();
    const headers = { "content-type": "application/json", "x-agentroam-desktop-token": descriptor.token };
    const identity = await this.request(serviceApiUrl(descriptor.url, "/api/notifications"), {
      method: "GET", headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!identity.ok) throw new Error("Notification read identity check failed");
    const scope = await identity.json() as Partial<NotificationReadScope>;
    if (scope.serviceId !== expected.serviceId || scope.ownerId !== expected.ownerId) throw new Error("Notification scope changed");
    const response = await this.request(serviceApiUrl(descriptor.url, `/api/notifications/${encodeURIComponent(id)}/ack`), {
      method: "POST", headers, body: JSON.stringify({ read: true }), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok && response.status !== 404) throw new Error("Notification read acknowledgement failed");
    return { ok: true };
  }

  async meshPairingOrigin(instanceId: string): Promise<string | null> {
    const descriptor = (await this.discover()).find(candidate => candidate.instanceId === instanceId);
    return descriptor ? this.readMeshPairingOrigin(descriptor) : null;
  }

  private async readMeshPairingOrigin(descriptor: ServiceDescriptor): Promise<string | null> {
    try {
      const response = await this.json("/api/mesh/status", "GET", undefined, descriptor);
      const mesh = response.status === 200 ? JSON.parse(response.body) : null;
      return mesh?.phase === "joined" && typeof mesh.accessUrl === "string" ? pairingOrigin(mesh.accessUrl) : null;
    } catch { return null; }
  }

  async mobilePairing() {
    const descriptor = await this.connection();
    const mesh = await this.readMeshPairingOrigin(descriptor);
    const mint = () => this.json("/api/pairing/admin/qr", "POST", "{}", descriptor);
    if (mesh) return { ...await createMobilePairingInvitation(descriptor.dataDir, mint, mesh), viaMesh: true };
    const tunnel = await this.tunnelRequest("/api/desktop/tunnel", "GET", descriptor);
    return createMobilePairingInvitation(descriptor.dataDir, mint, tunnel.phase === "unsupported" ? undefined : tunnel.accessUrl);
  }

  tunnelStatus(): Promise<TunnelStatus> { return this.tunnelRequest("/api/desktop/tunnel", "GET"); }
  connectTunnel(): Promise<TunnelStatus> { return this.tunnelRequest("/api/desktop/tunnel/connect", "POST"); }
  private async tunnelRequest(path: string, method: string, descriptor?: ServiceDescriptor): Promise<TunnelStatus> {
    const response = await this.json(path, method, method === "POST" ? "{}" : undefined, descriptor);
    const unsupported: TunnelStatus = { phase: "unsupported", mode: "local", provider: "lan", error: "当前后台不支持公网连接控制，请升级后台服务。" };
    if ([404, 405, 501].includes(response.status)) return unsupported;
    if (![200, 202, 503].includes(response.status)) throw new Error("无法读取公网连接状态，请检查后台服务。");
    let value: TunnelStatus;
    try { value = JSON.parse(response.body); } catch { return unsupported; }
    if (!value || !["idle", "connecting", "ready", "error", "unsupported"].includes(value.phase)
      || !["local", "lan", "public"].includes(value.mode) || !["lan", "cloudflare", "pinggy", "custom"].includes(value.provider)) return unsupported;
    return value;
  }

  async stream(id: string, path: string, lastEventId: string, send: (frame: StreamFrame) => void): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || typeof lastEventId !== "string" || /[\r\n]/.test(lastEventId)) throw new Error("Invalid stream request");
    if (!(path.startsWith("/api/agent/stream?") || path === "/api/notifications/stream" || /^\/api\/sessions\/[^/]+\/changes(?:\?|$)/.test(path))) throw new Error("Invalid stream path");
    this.stop(id);
    const controller = new AbortController(); this.streams.set(id, controller);
    try {
      const d = await this.connection();
      if (controller.signal.aborted) return;
      const res = await this.request(serviceApiUrl(d.url, path), { headers: { "x-agentroam-desktop-token": d.token, ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, signal: controller.signal, redirect: "error" });
      if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) throw new Error("事件流连接失败");
      send({ id, type: "open" });
      const reader = res.body.getReader(); const decoder = new TextDecoder();
      try {
        while (!controller.signal.aborted) {
          const result = await reader.read(); if (result.done) break;
          send({ id, type: "data", data: decoder.decode(result.value, { stream: true }) });
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!controller.signal.aborted) send({ id, type: "end" });
    } catch {
      if (!controller.signal.aborted) send({ id, type: "error" });
    } finally { if (this.streams.get(id) === controller) this.streams.delete(id); }
  }

  async openTerminal(id: string, send: (frame: TerminalSocketFrame) => void): Promise<void> {
    this.stop(id);
    const connection: { controller: AbortController; socket?: WebSocket } = { controller: new AbortController() };
    this.terminalSockets.set(id, connection);
    try {
      const descriptor = await this.connection();
      const headers = { "x-agentroam-desktop-token": descriptor.token };
      const response = await this.request(serviceApiUrl(descriptor.url, "/api/web-console/bootstrap"), {
        headers, signal: AbortSignal.any([connection.controller.signal, AbortSignal.timeout(10_000)]), redirect: "error",
      });
      if (!response.ok) throw new Error("本机终端连接验证失败");
      const { wsNonce } = await response.json() as { wsNonce?: string };
      if (!wsNonce) throw new Error("本机服务没有返回终端连接凭据");
      if (connection.controller.signal.aborted) return;
      const endpoint = new URL("/ws", descriptor.url);
      const origin = endpoint.origin;
      endpoint.protocol = "ws:";
      endpoint.searchParams.set("nonce", wsNonce);
      const socket = new WebSocket(endpoint, { origin, headers, handshakeTimeout: 10_000 });
      connection.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.on("open", () => send({ type: "open" }));
      socket.on("message", (data, binary) => send({ type: "data", data: binary ? new Uint8Array(data as ArrayBuffer) : data.toString() }));
      socket.on("error", () => {});
      socket.on("close", (code) => {
        if (this.terminalSockets.get(id) === connection) this.terminalSockets.delete(id);
        send({ type: "close", code });
      });
    } catch (error) {
      if (this.terminalSockets.get(id) === connection) this.terminalSockets.delete(id);
      if (!connection.controller.signal.aborted) throw error;
    }
  }

  sendTerminal(id: string, data: unknown): void {
    const socket = this.terminalSockets.get(id)?.socket;
    if (socket?.readyState === WebSocket.OPEN && isTerminalSocketInput(data)) socket.send(data);
  }

  stop(id: string): void {
    this.streams.get(id)?.abort();
    this.streams.delete(id);
    const terminal = this.terminalSockets.get(id);
    this.terminalSockets.delete(id);
    terminal?.controller.abort();
    terminal?.socket?.close();
  }

  closeStreams(): void {
    for (const id of this.streams.keys()) this.stop(id);
    for (const id of this.terminalSockets.keys()) this.stop(id);
  }
  private async connection(): Promise<ServiceDescriptor> {
    if (!this.selected) await this.status();
    if (!this.selected) throw new Error("未连接统一服务，请先启动 agentroam 并选择服务");
    return this.selected;
  }
}
function publicChoice(d: ServiceDescriptor): ServiceChoice { return { instanceId: d.instanceId, url: d.url, dataDir: d.dataDir }; }
