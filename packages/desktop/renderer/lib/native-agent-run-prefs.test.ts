import { describe, expect, it, vi } from "vitest";
import {
  groupOpenCodeModels,
  loadNativeRunPref,
  nativeReasoningEffortOptions,
  resolveNativeRunPref,
  saveNativeRunPref,
  type NativeAgentRunPref,
} from "./native-agent-run-prefs";

describe("native reasoning effort capabilities", () => {
  it.each(["codex", "opencode", "qoder", "zcode", "workbuddy"] as const)("uses only %s's advertised effort levels", agentType => {
    expect(nativeReasoningEffortOptions(agentType, ["low", "high", "max"])).toEqual(["low", "high", "max"]);
    expect(nativeReasoningEffortOptions(agentType)).toEqual([]);
    expect(nativeReasoningEffortOptions(agentType, [])).toEqual([]);
  });

  it("preserves Claude Code's existing fallback without overriding advertised capabilities", () => {
    expect(nativeReasoningEffortOptions("claude-code")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(nativeReasoningEffortOptions("claude-code", ["high"])).toEqual(["high"]);
  });

  it("does not expose native effort controls for CA or mutate a runtime's catalog", () => {
    const advertised = ["high", "max"] as const;
    expect(nativeReasoningEffortOptions("customer-agent", advertised)).toEqual([]);
    const options = nativeReasoningEffortOptions("zcode", advertised);
    options.pop();
    expect(advertised).toEqual(["high", "max"]);
  });
});

describe("native agent run preferences", () => {
  const stalePref: NativeAgentRunPref = {
    model: { id: "mimo-v2.5-free" },
    reasoningEffort: "high",
  };

  it("keeps a preference until the runtime model catalog is ready", () => {
    expect(resolveNativeRunPref(stalePref, new Set(["gpt-5.6-sol"]), false)).toBe(stalePref);
  });

  it("keeps an available provider-scoped model", () => {
    const pref: NativeAgentRunPref = { model: { providerID: "openai", id: "gpt-5.6-sol" } };
    expect(resolveNativeRunPref(pref, new Set(["openai/gpt-5.6-sol"]), true)).toBe(pref);
  });

  it("clears an unavailable model and its model-specific effort", () => {
    expect(resolveNativeRunPref(stalePref, new Set(["gpt-5.6-sol"]), true)).toEqual({});
  });

  it("clears a saved model when the loaded runtime catalog is empty", () => {
    expect(resolveNativeRunPref(stalePref, new Set(), true)).toEqual({});
  });

  it("does not treat a CA provider as the runtime provider for the same model id", () => {
    const pref: NativeAgentRunPref = {
      model: { providerID: "openai", id: "gpt-6-astra" },
      reasoningEffort: "high",
    };
    expect(resolveNativeRunPref(pref, new Set(["magpie/gpt-6-astra"]), true)).toEqual({});
  });

  it("persists removal of a settings-only model without changing another Agent's preference", () => {
    const codexPref: NativeAgentRunPref = { model: { id: "gpt-6-astra" } };
    let stored = JSON.stringify({
      opencode: {
        model: { providerID: "openai", id: "server-default" },
        reasoningEffort: "high",
      },
      codex: codexPref,
    });
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    });
    try {
      const pref = resolveNativeRunPref(
        loadNativeRunPref("opencode"),
        new Set(["magpie/zcode/GLM-5.3"]),
        true,
      );
      saveNativeRunPref("opencode", pref);
      expect(loadNativeRunPref("opencode")).toEqual({});
      expect(loadNativeRunPref("codex")).toEqual(codexPref);
    } finally {
      vi.unstubAllGlobals();
    }
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
