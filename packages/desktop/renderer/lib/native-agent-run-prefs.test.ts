import { describe, expect, it } from "vitest";
import {
  groupOpenCodeModels,
  resolveNativeRunPref,
  type NativeAgentRunPref,
} from "./native-agent-run-prefs";

describe("native agent run preferences", () => {
  const stalePref: NativeAgentRunPref = {
    model: { id: "mimo-v2.5-free" },
    reasoningEffort: "high",
  };

  it("keeps a preference until the model catalogs are ready", () => {
    expect(resolveNativeRunPref(stalePref, new Set(["gpt-5.6-sol"]), false)).toBe(stalePref);
  });

  it("keeps an available provider-scoped model", () => {
    const pref: NativeAgentRunPref = { model: { providerID: "openai", id: "gpt-5.6-sol" } };
    expect(resolveNativeRunPref(pref, new Set(["openai/gpt-5.6-sol"]), true)).toBe(pref);
  });

  it("clears an unavailable model and its model-specific effort", () => {
    expect(resolveNativeRunPref(stalePref, new Set(["gpt-5.6-sol"]), true)).toEqual({});
  });

  it("groups duplicate OpenCode model names by provider without repeating provider names", () => {
    expect(groupOpenCodeModels([
      {
        id: "longcat-2.5-preview-free",
        providerID: "opencode",
        providerDisplayName: "OpenCode Zen",
        displayName: "LongCat 2.5 Preview Free",
      },
      {
        id: "longcat-2.5-preview-free",
        providerID: "opencode-go",
        providerDisplayName: "OpenCode Go",
        displayName: "LongCat 2.5 Preview Free",
      },
      {
        id: "LongCat-2.0",
        providerID: "longcat",
        providerDisplayName: "LongCat",
        displayName: "LongCat-2.0",
      },
    ])).toEqual([
      {
        key: "opencode",
        label: "OpenCode Zen",
        models: [expect.objectContaining({ optionLabel: "LongCat 2.5 Preview Free" })],
      },
      {
        key: "opencode-go",
        label: "OpenCode Go（需订阅）",
        models: [expect.objectContaining({ optionLabel: "LongCat 2.5 Preview Free" })],
      },
      {
        key: "longcat",
        label: "LongCat",
        models: [expect.objectContaining({ optionLabel: "LongCat-2.0" })],
      },
    ]);
  });

  it("falls back to the provider id or an other-provider group", () => {
    expect(groupOpenCodeModels([
      { id: "custom", providerID: "custom-provider" },
      { id: "local", displayName: "Local Model" },
    ])).toEqual([
      {
        key: "custom-provider",
        label: "custom-provider",
        models: [expect.objectContaining({ optionLabel: "custom" })],
      },
      {
        key: "__other__",
        label: "其他供应商",
        models: [expect.objectContaining({ optionLabel: "Local Model" })],
      },
    ]);
  });
});
