import type { DesktopLiveStatus } from "./desktop-screen-live.js";
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
type ServiceRequest = (path: string, method: "GET" | "POST", body?: string) => Promise<{
    status: number;
    body: string;
}>;
export declare function mapRemoteAuthorizationStatus(raw: RemoteAuthorizationStatus): DesktopLiveCliStatus;
/** Desktop-side control surface for the CLI-owned native remote desktop. */
export declare class DesktopLiveCliProxy {
    private readonly options;
    private current;
    private timer;
    private refreshPromise;
    constructor(options: {
        request: ServiceRequest;
        onStatus?: (status: DesktopLiveCliStatus) => void;
        pollIntervalMs?: number;
    });
    getCachedStatus(): DesktopLiveCliStatus;
    start(): void;
    close(): void;
    refresh(): Promise<DesktopLiveCliStatus>;
    action(action: "authorize" | "enable" | "disable" | "recheck" | "restart", permission?: "screen" | "accessibility"): Promise<DesktopLiveCliStatus>;
    private request;
}
export {};
//# sourceMappingURL=desktop-live-cli-proxy.d.ts.map