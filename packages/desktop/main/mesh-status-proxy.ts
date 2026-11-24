type ServiceRequest = (path: string, method: "GET" | "POST", body?: string) => Promise<{ status: number; body: string }>;

export interface MeshStatus {
  configured: boolean;
  controlPlaneUrl: string | null;
  phase: string;
  hostname: string | null;
  tailnetIPv4: string | null;
  dnsName: string | null;
  user: string | null;
  joinedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

const EMPTY: MeshStatus = {
  configured: false, controlPlaneUrl: null, phase: "unknown", hostname: null,
  tailnetIPv4: null, dnsName: null, user: null, joinedAt: null, lastError: null, updatedAt: null,
};

function parse(raw: unknown): MeshStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" ? value[key] as string : null;
  return {
    configured: value.configured === true,
    controlPlaneUrl: text("controlPlaneUrl"),
    phase: text("phase") ?? "unknown",
    hostname: text("hostname"),
    tailnetIPv4: text("tailnetIPv4"),
    dnsName: text("dnsName"),
    user: text("user"),
    joinedAt: text("joinedAt"),
    lastError: text("lastError"),
    updatedAt: text("updatedAt"),
  };
}

/**
 * 桌面端组网状态镜像：轮询本机服务 /api/mesh/status 并推给渲染层。
 * 只读镜像——入网动作由 CLI/服务进程执行，桌面端不持任何控制面凭证。
 */
export class MeshStatusProxy {
  private current: MeshStatus = EMPTY;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<MeshStatus> | null = null;

  constructor(private readonly options: {
    request: ServiceRequest;
    onStatus?: (status: MeshStatus) => void;
    pollIntervalMs?: number;
  }) {}

  getCachedStatus(): MeshStatus {
    return { ...this.current };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.options.pollIntervalMs ?? 5_000);
    this.timer.unref?.();
    void this.refresh().catch(() => undefined);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<MeshStatus> {
    if (!this.inFlight) {
      this.inFlight = this.request().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async request(): Promise<MeshStatus> {
    const response = await this.options.request("/api/mesh/status", "GET");
    if (response.status >= 400) return this.getCachedStatus();
    let next: MeshStatus | null = null;
    try { next = parse(JSON.parse(response.body || "{}")); } catch { /* 忽略瞬时坏响应 */ }
    if (!next) return this.getCachedStatus();
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.options.onStatus?.(this.getCachedStatus());
    }
    return this.getCachedStatus();
  }
}
