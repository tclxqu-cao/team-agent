import { AgentHttpGateway } from "../../../webapp/src/infrastructure/http/agent-http-gateway";
import { HttpClient } from "../../../webapp/src/infrastructure/http/http-client";
import { LocalSettingsRepository } from "../../../webapp/src/infrastructure/local/local-settings-repository";
import type { AgentApi } from "../global";

export interface SharedServiceStatus {
  connected: boolean;
  selected: { instanceId: string; dataDir: string; url: string } | null;
  choices: Array<{ instanceId: string; dataDir: string; url: string }>;
  preferredDataDir: string | null;
}
export interface SharedServiceApi {
  status(): Promise<SharedServiceStatus>;
  select(id: string): Promise<unknown>;
  request(path: string, method: string, body?: string): Promise<{ status: number; body: string }>;
  stream(id: string, path: string, lastEventId: string): Promise<void>;
  stop(id: string): Promise<void>;
  onFrame(listener: (frame: { id: string; type: string; data?: string }) => void): () => void;
}
declare global {
  interface Window { sharedServiceApi: SharedServiceApi; desktopDeviceApi: AgentApi; }
}

/** EventSource semantics over IPC, including incremental UTF-8/SSE frames and replay IDs. */
export class ServiceEventSource extends EventTarget {
  readonly id = crypto.randomUUID();
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private buffer = "";
  private lastEventId = "";
  private retry: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;
  constructor(private readonly url: string, private readonly api: SharedServiceApi) {
    super();
    this.unsubscribe = api.onFrame((frame) => {
      if (frame.id !== this.id || this.readyState === 2) return;
      if (frame.type === "open") { this.readyState = 1; const event = new Event("open"); this.onopen?.(event); this.dispatchEvent(event); }
      else if (frame.type === "data") this.consume(frame.data || "");
      else this.reconnect();
    });
    // Defer until the caller has attached the EventSource handlers.
    queueMicrotask(() => this.open());
  }
  private open() { if (this.readyState !== 2) void this.api.stream(this.id, this.url, this.lastEventId).catch(() => this.reconnect()); }
  private reconnect() {
    if (this.readyState === 2 || this.retry) return;
    this.readyState = 0; this.buffer = "";
    const event = new Event("error"); this.onerror?.(event); this.dispatchEvent(event);
    if (this.readyState !== 2) this.retry = setTimeout(() => { this.retry = undefined; this.open(); }, 1000);
  }
  private consume(chunk: string) {
    this.buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const data: string[] = []; let type = "message";
      for (const line of block.split(/\r?\n/)) {
        const colon = line.indexOf(":"); const key = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (key === "data") data.push(value);
        if (key === "event") type = value || "message";
        if (key === "id" && !value.includes("\0")) this.lastEventId = value;
      }
      if (!data.length) continue;
      const event = new MessageEvent(type, { data: data.join("\n"), lastEventId: this.lastEventId });
      if (type === "message") this.onmessage?.(event);
      this.dispatchEvent(event);
      if (this.readyState === 2) return;
    }
  }
  close() { this.readyState = 2; clearTimeout(this.retry); this.unsubscribe(); void this.api.stop(this.id).catch(() => undefined); }
}

export function createSharedAgentApi(api: SharedServiceApi, device: AgentApi): AgentApi {
  const transport: typeof fetch = async (path, init) => {
    try {
      const result = await api.request(String(path), init?.method || "GET", init?.body == null ? undefined : String(init.body));
      return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: { "content-type": "application/json" } });
    } catch (error) { window.dispatchEvent(new Event("shared-service:offline")); throw error; }
  };
  const gateway = new AgentHttpGateway(new HttpClient(transport), new LocalSettingsRepository(), undefined, (url) => new ServiceEventSource(url, api) as unknown as EventSource);
  const localNames = new Set([
    "openFileDialog",
    "showDirectoryContextMenu",
    "fileWorkspaceRequest",
    "onFileWorkspaceEvent",
    "readFile",
    "writeFile",
    "importSkill",
    "hideWindow",
    "showWindow",
    "isWindowVisible",
    "getUpdateStatus",
    "checkForUpdate",
    "installUpdate",
    "onUpdateStatus",
  ]);
  return new Proxy(gateway, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const local = localNames.has(key) || /^(hub|desktopLive|wake|dictation|tts|onWake|onDictation|onTts|onHub|onDesktop|onApp)/.test(key);
      const owner = local ? device : target;
      const value = Reflect.get(owner, key);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  }) as unknown as AgentApi;
}
