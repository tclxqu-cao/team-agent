import type { NormalizedModelEndpoint } from "./model-discovery.js";

export type ModelWizardState =
  | { step: "url" }
  | { step: "apiKey"; endpoint: NormalizedModelEndpoint }
  | { step: "fetching"; endpoint: NormalizedModelEndpoint; apiKey: string }
  | { step: "model"; endpoint: NormalizedModelEndpoint; apiKey: string; models: string[] };

export function startModelWizard(): ModelWizardState {
  return { step: "url" };
}

export function maskSecret(value: string): string {
  return "•".repeat(Array.from(value).length);
}

export function wizardStepNumber(state: ModelWizardState): number {
  if (state.step === "url") return 1;
  if (state.step === "apiKey") return 2;
  return 3;
}
