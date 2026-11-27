import { type ComputerAction, type ComputerObservation, type ComputerRuntimePort, type ComputerRuntimeStatus } from "@agent/computer-use";
import type { LiveViewOwnershipState } from "@agent/core";
import { DesktopInputAdapter } from "./desktop-input-adapter.js";
import { ElectronScreenCaptureAdapter } from "./electron-screen-capture-adapter.js";
import { MacAccessibilityAdapter } from "./mac-accessibility-adapter.js";
export interface DesktopComputerRuntimeOptions {
    accessibility: MacAccessibilityAdapter;
    screenCapture: ElectronScreenCaptureAdapter;
    input: DesktopInputAdapter;
    ownership: () => LiveViewOwnershipState | null;
    locked?: () => boolean;
    platform?: NodeJS.Platform;
    settleMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export declare class DesktopComputerRuntime implements ComputerRuntimePort {
    private readonly options;
    private readonly policy;
    private readonly platform;
    private readonly settleMs;
    private readonly sleep;
    private latestAccessibility;
    constructor(options: DesktopComputerRuntimeOptions);
    status(): Promise<ComputerRuntimeStatus>;
    execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation>;
    private executeSerialized;
    private observe;
    private assertAgentOwnsDesktop;
    private isLocked;
    private assertUnlocked;
    private requireNode;
    private click;
    private scroll;
    private latestScreenshotPoint;
}
//# sourceMappingURL=desktop-computer-runtime.d.ts.map