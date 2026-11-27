import { ComputerOperationError } from "@agent/computer-use";
import { captureDesktopFrame, } from "../desktop-screen-screencast.js";
export class ElectronScreenCaptureAdapter {
    constructor(options) {
        this.options = options;
        this.sequence = 0;
        this.latest = null;
    }
    isAuthorized() {
        return this.options.screenPermission() === "granted";
    }
    latestFrame() {
        return this.latest;
    }
    async capture(reason) {
        if (!this.isAuthorized()) {
            throw new ComputerOperationError("screen_recording_denied", "macOS Screen Recording permission is required", "Enable AgentRoam in System Settings > Privacy & Security > Screen Recording, then try again.");
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
            throw new ComputerOperationError("screen_recording_denied", "The desktop did not return a usable screen capture frame", "Check Screen Recording permission and keep an unlocked display connected.");
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
//# sourceMappingURL=electron-screen-capture-adapter.js.map