import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceDescriptor {
  protocol: 1; instanceId: string; pid: number; url: string; dataDir: string; token: string;
}
export type ServiceChoice = Pick<ServiceDescriptor, "instanceId" | "url" | "dataDir">;
export type StreamFrame = { id: string; type: "open" | "data" | "end" | "error"; data?: string };

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

  async json(path: string, method: string, body?: string): Promise<{ status: number; body: string }> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method) || (body?.length ?? 0) > 20_000_000) throw new Error("Invalid service request");
    const d = await this.connection();
    const res = await this.request(serviceApiUrl(d.url, path), { method, ...(body === undefined ? {} : { body }), headers: { "content-type": "application/json", "x-agentroam-desktop-token": d.token }, signal: AbortSignal.timeout(30_000), redirect: "error" });
    return { status: res.status, body: await res.text() };
  }

  async stream(id: string, path: string, lastEventId: string, send: (frame: StreamFrame) => void): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || typeof lastEventId !== "string" || /[\r\n]/.test(lastEventId)) throw new Error("Invalid stream request");
    if (!(path.startsWith("/api/agent/stream?") || /^\/api\/sessions\/[^/]+\/changes(?:\?|$)/.test(path))) throw new Error("Invalid stream path");
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

  stop(id: string) { this.streams.get(id)?.abort(); this.streams.delete(id); }
  closeStreams() { for (const controller of this.streams.values()) controller.abort(); this.streams.clear(); }
  private async connection(): Promise<ServiceDescriptor> {
    if (!this.selected) await this.status();
    if (!this.selected) throw new Error("未连接统一服务，请先启动 agentroam 并选择服务");
    return this.selected;
  }
}
function publicChoice(d: ServiceDescriptor): ServiceChoice { return { instanceId: d.instanceId, url: d.url, dataDir: d.dataDir }; }
