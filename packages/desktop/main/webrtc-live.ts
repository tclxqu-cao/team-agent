import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { BrowserRemoteVideoPolicy } from "./remote-video-browser-policy.js";
import type { RemoteVideoDecision, RemoteVideoH264Profile, RemoteVideoObservation, RemoteVideoQuality } from "@agent/core";

export type WebrtcSignal = Record<string, unknown>;

type SendToViewer = (data: WebrtcSignal) => Promise<unknown>;

export interface WebrtcLiveOptions {
  /** Path resolver for the capture page (dev assets vs packaged resources). */
  capturePagePath: () => string;
  preloadPath: () => string;
  /** Forwards producer→controller signaling through the live-view client. */
  sendToViewer: SendToViewer;
  /** While the peer connection carries the video, the JPEG loop stands by. */
  setStandby: (standby: boolean) => void;
  /** Logical dimensions of the selected Electron display. */
  captureSize?: () => { width: number; height: number } | null;
  log?: (line: string) => void;
  now?: () => number;
}

const START_TIMEOUT_MS = 20_000;
const FIRST_MEDIA_TIMEOUT_MS = 5_000;
const RECONNECT_GRACE_MS = 15_000;

/**
 * Owns the hidden capture window that publishes the primary display as a
 * WebRTC track (native resolution, hardware encode) and relays its signaling
 * between the renderer and the live-view controller.
 */
export class WebrtcLive {
  private readonly options: WebrtcLiveOptions;
  private window: BrowserWindow | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private mediaTimer: NodeJS.Timeout | null = null;
  private startAt = 0;
  private connected = false;
  private readonly mediaPolicy = new BrowserRemoteVideoPolicy("original");
  private requestedProfile: RemoteVideoH264Profile = "baseline";
  private receiverProfiles: RemoteVideoH264Profile[] = ["baseline"];
  private lastDecisionKey = "";

  constructor(options: WebrtcLiveOptions) {
    this.options = options;
    ipcMain.on("webrtc-live:signal", (event, data: unknown) => {
      if (event?.sender && event.sender !== this.window?.webContents) return;
      if (data && typeof data === "object") void this.#handleRendererSignal(data as WebrtcSignal);
    });
  }

