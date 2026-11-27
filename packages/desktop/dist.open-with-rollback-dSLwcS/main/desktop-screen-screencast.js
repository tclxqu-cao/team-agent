import { LiveViewCapabilityError, LiveViewFramePacer } from "@agent/core";
export function desktopThumbnailSize(display, maxWidth = 3840, maxHeight = 2160, scale = 1) {
    const pixelWidth = display.width * (display.scaleFactor || 1);
    const pixelHeight = display.height * (display.scaleFactor || 1);
    const fit = Math.min(1, maxWidth / pixelWidth, maxHeight / pixelHeight);
    const effective = Math.max(0.1, Math.min(fit, fit * scale));
    return {
        width: Math.max(1, Math.round(pixelWidth * effective)),
        height: Math.max(1, Math.round(pixelHeight * effective)),
    };
}
/** Captures one bounded JPEG while preserving the selected display's logical coordinate space. */
export async function captureDesktopFrame({ display, captureSources, sourceId = display.id, quality = 90, maxWidth = 3840, maxHeight = 2160, maxBytes = 4 * 1024 * 1024, scale = 1, }) {
    const sources = Array.from(await captureSources(desktopThumbnailSize(display, maxWidth, maxHeight, scale)));
    const source = (sourceId ? sources.find((candidate) => candidate.id === sourceId) : null) ?? sources[0];
    if (!source?.thumbnail)
        return null;
    for (let candidateQuality = Math.max(10, Math.min(100, Math.round(quality))); candidateQuality >= 10; candidateQuality -= 10) {
        const data = source.thumbnail.toJPEG(candidateQuality);
        if (data.byteLength < 16 || data.byteLength > maxBytes)
            continue;
        const size = source.thumbnail.getSize();
        return {
            data,
            width: size.width,
            height: size.height,
            logicalWidth: display.width,
            logicalHeight: display.height,
            originX: display.originX,
            originY: display.originY,
            scaleFactor: display.scaleFactor || 1,
            displayId: display.id,
            quality: candidateQuality,
        };
    }
    return null;
}
/** Legacy name for the shared live-view capability error; kept for existing imports. */
export const DesktopLiveCapabilityError = LiveViewCapabilityError;
/** Screencast port that captures the primary display via desktopCapturer and dispatches normalized input. */
export class DesktopScreenScreencast {
    // JPEG stays at the native Retina cap for full-clarity fallback and agent
    // frames. While a WebRTC viewer carries the live video, setStandby(true)
    // drops this loop to a cheap 1 FPS watchdog so encoding stops competing for
    // CPU.
    constructor({ input, displayInfo, captureSources, primaryDisplayId = () => null, fps = 8, quality = 90, maxWidth = 3840, maxHeight = 2160, firstFrameTimeoutMs = 4_000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
        this.running = false;
        this.viewport = null;
        this.pointerDown = false;
        this.wakeCapture = null;
        this.refreshUntil = 0;
        this.nextQualityProbe = 0;
        this.standby = false;
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
    async start(onFrame) {
        this.running = true;
        this.pointerDown = false;
        const display = this.displayInfo();
        this.viewport = { width: display.width, height: display.height, deviceScaleFactor: display.scaleFactor };
        const firstFrameDeadline = this.now() + this.firstFrameTimeoutMs;
        let receivedFrame = false;
        while (this.running) {
            const frameStartedAt = this.now();
            let jpeg = null;
            const display = this.displayInfo();
            try {
                // Preserve text resolution first; lower JPEG quality only when the
                // shared live-view transport's 640 KiB frame limit requires it.
                // Reuse the last fitting quality instead of recompressing an entire
                // 4K frame at several rejected qualities on every capture.
                if (this.now() >= this.nextQualityProbe) {
                    this.encodingQuality = Math.min(this.quality, this.encodingQuality + 10);
                    this.nextQualityProbe = this.now() + 2_000;
                }
                const captured = await captureDesktopFrame({
                    display,
                    captureSources: this.captureSources,
                    sourceId: this.primaryDisplayId(),
                    quality: this.encodingQuality,
                    maxWidth: this.maxWidth,
                    maxHeight: this.maxHeight,
                    maxBytes: 640 * 1024,
                    scale: this.standby ? 0.5 : 1,
                });
                if (captured) {
                    jpeg = captured.data;
                    this.encodingQuality = captured.quality;
                }
            }
            catch {
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
            }
            else if (!receivedFrame && this.now() >= firstFrameDeadline) {
                throw new LiveViewCapabilityError("The desktop runtime did not return a screen capture source");
            }
            if (!this.running)
                return;
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
    setStandby(standby) {
        if (this.standby === standby)
            return;
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
    wake() {
        this.wakeCapture?.();
    }
    async stop() {
        this.running = false;
        this.pointerDown = false;
        this.refreshUntil = 0;
        this.wakeCapture?.();
    }
    async dispatchInput(input) {
        const display = this.displayInfo();
        if (input.kind === "pointer") {
            if (input.probe) {
                return this.#send({ op: "hit-test", x: display.originX + Math.round(input.x * (display.width - 1)), y: display.originY + Math.round(input.y * (display.height - 1)) });
            }
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
    async #send(command) {
        const result = await this.input.dispatch(command);
        if (this.running && command.op !== "move" && command.op !== "hit-test") {
            this.refreshUntil = this.now() + 700;
            this.wakeCapture?.();
        }
        return result && typeof result === "object" ? result : null;
    }
    async #waitForCapture(delay) {
        let wake;
        const interrupted = new Promise((resolve) => { wake = resolve; });
        this.wakeCapture = wake;
        try {
            await Promise.race([this.sleep(delay), interrupted]);
        }
        finally {
            if (this.wakeCapture === wake)
                this.wakeCapture = null;
        }
    }
    /** Current adaptive target rate (kept as a property for tests and diagnostics). */
    get targetFps() {
        return this.pacer.targetFps;
    }
}
//# sourceMappingURL=desktop-screen-screencast.js.map