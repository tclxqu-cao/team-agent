import type { LiveViewInput, LiveViewViewport } from "@agent/core";
import type { LiveScreencastFrame, LiveScreencastPort } from "@agent/core";
import { LiveViewCapabilityError, LiveViewFramePacer } from "@agent/core";
import type { DesktopInputCommand } from "./desktop-input-gateway";

export interface DesktopDisplayInfo {
  /** Screen-global origin — CGEvent mouse coordinates need it on non-primary displays. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  scaleFactor: number;
  id: string;
}

export interface DesktopCapturedSource {
  id: string;
  thumbnail: {
    toJPEG(quality: number): Buffer;
    getSize(): { width: number; height: number };
  } | null;
}

export type CaptureDesktopSources = (thumbnailSize: { width: number; height: number }) => Promise<ArrayLike<DesktopCapturedSource>>;

/** Legacy name for the shared live-view capability error; kept for existing imports. */
export const DesktopLiveCapabilityError = LiveViewCapabilityError;

/** Input sink for dispatching desktop commands to the helper. */
export type DesktopInputSink = { dispatch(command: DesktopInputCommand): Promise<unknown> };

/** Screencast port that captures the primary display via desktopCapturer and dispatches normalized input. */
export class DesktopScreenScreencast implements LiveScreencastPort {
  private readonly input: DesktopInputSink;
  private readonly displayInfo: () => DesktopDisplayInfo;
  private readonly captureSources: CaptureDesktopSources;
  private readonly primaryDisplayId: () => string | null;
  private readonly quality: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly firstFrameTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacer: LiveViewFramePacer;
  private running = false;
  private viewport: LiveViewViewport | null = null;
  private pointerDown = false;
  private wakeCapture: (() => void) | null = null;
  private refreshUntil = 0;
  private encodingQuality: number;
  private nextQualityProbe = 0;
  private standby = false;

