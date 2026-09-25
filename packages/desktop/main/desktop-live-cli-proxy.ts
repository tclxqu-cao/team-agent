import type { LiveViewOwnershipState } from "@agent/core";
import type { DesktopLiveStatus, ScreenPermission } from "./desktop-screen-live.js";

const OWNERSHIP_STATES = new Set<LiveViewOwnershipState>([
  "agent-controlled",
  "handoff-requested",
  "user-controlled",
  "return-requested",
  "resyncing",
]);

export interface RemoteAuthorizationStatus {
  platform?: unknown;
  supported?: unknown;
  installed?: unknown;
  enabled?: unknown;
  screen?: unknown;
  accessibility?: unknown;
  online?: unknown;
  error?: unknown;
  locked?: unknown;
  viewerCount?: unknown;
  controlState?: unknown;
}

export interface DesktopLiveCliStatus extends DesktopLiveStatus {
  platform: string | null;
  supported: boolean;
  installed: boolean;
  locked: boolean | null;
  viewerCount: number;
}

type ServiceRequest = (path: string, method: "GET" | "POST", body?: string) => Promise<{ status: number; body: string }>;

function screenPermission(value: unknown): ScreenPermission {
  if (value === true) return "granted";
  if (value === false) return "denied";
  return "unknown";
}

function ownershipState(value: unknown): LiveViewOwnershipState | null {
  return typeof value === "string" && OWNERSHIP_STATES.has(value as LiveViewOwnershipState)
    ? value as LiveViewOwnershipState
    : null;
}

export function mapRemoteAuthorizationStatus(raw: RemoteAuthorizationStatus): DesktopLiveCliStatus {
  return {
    enabled: raw.enabled === true,
    permissionScreen: screenPermission(raw.screen),
    accessibilityTrusted: typeof raw.accessibility === "boolean" ? raw.accessibility : null,
    sessionOnline: raw.online === true,
    controlState: ownershipState(raw.controlState),
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
    platform: typeof raw.platform === "string" ? raw.platform : null,
    supported: raw.supported === true,
    installed: raw.installed === true,
    locked: typeof raw.locked === "boolean" ? raw.locked : null,
    viewerCount: Number.isSafeInteger(raw.viewerCount) && Number(raw.viewerCount) > 0 ? Number(raw.viewerCount) : 0,
  };
}

/** Desktop-side control surface for the CLI-owned native remote desktop. */
export class DesktopLiveCliProxy {
  private current: DesktopLiveCliStatus = mapRemoteAuthorizationStatus({});
  private timer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<DesktopLiveCliStatus> | null = null;

  constructor(private readonly options: {
    request: ServiceRequest;
    onStatus?: (status: DesktopLiveCliStatus) => void;
    pollIntervalMs?: number;
  }) {}

  getCachedStatus(): DesktopLiveCliStatus {
    return { ...this.current };
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, interval);
    this.timer.unref?.();
    void this.refresh().catch(() => undefined);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<DesktopLiveCliStatus> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.request("GET").finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  action(action: "authorize" | "enable" | "disable" | "recheck" | "restart", permission?: "screen" | "accessibility"): Promise<DesktopLiveCliStatus> {
    return this.request("POST", JSON.stringify({ action, ...(permission ? { permission } : {}) }));
  }

  private async request(method: "GET" | "POST", body?: string): Promise<DesktopLiveCliStatus> {
    const response = await this.options.request("/api/remote-authorization", method, body);
    let payload: RemoteAuthorizationStatus & { error?: unknown };
    try {
      payload = JSON.parse(response.body) as RemoteAuthorizationStatus & { error?: unknown };
    } catch {
      throw new Error("CLI 远程桌面返回了无效响应");
    }
    if (response.status >= 400) {
      throw new Error(typeof payload.error === "string" && payload.error ? payload.error : "CLI 远程桌面请求失败");
    }
    const next = mapRemoteAuthorizationStatus(payload);
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.options.onStatus?.(this.getCachedStatus());
    }
    return this.getCachedStatus();
  }
}
