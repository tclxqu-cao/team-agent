import type { LiveViewInput, LiveViewViewport } from "@agent/core";
import type { LiveScreencastFrame, LiveScreencastPort } from "@agent/core";
import { LiveViewCapabilityError, LiveViewFramePacer } from "@agent/core";
import type { DesktopInputCommand } from "./desktop-input-gateway";

export interface DesktopDisplayInfo {
  width: number;
  height: number;
  scaleFactor: number;
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

  constructor({ input, displayInfo, captureSources, primaryDisplayId = () => null, fps = 4, quality = 65, maxWidth = 1440, maxHeight = 900, firstFrameTimeoutMs = 4_000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: {
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
      let pixelWidth = 0;
      let pixelHeight = 0;
      try {
        const sources = await this.captureSources(this.#thumbnailSize(display));
        const source = this.#pickPrimary(sources);
        if (source?.thumbnail) {
          const candidate = source.thumbnail.toJPEG(this.quality);
          if (candidate.byteLength >= 16) {
            jpeg = candidate;
            const size = source.thumbnail.getSize();
            pixelWidth = size.width;
            pixelHeight = size.height;
          }
        }
      } catch {
        // Capture can transiently fail (e.g. permission prompts); keep retrying until the deadline.
      }
      if (jpeg) {
        receivedFrame = true;
        const scaleFactor = display.scaleFactor || 1;
        this.viewport = {
          width: Math.max(1, Math.round(pixelWidth / scaleFactor)),
          height: Math.max(1, Math.round(pixelHeight / scaleFactor)),
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
      await this.sleep(Math.max(0, 1_000 / this.pacer.targetFps - elapsed));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pointerDown = false;
  }

  async dispatchInput(input: LiveViewInput): Promise<void> {
    if (!this.viewport) {
      const display = this.displayInfo();
      this.viewport = { width: display.width, height: display.height, deviceScaleFactor: display.scaleFactor };
    }
    if (input.kind === "pointer") {
      if (input.action === "wheel") {
        await this.#send({ op: "wheel", deltaX: Math.round(input.deltaX), deltaY: Math.round(input.deltaY) });
        return;
      }
      const x = Math.round(input.x * this.viewport.width);
      const y = Math.round(input.y * this.viewport.height);
      if (input.action === "down") {
        this.pointerDown = true;
        await this.#send({ op: "down", x, y, button: input.button });
        return;
      }
      if (input.action === "up") {
        this.pointerDown = false;
        await this.#send({ op: "up", x, y, button: input.button });
        return;
      }
      await this.#send(this.pointerDown ? { op: "drag", x, y } : { op: "move", x, y });
      return;
    }
    if (input.text && !input.key && !input.code) {
      await this.#send({ op: "text", text: input.text });
      return;
    }
    await this.#send({ op: "key", action: input.action, code: input.code || input.key, modifiers: input.modifiers });
  }

  async #send(command: DesktopInputCommand): Promise<void> {
    await this.input.dispatch(command);
  }

  #thumbnailSize(display: DesktopDisplayInfo): { width: number; height: number } {
    return {
      width: Math.max(1, Math.min(this.maxWidth, display.width)),
      height: Math.max(1, Math.min(this.maxHeight, display.height)),
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
