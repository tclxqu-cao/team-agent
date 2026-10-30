import type { AgentType, NativeReasoningEffort, RuntimeModelInfo, RuntimeModelSelection } from "../global";

/**
 * Per-agent-type model/reasoning-effort choices made in the composer. Kept in
 * localStorage (renderer-local, both desktop and web shell) and sent with
 * every native run; native runtimes have no cross-device session policy.
 */
export interface NativeAgentRunPref {
  model?: RuntimeModelSelection;
  reasoningEffort?: NativeReasoningEffort;
}

import { isNativeAgentType as isNativeType } from "../../../core/src/domain/agent/agent-type";

const STORAGE_KEY = "webapp.nativeAgentRunPrefs.v1";

type PrefStore = Partial<Record<AgentType, NativeAgentRunPref>>;

export interface OpenCodePickerModel extends RuntimeModelInfo {
  optionLabel: string;
}

export interface OpenCodeModelGroup {
  key: string;
  label: string;
  models: OpenCodePickerModel[];
}

function readStore(): PrefStore {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as PrefStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function isNativeAgentType(agentType: AgentType | undefined | null): agentType is Exclude<AgentType, "customer-agent"> {
  return isNativeType(agentType);
}

export function nativeReasoningEffortOptions(agentType: AgentType, advertised?: readonly NativeReasoningEffort[]): NativeReasoningEffort[] {
  if (!isNativeAgentType(agentType)) return [];
  if (advertised?.length) return [...advertised];
  return agentType === "claude-code" ? ["low", "medium", "high", "xhigh"] : [];
}

export function loadNativeRunPref(agentType: AgentType): NativeAgentRunPref {
  if (!isNativeAgentType(agentType)) return {};
  return readStore()[agentType] ?? {};
}

export function saveNativeRunPref(agentType: AgentType, pref: NativeAgentRunPref): void {
  if (!isNativeAgentType(agentType)) return;
  const store = readStore();
  store[agentType] = pref;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private-mode browsers drop localStorage writes; the choice still applies to this run.
  }
}

/** Validate saved choices and restore the exact model identity from the runtime catalog. */
export function resolveNativeRunPref(
  pref: NativeAgentRunPref,
  availableModels: readonly RuntimeModelInfo[],
  catalogReady: boolean,
): NativeAgentRunPref {
  if (!catalogReady || !pref.model?.id) return pref;
  const key = nativeModelKey(pref.model);
  const model = availableModels.find(model => nativeModelKey(model) === key);
  if (!model) return {};
  if (model.id === pref.model.id && model.providerID === pref.model.providerID) return pref;
  return { ...pref, model: { id: model.id, ...(model.providerID ? { providerID: model.providerID } : {}) } };
}

/** Select option value encoding for a model that may be provider-scoped (opencode). */
export function nativeModelKey(model: RuntimeModelSelection): string {
  return model.providerID ? `${model.providerID}/${model.id}` : model.id;
}

export function nativeModelFromKey(key: string, models: readonly RuntimeModelInfo[]): RuntimeModelSelection {
  // Native IDs can contain slashes; only the catalog defines provider scope.
  const model = models.find(model => nativeModelKey(model) === key);
  return model?.providerID ? { id: model.id, providerID: model.providerID } : { id: model?.id ?? key };
}

/** Group provider-scoped OpenCode models for the native model picker. */
export function groupOpenCodeModels(models: readonly RuntimeModelInfo[]): OpenCodeModelGroup[] {
  const groups = new Map<string, OpenCodeModelGroup>();
  for (const model of models) {
    const providerID = model.providerID?.trim();
    const providerName = model.providerDisplayName?.trim() || providerID || "其他供应商";
    const key = providerID || "__other__";
    const group = groups.get(key) ?? {
      key,
      label: providerID === "opencode-go" ? `${providerName}（需订阅）` : providerName,
      models: [],
    };
    group.models.push({
      ...model,
      optionLabel: model.displayName || model.id,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}
