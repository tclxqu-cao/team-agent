import type { AgentType, NativeReasoningEffort, RuntimeModelSelection } from "../global";

/**
 * Per-agent-type model/reasoning-effort choices made in the composer. Kept in
 * localStorage (renderer-local, both desktop and web shell) and sent with
 * every native run; native runtimes have no cross-device session policy.
 */
export interface NativeAgentRunPref {
  model?: RuntimeModelSelection;
  reasoningEffort?: NativeReasoningEffort;
}

const STORAGE_KEY = "webapp.nativeAgentRunPrefs.v1";
const NATIVE_AGENT_TYPES: readonly AgentType[] = ["codex", "claude-code", "opencode"];

type PrefStore = Partial<Record<AgentType, NativeAgentRunPref>>;

function readStore(): PrefStore {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as PrefStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function isNativeAgentType(agentType: AgentType | undefined | null): agentType is Exclude<AgentType, "customer-agent"> {
  return NATIVE_AGENT_TYPES.includes(agentType as Exclude<AgentType, "customer-agent">);
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

/** Drop a persisted model and its model-specific effort once both catalogs prove it unavailable. */
export function resolveNativeRunPref(
  pref: NativeAgentRunPref,
  availableModelKeys: ReadonlySet<string>,
  catalogReady: boolean,
): NativeAgentRunPref {
  if (!catalogReady || !pref.model?.id || availableModelKeys.has(nativeModelKey(pref.model))) {
    return pref;
  }
  return {};
}

/** Select option value encoding for a model that may be provider-scoped (opencode). */
export function nativeModelKey(model: RuntimeModelSelection): string {
  return model.providerID ? `${model.providerID}/${model.id}` : model.id;
}

export function nativeModelFromKey(key: string): RuntimeModelSelection {
  const separator = key.indexOf("/");
  return separator > 0
    ? { providerID: key.slice(0, separator), id: key.slice(separator + 1) }
    : { id: key };
}
