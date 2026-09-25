import { describe, expect, it } from "vitest";
import {
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
});
