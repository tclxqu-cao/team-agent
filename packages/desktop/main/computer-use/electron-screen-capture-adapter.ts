import { ComputerOperationError, type ScreenshotObservation } from "@agent/computer-use";
import {
  captureDesktopFrame,
  type CaptureDesktopSources,
  type DesktopCapturedFrame,
  type DesktopDisplayInfo,
} from "../desktop-screen-screencast.js";

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

export class ElectronScreenCaptureAdapter {
  private sequence = 0;
  private latest: DesktopCapturedFrame | null = null;

  constructor(private readonly options: ElectronScreenCaptureOptions) {}

  isAuthorized(): boolean {
    return this.options.screenPermission() === "granted";
  }

  latestFrame(): DesktopCapturedFrame | null {
    return this.latest;
  }

  async capture(reason: ScreenshotObservation["reason"]): Promise<ScreenshotObservation> {
    if (!this.isAuthorized()) {
      throw new ComputerOperationError(
        "screen_recording_denied",
        "macOS Screen Recording permission is required",
        "Enable AgentRoam in System Settings > Privacy & Security > Screen Recording, then try again.",
      );
    }
    const display = this.options.displayInfo();
    const frame = await captureDesktopFrame({
      display,
      captureSources: this.options.captureSources,
      sourceId: display.id,
      quality: this.options.quality ?? 90,
      maxWidth: this.options.maxWidth ?? 3840,
      maxHeight: this.options.maxHeight ?? 2160,
      maxBytes: this.options.maxBytes ?? 4 * 1024 * 1024,
    }).catch((error) => {
      throw new ComputerOperationError("screen_recording_denied", error instanceof Error ? error.message : String(error));
    });
    if (!frame) {
      throw new ComputerOperationError(
        "screen_recording_denied",
        "The desktop did not return a usable screen capture frame",
        "Check Screen Recording permission and keep an unlocked display connected.",
      );
    }
    this.latest = frame;
    return {
      source: "screenshot",
      revision: `screen_${++this.sequence}`,
      coverage: "complete",
      reason,
      image: {
        mimeType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${frame.data.toString("base64")}`,
        width: frame.width,
        height: frame.height,
        logicalWidth: frame.logicalWidth,
        logicalHeight: frame.logicalHeight,
        originX: frame.originX,
        originY: frame.originY,
      },
    };
  }
}
