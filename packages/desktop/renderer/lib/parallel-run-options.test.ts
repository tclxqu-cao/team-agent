import { afterEach, describe, expect, it, vi } from "vitest";
import { parallelRunOptions } from "./parallel-run-options";
import { saveNativeRunPref } from "./native-agent-run-prefs";

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
}
describe("per-Agent run preferences", () => {
  it("pins the selected Customer Agent profile without querying a native model catalog", async () => {
    const listAgentModels = vi.fn();
    await expect(parallelRunOptions({ listAgentModels }, { agentType: "customer-agent" }, "customer-profile")).resolves.toEqual({ profileId: "customer-profile" });
    expect(listAgentModels).not.toHaveBeenCalled();
  });
  it("validates each saved model against that Agent's current catalog", async () => {
    storage();
    saveNativeRunPref("codex", { model: { id: "codex-model" }, reasoningEffort: "high" });
    saveNativeRunPref("zcode", { model: { id: "zcode-model" }, reasoningEffort: "medium" });
    const api = { listAgentModels: vi.fn(async agentType => ({ agentType, models: [{ id: `${agentType}-model`, reasoningEfforts: agentType === "codex" ? ["high"] : ["medium"] }] })) };
    await expect(parallelRunOptions(api as never, { agentType: "codex" })).resolves.toEqual({ model: { id: "codex-model" }, reasoningEffort: "high" });
    await expect(parallelRunOptions(api as never, { agentType: "zcode" })).resolves.toEqual({ model: { id: "zcode-model" }, reasoningEffort: "medium" });
    expect(api.listAgentModels.mock.calls.map(call => call[0])).toEqual(["codex", "zcode"]);
  });
  it("does not send a stale model or another runtime's effort", async () => {
    storage();
    saveNativeRunPref("zcode", { model: { id: "removed-model" }, reasoningEffort: "max" });
    await expect(parallelRunOptions({ listAgentModels: async () => ({ agentType: "zcode", models: [{ id: "current-model" }] }) }, { agentType: "zcode" })).resolves.toEqual({});
  });
  it("uses native defaults without loading a catalog when no override was selected", async () => {
    storage();
    const listAgentModels = vi.fn();
    await expect(parallelRunOptions({ listAgentModels }, { agentType: "codex" })).resolves.toBeUndefined();
    expect(listAgentModels).not.toHaveBeenCalled();
  });
});
