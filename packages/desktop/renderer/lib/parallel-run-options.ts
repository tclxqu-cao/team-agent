import type { AgentApi, SessionMessageRunOptions, UnifiedSessionSummary } from "../global";
import { isNativeAgentType, loadNativeRunPref, nativeModelKey, nativeReasoningEffortOptions, resolveNativeRunPref } from "./native-agent-run-prefs";

export async function parallelRunOptions(
  api: Pick<AgentApi, "listAgentModels">,
  member: Pick<UnifiedSessionSummary, "agentType" | "nativeModelSelectionSupported">,
  profileId?: string,
): Promise<SessionMessageRunOptions | undefined> {
  if (!isNativeAgentType(member.agentType)) return profileId ? { profileId } : undefined;
  if (member.nativeModelSelectionSupported === false) return undefined;
  const saved = loadNativeRunPref(member.agentType);
  if (!saved.model?.id && !saved.reasoningEffort) return undefined;
  // A catalog failure must not silently substitute a different Agent's model.
  const catalog = (await api.listAgentModels(member.agentType)).models;
  const pref = resolveNativeRunPref(saved, catalog, true);
  const model = pref.model ? catalog.find(item => nativeModelKey(item) === nativeModelKey(pref.model!)) : undefined;
  const efforts = nativeReasoningEffortOptions(member.agentType, model?.reasoningEfforts);
  return {
    ...(pref.model ? { model: pref.model } : {}),
    ...(pref.reasoningEffort && efforts.includes(pref.reasoningEffort) ? { reasoningEffort: pref.reasoningEffort } : {}),
  };
}