  /** Viewer→producer signaling entry (wired to DesktopScreenLive). */
  handleViewerSignal(data: WebrtcSignal): void {
    const kind = String(data.kind);
    if (kind === "start") {
      this.options.log?.("[webrtc-live] viewer start requested");
      this.#cancelClose();
      this.startAt = this.options.now?.() ?? Date.now();
      this.receiverProfiles = Array.isArray(data.receiverProfiles)
        ? data.receiverProfiles.filter((profile): profile is RemoteVideoH264Profile => profile === "high" || profile === "baseline")
        : ["baseline"];
      this.mediaPolicy.begin(this.receiverProfiles);
      this.requestedProfile = "baseline";
      this.lastDecisionKey = "";
      this.#ensureWindow((window) => {
        this.#startCapture(window);
      });
      return;
    }
    if (kind === "quality" && ["smooth", "hd", "original"].includes(String(data.quality))) {
      const decision = this.mediaPolicy.setQuality(String(data.quality) as RemoteVideoQuality);
      this.#postDecision("tuning", decision);
      void this.options.sendToViewer({ kind: "quality-state", quality: data.quality, selectedProfile: decision.preferredCodec });
      return;
    }
    if (kind === "stop") {
      this.options.setStandby(false);
      this.connected = false;
      this.#post(data);
      this.#scheduleClose(0);
      return;
    }
    if (kind === "answer" || kind === "ice") {
      if (kind === "ice") this.options.log?.(`[webrtc-live] viewer candidate ${String((data.candidate as { candidate?: string })?.candidate ?? "").slice(0, 80)}`);
      this.#post(data);
    }
  }

  /** Stops capture unconditionally (control released, live disabled, app quit). */
  stop(): void {
    this.options.setStandby(false);
    this.connected = false;
    this.#post({ kind: "stop" });
    this.#scheduleClose(0);
  }

  /** Re-captures with the current display choice. No-op when no stream is
   *  running — the next start already picks the fresh display. The viewer
   *  answers the new offer on its existing peer connection (renegotiation). */
  restart(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.options.setStandby(false);
    this.connected = false;
    this.#post({ kind: "stop" });
    this.#closeWindow();
    this.startAt = this.options.now?.() ?? Date.now();
    this.#ensureWindow((window) => {
      this.#startCapture(window);
    });
  }

  async #handleRendererSignal(data: WebrtcSignal): Promise<void> {
    const kind = String(data.kind);
    this.options.log?.(`[webrtc-live] renderer signal: ${kind}${kind === "state" ? ` ${String(data.state)}` : ""}${kind === "error" ? ` ${String(data.error)}` : ""}${kind === "ice" ? ` ${String((data.candidate as { candidate?: string })?.candidate ?? "").slice(0, 80)}` : ""}`);
    if (kind === "sender-capabilities") {
      const profiles: RemoteVideoH264Profile[] = Array.isArray(data.profiles)
        ? data.profiles.filter((profile): profile is RemoteVideoH264Profile => profile === "high" || profile === "baseline")
        : ["baseline"];
      const decision = this.mediaPolicy.configureSender(profiles);
      this.requestedProfile = decision.preferredCodec;
      this.#postDecision("configure", decision);
      return;
    }
    if (kind === "sender-stats") {
      const decision = this.mediaPolicy.observe((data.observation ?? {}) as RemoteVideoObservation);
      this.#postDecision("tuning", decision);
      return;
    }
    if (kind === "sender-media") {
      this.#cancelMediaTimeout();
      return;
    }
    if (kind === "profile-failed") {
      const failed = data.profile === "high" ? "high" : "baseline";
      if (failed !== this.requestedProfile) return;
      await this.#handleAttemptFailure(`${failed} H.264 encoder unavailable`);
      return;
    }
    if (kind === "state") {
      const state = String(data.state);
      if (state === "connected") {
        this.connected = true;
        this.#cancelClose();
        this.options.setStandby(true);
        this.#scheduleMediaTimeout(this.window);
      } else if ((state === "failed" || state === "disconnected") && this.requestedProfile === "high") {
        await this.#handleAttemptFailure(`H.264 ${state}`);
        return;
      }
      if (state === "failed" || state === "disconnected" || state === "closed") {
        // Fallback to the JPEG stream; tear the capture down if it stays dead.
        this.connected = false;
        this.options.setStandby(false);
        this.#scheduleClose(RECONNECT_GRACE_MS);
      }
    }
    if (kind === "error") this.options.log?.(`[webrtc-live] ${String(data.error ?? "renderer error")}`);
    await this.options.sendToViewer(data);
  }

  #postDecision(kind: "configure" | "tuning", decision: RemoteVideoDecision): void {
    const key = JSON.stringify([kind, decision.bitRate, decision.maxFps, decision.preferredCodec]);
    if (kind === "tuning" && key === this.lastDecisionKey) return;
    this.lastDecisionKey = key;
    this.#post({ kind, decision });
  }

  #post(data: WebrtcSignal): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send("webrtc-live:signal", data);
  }

  #startCapture(window: BrowserWindow): void {
    const captureSize = this.options.captureSize?.() ?? null;
    window.webContents.send("webrtc-live:signal", {
      kind: "start",
      ...(captureSize ? { captureSize } : {}),
    });
  }

  #ensureWindow(onReady: (window: BrowserWindow) => void): void {
    if (this.window && !this.window.isDestroyed()) {
      onReady(this.window);
      return;
    }
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: this.options.preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.options.setStandby(false);
      this.connected = false;
    });
    this.window = window;
    // A High attempt that never connects receives one Baseline retry. A
    // Baseline timeout reports failure and lets the JPEG fallback remain live.
    this.#scheduleStartTimeout(window);
    void window.loadFile(this.options.capturePagePath()).then(() => onReady(window));
  }

  async #handleAttemptFailure(reason: string, window = this.window): Promise<void> {
    if (!window || this.window !== window) return;
    this.#cancelMediaTimeout();
    const decision = this.mediaPolicy.fallback(this.requestedProfile);
    if (decision) {
      this.requestedProfile = decision.preferredCodec;
      this.options.log?.(`[webrtc-live] retrying with H264 Baseline: ${reason}`);
      void this.options.sendToViewer({ kind: "state", state: "connecting", fallbackReason: reason.slice(0, 500) });
      this.restart();
      return;
    }
    this.connected = false;
    this.options.setStandby(false);
    this.#scheduleClose(RECONNECT_GRACE_MS);
    await this.options.sendToViewer({ kind: "state", state: "failed", error: reason.slice(0, 500) });
  }

  #scheduleStartTimeout(window: BrowserWindow): void {
    this.#cancelClose();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.window === window && !this.connected) void this.#handleAttemptFailure("WebRTC connection timeout", window);
    }, START_TIMEOUT_MS);
  }

  #scheduleMediaTimeout(window: BrowserWindow | null): void {
    this.#cancelMediaTimeout();
    if (!window) return;
    this.mediaTimer = setTimeout(() => {
      this.mediaTimer = null;
      if (this.window === window && this.connected) void this.#handleAttemptFailure("H.264 first frame timeout", window);
    }, FIRST_MEDIA_TIMEOUT_MS);
  }

  #cancelMediaTimeout(): void {
    if (this.mediaTimer) {
      clearTimeout(this.mediaTimer);
      this.mediaTimer = null;
    }
  }

  #scheduleClose(delayMs: number): void {
    this.#cancelClose();
    if (delayMs <= 0) {
      this.#closeWindow();
      return;
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.connected) this.#closeWindow();
    }, delayMs);
  }

  #cancelClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  #closeWindow(): void {
    this.#cancelMediaTimeout();
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.close();
  }
}

/** Default path resolvers mirroring the desktop-input helper layout. */
export function defaultWebrtcCapturePagePath(dirname: string, isPackaged: boolean, resourcesPath: string): string {
  return isPackaged
    ? join(resourcesPath, "assets", "webrtc-live.html")
    : join(dirname, "../../assets/webrtc-live.html");
}
