import type { LiveViewDisplayOption, LiveViewOwnershipState, LiveViewSource } from "@agent/core";
import { LiveViewProducer, type LiveViewProducerClientPort } from "@agent/core";
import type { LiveScreencastPort } from "@agent/core";
import type { DesktopInputGateway } from "./desktop-input-gateway";

export type ScreenPermission = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface DesktopLiveStatus {
  enabled: boolean;
  permissionScreen: ScreenPermission;
  accessibilityTrusted: boolean | null;
  sessionOnline: boolean;
  controlState: LiveViewOwnershipState | null;
  error?: string;
}

export const DESKTOP_LIVE_SESSION_ID = "desktop:primary";

/** WebRTC signaling payload exchanged between the controller and this producer. */
export type WebrtcSignal = Record<string, unknown>;
/** Capture display choices published with the session metadata. */
export type LiveDisplayOptions = LiveViewDisplayOption[];

/** Holds the display awake while the live session is enabled (see DisplayKeepAwake). */
export type DisplayWakeControl = { start(): void; stop(): void };

type ClientFactory = () => LiveViewProducerClientPort;
type ProbeScreen = () => Promise<ScreenPermission> | ScreenPermission;
type ProbeAccessibility = () => Promise<boolean | null> | boolean | null;

const SCREEN_PERMISSION_HINT = "需要在「系统设置 → 隐私与安全性 → 屏幕录制」中授权桌面 App 后才能直播桌面画面";
const ACCESSIBILITY_HINT = "画面已可观看；接管控制前需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权桌面 App";

/** Composition root that publishes the primary display as a live-view session and relays remote input. */
export class DesktopScreenLive {
  private readonly clientFactory: ClientFactory;
  private readonly screencast: LiveScreencastPort;
  private readonly input: DesktopInputGateway;
  private readonly metadata: { sessionId: string; backend: LiveViewSource; title: string; url: string };
  private readonly probeScreen: ProbeScreen;
  private readonly probeAccessibility: ProbeAccessibility;
  private readonly keepAwake: DisplayWakeControl | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private enabled = false;
  private loopPromise: Promise<void> | null = null;
  private currentClient: LiveViewProducerClientPort | null = null;
  private unsubscribeState: (() => void) | null = null;
  private readonly onWebrtcFromViewer: (data: WebrtcSignal) => void;
  private readonly getDisplayOptions: (() => LiveDisplayOptions | null) | null;
  private readonly onSetDisplay: ((displayId: string | null) => Promise<LiveDisplayOptions | null>) | null;
  private status: DesktopLiveStatus = {
    enabled: false,
    permissionScreen: "unknown",
    accessibilityTrusted: null,
    sessionOnline: false,
    controlState: null,
  };
  private readonly listeners = new Set<(status: DesktopLiveStatus) => void>();

  constructor({ clientFactory, screencast, input, probeScreen = () => "unknown", probeAccessibility = async () => null, keepAwake = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onWebrtcFromViewer = () => undefined,
    getDisplayOptions,
    onSetDisplay = null }: {
    clientFactory: ClientFactory;
    screencast: LiveScreencastPort;
    input: DesktopInputGateway;
    probeScreen?: ProbeScreen;
    probeAccessibility?: ProbeAccessibility;
    keepAwake?: DisplayWakeControl | null;
    sleep?: (ms: number) => Promise<void>;
    /** Viewer→producer WebRTC signaling (start/answer/ICE/stop). */
    onWebrtcFromViewer?: (data: WebrtcSignal) => void;
    /** Capture display choices published with the session metadata. */
    getDisplayOptions?: () => LiveDisplayOptions | null;
    /** Applies a viewer's display switch and returns the refreshed options. */
    onSetDisplay?: ((displayId: string | null) => Promise<LiveDisplayOptions | null>) | null;
  }) {
    this.clientFactory = clientFactory;
    this.screencast = screencast;
    this.input = input;
    this.metadata = { sessionId: DESKTOP_LIVE_SESSION_ID, backend: "desktop", title: "桌面屏幕", url: "" };
    this.probeScreen = probeScreen;
    this.probeAccessibility = probeAccessibility;
    this.keepAwake = keepAwake;
    this.sleep = sleep;
    this.onWebrtcFromViewer = onWebrtcFromViewer;
    this.getDisplayOptions = getDisplayOptions ?? null;
    this.onSetDisplay = onSetDisplay ?? null;
  }