  // JPEG stays at the native Retina cap for full-clarity fallback and agent
  // frames. While a WebRTC viewer carries the live video, setStandby(true)
  // drops this loop to a cheap 1 FPS watchdog so encoding stops competing for
  // CPU.
  constructor({ input, displayInfo, captureSources, primaryDisplayId = () => null, fps = 8, quality = 90, maxWidth = 3840, maxHeight = 2160, firstFrameTimeoutMs = 4_000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: {
    input: DesktopInputSink;
    displayInfo: () => DesktopDisplayInfo;
    captureSources: CaptureDesktopSources;
    primaryDisplayId?: () => string | null;
    fps?: number;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    firstFrameTimeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.input = input;
    this.displayInfo = displayInfo;
    this.captureSources = captureSources;
    this.primaryDisplayId = primaryDisplayId;
    this.pacer = new LiveViewFramePacer({ fps });
    this.quality = quality;
    this.encodingQuality = quality;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.now = now;
    this.sleep = sleep;
  }

  async start(onFrame: (frame: LiveScreencastFrame) => Promise<{ accepted?: boolean } | void>): Promise<void> {
    this.running = true;
    this.pointerDown = false;
    const display = this.displayInfo();
    this.viewport = { width: display.width, height: display.height, deviceScaleFactor: display.scaleFactor };
    const firstFrameDeadline = this.now() + this.firstFrameTimeoutMs;
    let receivedFrame = false;
    while (this.running) {
      const frameStartedAt = this.now();
      let jpeg: Buffer | null = null;
      const display = this.displayInfo();
      try {
        const sources = await this.captureSources(this.#thumbnailSize(display, this.standby ? 0.5 : 1));
        const source = this.#pickPrimary(sources);
        if (source?.thumbnail) {
          // Preserve text resolution first; lower JPEG quality only when the
          // shared live-view transport's 640 KiB frame limit requires it.
          // Reuse the last fitting quality instead of recompressing an entire
          // 4K frame at several rejected qualities on every capture.
          if (this.now() >= this.nextQualityProbe) {
            this.encodingQuality = Math.min(this.quality, this.encodingQuality + 10);
            this.nextQualityProbe = this.now() + 2_000;
          }
          for (let quality = this.encodingQuality; quality >= 10; quality -= 10) {
            const candidate = source.thumbnail.toJPEG(quality);
            if (candidate.byteLength >= 16 && candidate.byteLength <= 640 * 1024) {
              jpeg = candidate;
              this.encodingQuality = quality;
              break;
            }
          }
        }
      } catch {
        // Capture can transiently fail (e.g. permission prompts); keep retrying until the deadline.
      }
      if (jpeg) {
        receivedFrame = true;
        const scaleFactor = display.scaleFactor || 1;
        this.viewport = {
          // CGEvent uses logical screen coordinates, not thumbnail pixels.
          width: display.width,
          height: display.height,
          deviceScaleFactor: scaleFactor,
        };
        const sendStartedAt = this.now();
        const result = await onFrame({
          data: new Uint8Array(jpeg),
          viewport: this.viewport,
          title: "桌面屏幕",
          url: "",
          timestamp: sendStartedAt,
        });
        this.pacer.recordSend(result, Math.max(0, this.now() - sendStartedAt));
      } else if (!receivedFrame && this.now() >= firstFrameDeadline) {
        throw new LiveViewCapabilityError("The desktop runtime did not return a screen capture source");
      }
      if (!this.running) return;
      const elapsed = this.now() - frameStartedAt;
      // Input briefly accelerates capture; idle viewing retains the normal
      // adaptive rate. The viewer ACK still bounds downstream image traffic.
      // Standby (WebRTC carrying the video) drops to a 1 FPS watchdog.
      const interval = this.now() < this.refreshUntil
        ? 70
        : this.standby
          ? 1_000
          : 1_000 / this.pacer.targetFps;
      await this.#waitForCapture(Math.max(0, interval - elapsed));
    }
  }

  /** While a WebRTC viewer carries the live video, JPEG capture is a cheap watchdog. */
  setStandby(standby: boolean): void {
    if (this.standby === standby) return;
    this.standby = standby;
    if (!standby) {
      // Leave standby with an immediate full-quality frame.
      this.nextQualityProbe = 0;
      this.wakeCapture?.();
    }
  }

  /** Interrupts the capture sleep — used after a display switch so the next
   *  frame reflects the new screen immediately instead of after the current
   *  frame interval (up to a second at low pacer rates). */
  wake(): void {
    this.wakeCapture?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pointerDown = false;
    this.refreshUntil = 0;
    this.wakeCapture?.();
  }

  async dispatchInput(input: LiveViewInput): Promise<unknown> {
    const display = this.displayInfo();
    if (input.kind === "pointer") {
      if (input.action === "wheel") {
        // Wheel events land on whatever window is under the real cursor, so
        // park the cursor at the finger position first — otherwise a viewer
        // that took over without tapping scrolls the wrong window.
        const x = Math.min(display.width - 1, Math.round(input.x * display.width));
        const y = Math.min(display.height - 1, Math.round(input.y * display.height));
        await this.#send({ op: "move", x: display.originX + x, y: display.originY + y });
        await this.#send({ op: "wheel", deltaX: Math.round(input.deltaX), deltaY: Math.round(input.deltaY) });
        return null;
      }
      const x = Math.min(display.width - 1, Math.round(input.x * display.width));
      const y = Math.min(display.height - 1, Math.round(input.y * display.height));
      const globalX = display.originX + x;
      const globalY = display.originY + y;
      const clickCount = input.click && input.click >= 2 ? Math.min(3, Math.round(input.click)) : 1;
      if (input.action === "down") {
        this.pointerDown = true;
        await this.#send({ op: "down", x: globalX, y: globalY, button: input.button, click: clickCount });
        return null;
      }
      if (input.action === "up") {
        this.pointerDown = false;
        // The helper annotates the release with an accessibility hit-test of
        // the tapped element ("editable" + bounds); the viewer uses it to
        // raise/lower the soft keyboard.
        return this.#send({ op: "up", x: globalX, y: globalY, button: input.button, click: clickCount });
      }
      await this.#send(this.pointerDown ? { op: "drag", x: globalX, y: globalY } : { op: "move", x: globalX, y: globalY });
      return null;
    }
    if (input.text && !input.key && !input.code) {
      await this.#send({ op: "text", text: input.text });
      return null;
    }
    await this.#send({ op: "key", action: input.action, code: input.code || input.key, modifiers: input.modifiers });
    return null;
  }

  async #send(command: DesktopInputCommand): Promise<Record<string, unknown> | null> {
    const result = await this.input.dispatch(command) as Record<string, unknown> | undefined;
    if (this.running && command.op !== "move") {
      this.refreshUntil = this.now() + 700;
      this.wakeCapture?.();
    }
    return result && typeof result === "object" ? result : null;
  }

  async #waitForCapture(delay: number): Promise<void> {
    let wake!: () => void;
    const interrupted = new Promise<void>((resolve) => { wake = resolve; });
    this.wakeCapture = wake;
    try {
      await Promise.race([this.sleep(delay), interrupted]);
    } finally {
      if (this.wakeCapture === wake) this.wakeCapture = null;
    }
  }

  #thumbnailSize(display: DesktopDisplayInfo, scale = 1): { width: number; height: number } {
    const pixelWidth = display.width * (display.scaleFactor || 1);
    const pixelHeight = display.height * (display.scaleFactor || 1);
    const fit = Math.min(1, this.maxWidth / pixelWidth, this.maxHeight / pixelHeight);
    const effective = Math.max(0.1, Math.min(fit, fit * scale));
    return {
      width: Math.max(1, Math.round(pixelWidth * effective)),
      height: Math.max(1, Math.round(pixelHeight * effective)),
    };
  }

  #pickPrimary(sources: ArrayLike<DesktopCapturedSource>): DesktopCapturedSource | null {
    const list = Array.from(sources);
    if (!list.length) return null;
    const primaryId = this.primaryDisplayId();
    if (primaryId) {
      const match = list.find((source) => source.id === primaryId);
      if (match) return match;
    }
    return list[0];
  }

  /** Current adaptive target rate (kept as a property for tests and diagnostics). */
  get targetFps(): number {
    return this.pacer.targetFps;
  }
}
