import { type ScreenshotObservation } from "@agent/computer-use";
import { type CaptureDesktopSources, type DesktopCapturedFrame, type DesktopDisplayInfo } from "../desktop-screen-screencast.js";
export type ScreenPermission = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export interface ElectronScreenCaptureOptions {
    displayInfo: () => DesktopDisplayInfo;
    captureSources: CaptureDesktopSources;
    screenPermission: () => ScreenPermission;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    maxBytes?: number;
}
export declare class ElectronScreenCaptureAdapter {
    private readonly options;
    private sequence;
    private latest;
    constructor(options: ElectronScreenCaptureOptions);
    isAuthorized(): boolean;
    latestFrame(): DesktopCapturedFrame | null;
    capture(reason: ScreenshotObservation["reason"]): Promise<ScreenshotObservation>;
}
//# sourceMappingURL=electron-screen-capture-adapter.d.ts.map