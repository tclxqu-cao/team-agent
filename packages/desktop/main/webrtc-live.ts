import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

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
  log?: (line: string) => void;
  now?: () => number;
}

const START_TIMEOUT_MS = 20_000;
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
  private startAt = 0;
  private connected = false;

  constructor(options: WebrtcLiveOptions) {
    this.options = options;
    ipcMain.on("webrtc-live:signal", (_event, data: unknown) => {
      if (data && typeof data === "object") void this.#handleRendererSignal(data as WebrtcSignal);
    });
  }

  /** Viewer→producer signaling entry (wired to DesktopScreenLive). */
  handleViewerSignal(data: WebrtcSignal): void {
    const kind = String(data.kind);
    if (kind === "start") {
      this.#cancelClose();
      this.startAt = this.options.now?.() ?? Date.now();
      this.#ensureWindow((window) => {
        window.webContents.send("webrtc-live:signal", { kind: "start" });
      });
      return;
    }
    if (kind === "stop") {
      this.options.setStandby(false);
      this.connected = false;
      this.#post(data);
      this.#scheduleClose(0);
      return;
    }
    if (kind === "answer" || kind === "ice") this.#post(data);
  }

  /** Stops capture unconditionally (control released, live disabled, app quit). */
  stop(): void {
    this.options.setStandby(false);
    this.connected = false;
    this.#post({ kind: "stop" });
    this.#scheduleClose(0);
  }

  async #handleRendererSignal(data: WebrtcSignal): Promise<void> {
    const kind = String(data.kind);
    if (kind === "state") {
      const state = String(data.state);
      if (state === "connected") {
        this.connected = true;
        this.#cancelClose();
        this.options.setStandby(true);
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        // Fallback to the JPEG stream; tear the capture down if it stays dead.
        this.connected = false;
        this.options.setStandby(false);
        this.#scheduleClose(RECONNECT_GRACE_MS);
      }
    }
    if (kind === "error") this.options.log?.(`[webrtc-live] ${String(data.error ?? "renderer error")}`);
    await this.options.sendToViewer(data);
  }

  #post(data: WebrtcSignal): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send("webrtc-live:signal", data);
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
    // A capture page that never reaches "connected" must not leak the window.
    this.#scheduleClose(START_TIMEOUT_MS);
    void window.loadFile(this.options.capturePagePath()).then(() => onReady(window));
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
