import { describe, expect, it } from "vitest";
import { ObservationSelectionPolicy } from "./observation-policy.js";
import type { AccessibilityObservation } from "./computer-observation.js";

function observation(nodes: AccessibilityObservation["nodes"], coverage: AccessibilityObservation["coverage"] = "complete"): AccessibilityObservation {
  return {
    source: "accessibility",
    revision: "ax_1",
    coverage,
    app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
    nodes,
  };
}

describe("ObservationSelectionPolicy", () => {
  const policy = new ObservationSelectionPolicy();

  it("prefers meaningful accessibility including partial snapshots", () => {
    const partial = observation([{ id: "ax_1:1", role: "AXButton", name: "Save", actions: ["AXPress"] }], "partial");
    expect(policy.select({ status: "ok", observation: partial })).toEqual({ kind: "accessibility", observation: partial });
  });

  it.each([
    ["denied", "accessibility_denied"],
    ["timeout", "accessibility_timeout"],
    ["unavailable", "no_usable_accessibility"],
  ] as const)("falls back for %s", (status, reason) => {
    expect(policy.select({ status })).toEqual({ kind: "screenshot", reason });
  });

  it("falls back for empty semantic content", () => {
    expect(policy.select({ status: "ok", observation: observation([{ id: "ax_1:1", role: "AXGroup", actions: [] }]) }))
      .toEqual({ kind: "screenshot", reason: "no_usable_accessibility" });
  });
});
