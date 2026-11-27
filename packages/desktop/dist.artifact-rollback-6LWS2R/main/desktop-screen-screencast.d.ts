import type { LiveViewInput } from "@agent/core";
import type { LiveScreencastFrame, LiveScreencastPort } from "@agent/core";
import { LiveViewCapabilityError } from "@agent/core";
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
        getSize(): {
            width: number;
            height: number;
        };
    } | null;
}
export type CaptureDesktopSources = (thumbnailSize: {
    width: number;
    height: number;
}) => Promise<ArrayLike<DesktopCapturedSource>>;
export interface DesktopCapturedFrame {
    data: Buffer;
    width: number;
    height: number;
    logicalWidth: number;
    logicalHeight: number;
    originX: number;
    originY: number;
    scaleFactor: number;
    displayId: string;
    quality: number;
}
export interface CaptureDesktopFrameOptions {
    display: DesktopDisplayInfo;
    captureSources: CaptureDesktopSources;
    sourceId?: string | null;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    maxBytes?: number;
    scale?: number;
}
export declare function desktopThumbnailSize(display: DesktopDisplayInfo, maxWidth?: number, maxHeight?: number, scale?: number): {
    width: number;
    height: number;
};
/** Captures one bounded JPEG while preserving the selected display's logical coordinate space. */
export declare function captureDesktopFrame({ display, captureSources, sourceId, quality, maxWidth, maxHeight, maxBytes, scale, }: CaptureDesktopFrameOptions): Promise<DesktopCapturedFrame | null>;
/** Legacy name for the shared live-view capability error; kept for existing imports. */
export declare const DesktopLiveCapabilityError: typeof LiveViewCapabilityError;
/** Input sink for dispatching desktop commands to the helper. */
export type DesktopInputSink = {
    dispatch(command: DesktopInputCommand): Promise<unknown>;
};
/** Screencast port that captures the primary display via desktopCapturer and dispatches normalized input. */
export declare class DesktopScreenScreencast implements LiveScreencastPort {
    #private;
    private readonly input;
    private readonly displayInfo;
    private readonly captureSources;
    private readonly primaryDisplayId;
    private readonly quality;
    private readonly maxWidth;
    private readonly maxHeight;
    private readonly firstFrameTimeoutMs;
    private readonly now;
    private readonly sleep;
    private readonly pacer;
    private running;
    private viewport;
    private pointerDown;
    private wakeCapture;
    private refreshUntil;
    private encodingQuality;
    private nextQualityProbe;
    private standby;
    constructor({ input, displayInfo, captureSources, primaryDisplayId, fps, quality, maxWidth, maxHeight, firstFrameTimeoutMs, now, sleep }: {
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
    });
    start(onFrame: (frame: LiveScreencastFrame) => Promise<{
        accepted?: boolean;
    } | void>): Promise<void>;
    /** While a WebRTC viewer carries the live video, JPEG capture is a cheap watchdog. */
    setStandby(standby: boolean): void;
    /** Interrupts the capture sleep — used after a display switch so the next
     *  frame reflects the new screen immediately instead of after the current
     *  frame interval (up to a second at low pacer rates). */
    wake(): void;
    stop(): Promise<void>;
    dispatchInput(input: LiveViewInput): Promise<unknown>;
    /** Current adaptive target rate (kept as a property for tests and diagnostics). */
    get targetFps(): number;
}
//# sourceMappingURL=desktop-screen-screencast.d.ts.map