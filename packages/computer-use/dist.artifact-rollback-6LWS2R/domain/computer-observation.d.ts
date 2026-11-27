export interface ComputerBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface ComputerApplication {
    name: string;
    bundleId: string;
    pid: number;
}
export interface AccessibilityNode {
    id: string;
    parentId?: string;
    role: string;
    subrole?: string;
    name?: string;
    value?: string;
    description?: string;
    identifier?: string;
    enabled?: boolean;
    focused?: boolean;
    selected?: boolean;
    bounds?: ComputerBounds;
    actions: string[];
}
export interface AccessibilityObservation {
    source: "accessibility";
    revision: string;
    coverage: "complete" | "partial";
    app: ComputerApplication;
    window?: {
        title?: string;
        bounds?: ComputerBounds;
    };
    nodes: AccessibilityNode[];
    truncated?: boolean;
    elapsedMs?: number;
}
export interface ScreenshotObservation {
    source: "screenshot";
    revision: string;
    coverage: "complete";
    app?: ComputerApplication;
    image: {
        mimeType: "image/jpeg" | "image/png";
        dataUrl: string;
        width: number;
        height: number;
        logicalWidth: number;
        logicalHeight: number;
        originX: number;
        originY: number;
    };
    reason: "explicit" | "accessibility_denied" | "accessibility_timeout" | "no_usable_accessibility";
}
export type ComputerObservation = AccessibilityObservation | ScreenshotObservation;
export declare const COMPUTER_ERROR_CODES: readonly ["desktop_offline", "desktop_locked", "accessibility_denied", "screen_recording_denied", "desktop_controlled_by_user", "stale_observation", "node_not_found", "action_not_supported", "observation_timeout", "action_timeout", "vision_unavailable", "aborted", "invalid_request", "protocol_error"];
export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];
export declare class ComputerOperationError extends Error {
    readonly code: ComputerErrorCode;
    readonly recovery?: string | undefined;
    constructor(code: ComputerErrorCode, message: string, recovery?: string | undefined);
}
export declare function isComputerErrorCode(value: unknown): value is ComputerErrorCode;
//# sourceMappingURL=computer-observation.d.ts.map