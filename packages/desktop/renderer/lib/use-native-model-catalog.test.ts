import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelInfo } from "../../../shared/src/contracts/agent-api";
import { resolveNativeRunPref } from "./native-agent-run-prefs";
import { isNativeModelCatalogReady, nativeModelCatalogScope, requestNativeModelCatalog, type NativeModelCatalogState } from "./use-native-model-catalog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function observer() {
  const states: NativeModelCatalogState[] = [];
  const publish = (state: NativeModelCatalogState) => { states.push(state); };
  return { states, publish, latest: () => states.at(-1)! };
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

const models: RuntimeModelInfo[] = [{ id: "native-model", displayName: "Native model" }];

describe("native model catalog requests", () => {
  it.each(["qoder", "zcode", "agy"] as const)("reloads a %s catalog after the first session is created instead of retaining an empty result", async agentType => {
    const observed = observer();
    const load = vi.fn().mockResolvedValueOnce({ models: [] }).mockResolvedValueOnce({ models });
    const draftScope = nativeModelCatalogScope(agentType, null);
    const cancel = requestNativeModelCatalog(draftScope, agentType, load, observed.publish);
    await flush();
    expect(observed.latest().status).toBe("empty");
    const createdScope = nativeModelCatalogScope(agentType, `${agentType}:created`);
    expect(createdScope).not.toBe(draftScope);
    cancel();
    requestNativeModelCatalog(createdScope, agentType, load, observed.publish);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(observed.latest()).toMatchObject({ scope: createdScope, status: "ready", models });
  });

  it("keeps the per-Agent scope for other runtimes", () => {
    expect(nativeModelCatalogScope("codex", null)).toBe(nativeModelCatalogScope("codex", "codex:created"));
    expect(nativeModelCatalogScope("qoder", "first")).not.toBe(nativeModelCatalogScope("qoder", "second"));
  });

  it("reports errors and allows an explicit retry in the same scope", async () => {
    const observed = observer();
    const scope = nativeModelCatalogScope("qoder", null);
    const load = vi.fn().mockRejectedValueOnce(new Error("Login required")).mockResolvedValueOnce({ models });
    const cancel = requestNativeModelCatalog(scope, "qoder", load, observed.publish);
    await flush();
    expect(observed.latest()).toMatchObject({ status: "error", error: "Login required" });
    cancel();
    requestNativeModelCatalog(scope, "qoder", load, observed.publish);
    expect(observed.latest().status).toBe("loading");
    await flush();
    expect(observed.latest()).toMatchObject({ status: "ready", error: null, models });
  });

  it("ignores the previous request when switching A to B and back to A", async () => {
    const oldA = deferred<{ models: RuntimeModelInfo[] }>();
    const oldB = deferred<{ models: RuntimeModelInfo[] }>();
    const observed = observer();
    const scope = nativeModelCatalogScope("qoder", null);
    const cancelA = requestNativeModelCatalog(scope, "qoder", () => oldA.promise, observed.publish);
    cancelA();
    const cancelB = requestNativeModelCatalog(nativeModelCatalogScope("codex", null), "codex", () => oldB.promise, observed.publish);
    cancelB();
    requestNativeModelCatalog(scope, "qoder", async () => ({ models }), observed.publish);
    await flush();
    oldA.resolve({ models: [{ id: "stale-A" }] });
    oldB.resolve({ models: [{ id: "stale-B" }] });
    await flush();
    expect(observed.latest()).toMatchObject({ scope, models });
    expect(observed.states.filter(state => state.status === "ready")).toHaveLength(1);
  });

  it("does not publish results after cleanup", async () => {
    const pending = deferred<{ models: RuntimeModelInfo[] }>();
    const observed = observer();
    const cancel = requestNativeModelCatalog("scope", "qoder", () => pending.promise, observed.publish);
    cancel();
    pending.resolve({ models });
    await flush();
    expect(observed.states.map(state => state.status)).toEqual(["loading"]);
  });

  it.each(["qoder", "zcode"] as const)("does not clear a saved %s model or reasoning effort on loading, empty, unsupported or failed catalogs", agentType => {
    const pref = { model: { id: "native-model" }, reasoningEffort: "high" as const };
    for (const status of ["loading", "empty", "unsupported", "error"] as const) {
      const state: NativeModelCatalogState = { scope: agentType, models: [], status, error: null };
      expect(isNativeModelCatalogReady(agentType, state)).toBe(false);
      expect(resolveNativeRunPref(pref, state.models, isNativeModelCatalogReady(agentType, state))).toBe(pref);
    }
    const state: NativeModelCatalogState = { scope: agentType, models, status: "ready", error: null };
    expect(isNativeModelCatalogReady(agentType, state)).toBe(true);
    expect(resolveNativeRunPref(pref, models, true)).toBe(pref);
    expect(resolveNativeRunPref(pref, [{ id: "replacement" }], true)).toEqual({});
  });

  it("preserves authoritative empty-catalog validation for other Agents", () => {
    const state: NativeModelCatalogState = { scope: "codex", models: [], status: "empty", error: null };
    expect(isNativeModelCatalogReady("codex", state)).toBe(true);
    expect(resolveNativeRunPref({ model: { id: "stale" } }, [], true)).toEqual({});
  });

  it("does not expose models from an unsupported runtime response", async () => {
    const observed = observer();
    requestNativeModelCatalog("scope", "qoder", async () => ({ models, supported: false }), observed.publish);
    await flush();
    expect(observed.latest()).toMatchObject({ status: "unsupported", models: [] });
  });

  it("handles a synchronous loader failure without leaking a rejected promise", async () => {
    const observed = observer();
    requestNativeModelCatalog("scope", "qoder", () => { throw new Error("No API"); }, observed.publish);
    await flush();
    expect(observed.latest()).toMatchObject({ status: "error", error: "No API" });
  });
});
