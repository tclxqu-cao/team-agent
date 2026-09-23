import type { AccessibilityObservation } from "./computer-observation.js";

export type AccessibilitySnapshotResult =
  | { status: "ok"; observation: AccessibilityObservation }
  | { status: "denied" | "timeout" | "unavailable"; message?: string };

export type ObservationSelection =
  | { kind: "accessibility"; observation: AccessibilityObservation }
  | { kind: "screenshot"; reason: "accessibility_denied" | "accessibility_timeout" | "no_usable_accessibility" };

export class ObservationSelectionPolicy {
  select(result: AccessibilitySnapshotResult): ObservationSelection {
    if (result.status !== "ok") {
      if (result.status === "denied") return { kind: "screenshot", reason: "accessibility_denied" };
      if (result.status === "timeout") return { kind: "screenshot", reason: "accessibility_timeout" };
      return { kind: "screenshot", reason: "no_usable_accessibility" };
    }

    const meaningful = result.observation.nodes.some((node) =>
      node.actions.length > 0
      || Boolean(node.name?.trim())
      || Boolean(node.description?.trim())
      || Boolean(node.value?.trim()),
    );
    return meaningful
      ? { kind: "accessibility", observation: result.observation }
      : { kind: "screenshot", reason: "no_usable_accessibility" };
  }
}
