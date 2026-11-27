const OWNERSHIP_STATES = new Set([
    "agent-controlled",
    "handoff-requested",
    "user-controlled",
    "return-requested",
    "resyncing",
]);
function screenPermission(value) {
    if (value === true)
        return "granted";
    if (value === false)
        return "denied";
    return "unknown";
}
function ownershipState(value) {
    return typeof value === "string" && OWNERSHIP_STATES.has(value)
        ? value
        : null;
}
export function mapRemoteAuthorizationStatus(raw) {
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
    constructor(options) {
        this.options = options;
        this.current = mapRemoteAuthorizationStatus({});
        this.timer = null;
        this.refreshPromise = null;
    }
    getCachedStatus() {
        return { ...this.current };
    }
    start() {
        if (this.timer)
            return;
        const interval = this.options.pollIntervalMs ?? 1_000;
        this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, interval);
        this.timer.unref?.();
        void this.refresh().catch(() => undefined);
    }
    close() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    refresh() {
        if (!this.refreshPromise) {
            this.refreshPromise = this.request("GET").finally(() => { this.refreshPromise = null; });
        }
        return this.refreshPromise;
    }
    action(action, permission) {
        return this.request("POST", JSON.stringify({ action, ...(permission ? { permission } : {}) }));
    }
    async request(method, body) {
        const response = await this.options.request("/api/remote-authorization", method, body);
        let payload;
        try {
            payload = JSON.parse(response.body);
        }
        catch {
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
//# sourceMappingURL=desktop-live-cli-proxy.js.map