  onStatus(listener: (status: DesktopLiveStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getStatus(): DesktopLiveStatus {
    return { ...this.status };
  }

  async enable(): Promise<DesktopLiveStatus> {
    this.enabled = true;
    this.status = { ...this.status, enabled: true, error: undefined };
    const screen = await this.probeScreen();
    this.status.permissionScreen = screen;
    if (screen !== "granted") {
      this.status.error = SCREEN_PERMISSION_HINT;
      this.#emit();
      return this.getStatus();
    }
    try {
      await this.input.start();
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error);
      this.#emit();
      return this.getStatus();
    }
    this.status.accessibilityTrusted = await this.#probeAccessibility();
    if (this.status.accessibilityTrusted === false) this.status.error = ACCESSIBILITY_HINT;
    // Wake the display and hold it awake so a locked or dimmed Mac keeps
    // streaming frames (remote unlock works from the lock screen).
    this.keepAwake?.start();
    this.status.sessionOnline = true;
    this.#emit();
    if (!this.loopPromise) {
      this.loopPromise = this.#runLoop().finally(() => {
        this.loopPromise = null;
      });
    }
    return this.getStatus();
  }

  async disable(): Promise<DesktopLiveStatus> {
    this.enabled = false;
    this.status = { ...this.status, enabled: false, sessionOnline: false, controlState: null, error: undefined };
    this.keepAwake?.stop();
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

  async #runLoop(): Promise<void> {
    let backoffMs = 1_000;
    while (this.enabled) {
      const client = this.clientFactory();
      this.currentClient = client;
      this.unsubscribeState?.();
      this.unsubscribeState = client.onEvent((event) => {
        if (event.type === "browser:webrtc" && event.sessionId === this.metadata.sessionId) {
          const data = event.data;
          if (data && typeof data === "object") this.onWebrtcFromViewer(data as WebrtcSignal);
          return;
        }
        this.#handleRelayEvent(event);
      });
      this.status = { ...this.status, sessionOnline: true, error: this.status.accessibilityTrusted === false ? ACCESSIBILITY_HINT : undefined };
      this.#emit();
      try {
        const producer = new LiveViewProducer({
          client,
          screencast: this.screencast,
          metadata: { ...this.metadata, displays: this.getDisplayOptions?.() ?? null },
          // The desktop source has no agent gate to pause; ownership still flows through the shared state machine.
          pauseAgent: async () => undefined,
          resyncAgent: async () => undefined,
          onError: (error) => {
            this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
            this.#emit();
          },
          onSetDisplay: this.onSetDisplay,
        });
        await producer.run();
      } catch (error) {
        this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
        this.#emit();
      }
      this.status = { ...this.status, sessionOnline: false };
      this.#emit();
      if (!this.enabled) return;
      await this.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  #handleRelayEvent(event: Record<string, unknown>): void {
    const session = event.session as { id?: string; state?: LiveViewOwnershipState } | undefined;
    if (!session || session.id !== this.metadata.sessionId || !session.state) return;
    this.status = { ...this.status, controlState: session.state };
    this.#emit();
  }

  /** Sends producer→controller WebRTC signaling over the current client. */
  async relayWebrtcToViewer(data: WebrtcSignal): Promise<unknown> {
    const client = this.currentClient;
    if (!client) return { delivered: false };
    return client.webrtcRelay(this.metadata.sessionId, data).catch(() => ({ delivered: false }));
  }

  async #probeAccessibility(): Promise<boolean | null> {
    try {
      return await this.probeAccessibility();
    } catch {
      return null;
    }
  }

  #emit(): void {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch {}
    }
  }
}
