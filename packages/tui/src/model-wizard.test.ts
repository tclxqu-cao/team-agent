import { describe, expect, it } from "vitest";
import { maskSecret, startModelWizard, wizardStepNumber } from "./model-wizard.js";

describe("model wizard", () => {
  it("starts at URL and masks credentials", () => {
    expect(startModelWizard()).toEqual({ step: "url" });
    expect(maskSecret("sk-secret")).toBe("•••••••••");
    expect(wizardStepNumber({ step: "url" })).toBe(1);
  });
});
