import { LiveViewProducer } from "@agent/core";
export const DESKTOP_LIVE_SESSION_ID = "desktop:primary";
const SCREEN_PERMISSION_HINT = "需要在「系统设置 → 隐私与安全性 → 屏幕录制」中授权桌面 App 后才能直播桌面画面";
const ACCESSIBILITY_HINT = "画面已可观看；接管控制前需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权桌面 App";
/** Composition root that publishes the primary display as a live-view session and relays remote input. */
export class DesktopScreenLive {
    constructor({ clientFactory, screencast, input, probeScreen = () => "unknown", probeAccessibility = async () => null, keepAwake = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onWebrtcFromViewer = () => undefined, getDisplayOptions, onSetDisplay = null }) {
        this.enabled = false;
        this.enablePromise = null;
        this.loopPromise = null;
        this.currentClient = null;
        this.unsubscribeState = null;
        this.viewerCount = 0;
        this.status = {
            enabled: false,
            permissionScreen: "unknown",
            accessibilityTrusted: null,
            sessionOnline: false,
            controlState: null,
        };
        this.listeners = new Set();
        this.clientFactory = clientFactory;
        this.screencast = screencast;
        this.input = input;
        this.metadata = { sessionId: DESKTOP_LIVE_SESSION_ID, backend: "desktop", title: "桌面屏幕", url: "", platform: process.platform };
        this.probeScreen = probeScreen;
        this.probeAccessibility = probeAccessibility;
        this.keepAwake = keepAwake;
        this.sleep = sleep;
        this.onWebrtcFromViewer = onWebrtcFromViewer;
        this.getDisplayOptions = getDisplayOptions ?? null;
        this.onSetDisplay = onSetDisplay ?? null;
    }
    onStatus(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    getStatus() {
        return { ...this.status };
    }
    async refreshPermissions() {
        this.status.permissionScreen = await this.probeScreen();
        this.status.accessibilityTrusted = await this.#probeAccessibility();
        if ((this.status.error === ACCESSIBILITY_HINT && this.status.accessibilityTrusted === true) ||
            (this.status.error === SCREEN_PERMISSION_HINT && this.status.permissionScreen === "granted"))
            this.status.error = undefined;
        this.#emit();
        return this.getStatus();
    }
    enable() {
        if (!this.enablePromise)
            this.enablePromise = this.#enable().finally(() => { this.enablePromise = null; });
        return this.enablePromise;
    }
    async #enable() {
        if (this.enabled && this.loopPromise)
            return this.refreshPermissions();
        this.enabled = true;
        this.status = { ...this.status, enabled: true, error: undefined };
        const screen = await this.probeScreen();
        if (!this.enabled)
            return this.getStatus();
        this.status.permissionScreen = screen;
        if (screen !== "granted") {
            this.status.error = SCREEN_PERMISSION_HINT;
            this.#emit();
            return this.getStatus();
        }
        try {
            await this.input.start();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : String(error);
            this.#emit();
            return this.getStatus();
        }
        this.status.accessibilityTrusted = await this.#probeAccessibility();
        if (!this.enabled) {
            await this.input.stop();
            return this.getStatus();
        }
        if (this.status.accessibilityTrusted === false)
            this.status.error = ACCESSIBILITY_HINT;
        // Registration, not merely starting the capture helper, establishes connectivity.
        this.#emit();
        if (!this.loopPromise) {
            this.loopPromise = this.#runLoop().finally(() => {
                this.loopPromise = null;
            });
        }
        return this.getStatus();
    }
    async disable() {
        this.enabled = false;
        this.status = { ...this.status, enabled: false, sessionOnline: false, controlState: null, error: undefined };
        this.#syncViewerCount(0);
        this.unsubscribeState?.();
        this.unsubscribeState = null;
        await this.input.stop().catch(() => undefined);
        const client = this.currentClient;
        this.currentClient = null;
        if (client) {
            await client.close(this.metadata.sessionId).catch(() => client.disconnect());
        }
        this.#emit();
        return this.getStatus();
    }
    async #runLoop() {
        let backoffMs = 1_000;
        while (this.enabled) {
            try {
                const client = await this.clientFactory();
                if (!this.enabled) {
                    await client.disconnect();
                    return;
                }
                this.currentClient = client;
                this.unsubscribeState?.();
                this.unsubscribeState = client.onEvent((event) => {
                    if (event.type === "browser:webrtc" && event.sessionId === this.metadata.sessionId) {
                        const data = event.data;
                        if (data && typeof data === "object")
                            this.onWebrtcFromViewer(data);
                        return;
                    }
                    this.#handleRelayEvent(event);
                });
                const producer = new LiveViewProducer({
                    client,
                    screencast: this.screencast,
                    metadata: { ...this.metadata, displays: this.getDisplayOptions?.() ?? null },
                    // The desktop source has no agent gate to pause; ownership still flows through the shared state machine.
                    pauseAgent: async () => undefined,
                    resyncAgent: async () => undefined,
                    onPublished: () => {
                        if (!this.enabled)
                            return;
                        this.status = { ...this.status, sessionOnline: true, error: this.status.accessibilityTrusted === false ? ACCESSIBILITY_HINT : undefined };
                        this.#emit();
                    },
                    onError: (error) => {
                        this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
                        this.#emit();
                    },
                    onSetDisplay: this.onSetDisplay,
                });
                await producer.run();
            }
            catch (error) {
                this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
                this.#emit();
            }
            this.#syncViewerCount(0);
            this.unsubscribeState?.();
            this.unsubscribeState = null;
            this.currentClient?.disconnect();
            this.currentClient = null;
            this.status = { ...this.status, sessionOnline: false };
            this.#emit();
            if (!this.enabled)
                return;
            await this.sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 30_000);
        }
    }
    #handleRelayEvent(event) {
        const session = event.session;
        if (!session || session.id !== this.metadata.sessionId)
            return;
        this.#syncViewerCount(session.viewerCount);
        if (!session.state)
            return;
        this.status = { ...this.status, controlState: session.state };
        this.#emit();
    }
    #syncViewerCount(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
            return;
        const previous = this.viewerCount;
        this.viewerCount = value;
        if (previous === 0 && value > 0)
            this.keepAwake?.start();
        else if (previous > 0 && value === 0)
            this.keepAwake?.stop();
    }
    /** Sends producer→controller WebRTC signaling over the current client. */
    async relayWebrtcToViewer(data) {
        const client = this.currentClient;
        if (!client)
            return { delivered: false };
        return client.webrtcRelay(this.metadata.sessionId, data).catch(() => ({ delivered: false }));
    }
    async #probeAccessibility() {
        try {
            return await this.probeAccessibility();
        }
        catch {
            return null;
        }
    }
    #emit() {
        const snapshot = this.getStatus();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            }
            catch { }
        }
    }
}
//# sourceMappingURL=desktop-screen-live.js.map