import { describe, expect, it } from "vitest";
import { changedSettingsPatch } from "./settingsStore";

const settings = (overrides: Record<string, unknown> = {}) => ({
  modelProvider: "openai",
  modelId: "step-5-preview",
  apiKey: "stored",
  baseUrl: "https://example.com/v1",
  maxIterations: 10,
  contextWindow: 100,
  workingDirectory: "/workspace",
  isConfigured: true,
  profiles: [],
  activeProfileId: "step",
  reasoningEffort: "off" as const,
  ...overrides,
});

describe("settings revision merge", () => {
  it("replays only fields changed by the current editor", () => {
    const baseline = settings();
    const current = settings({ maxIterations: 20, contextWindow: 128 });

    expect(changedSettingsPatch(baseline, current)).toEqual({
      maxIterations: 20,
      contextWindow: 128,
    });
  });

  it("detects nested profile edits without resending unchanged settings", () => {
    const baseline = settings({ profiles: [{ id: "step", modelId: "old" }] });
    const current = settings({ profiles: [{ id: "step", modelId: "new" }] });

    expect(changedSettingsPatch(baseline, current)).toEqual({
      profiles: [{ id: "step", modelId: "new" }],
    });
  });
});
