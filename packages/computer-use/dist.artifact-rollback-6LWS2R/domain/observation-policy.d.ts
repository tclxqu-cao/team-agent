import type { AccessibilityObservation } from "./computer-observation.js";
export type AccessibilitySnapshotResult = {
    status: "ok";
    observation: AccessibilityObservation;
} | {
    status: "denied" | "timeout" | "unavailable";
    message?: string;
};
export type ObservationSelection = {
    kind: "accessibility";
    observation: AccessibilityObservation;
} | {
    kind: "screenshot";
    reason: "accessibility_denied" | "accessibility_timeout" | "no_usable_accessibility";
};
export declare class ObservationSelectionPolicy {
    select(result: AccessibilitySnapshotResult): ObservationSelection;
}
//# sourceMappingURL=observation-policy.d.ts.map