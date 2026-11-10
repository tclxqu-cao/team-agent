import { useCallback, useEffect, useState } from "react";
import type { AgentType, RuntimeModelInfo } from "../global";

export type NativeModelCatalogStatus = "loading" | "ready" | "empty" | "unsupported" | "error";

export interface NativeModelCatalogState {
  scope: string;
  models: RuntimeModelInfo[];
  status: NativeModelCatalogStatus;
  error: string | null;
}

type LoadModels = (agentType: AgentType) => Promise<{ models: RuntimeModelInfo[]; supported?: boolean }>;

export function nativeModelCatalogScope(agentType: AgentType, sessionId: string | null): string {
  return JSON.stringify([agentType, agentType === "qoder" ? sessionId : null]);
}

function loadingCatalog(scope: string): NativeModelCatalogState {
  return { scope, models: [], status: "loading", error: null };
}

/** An empty Qoder response can precede session initialization, not model removal. */
export function isNativeModelCatalogReady(agentType: AgentType, state: NativeModelCatalogState): boolean {
  return state.status === "ready" || (agentType !== "qoder" && (state.status === "empty" || state.status === "unsupported"));
}

/** Each request has its own lifetime, including when an Agent is selected again. */
export function requestNativeModelCatalog(
  scope: string,
  agentType: AgentType,
  loadModels: LoadModels,
  publish: (state: NativeModelCatalogState) => void,
): () => void {
  let cancelled = false;
  publish(loadingCatalog(scope));
  void Promise.resolve().then(() => loadModels(agentType)).then(result => {
    if (cancelled) return;
    const models = result.supported === false ? [] : result.models ?? [];
    publish({ scope, models, status: result.supported === false ? "unsupported" : models.length ? "ready" : "empty", error: null });
  }).catch(cause => {
    if (!cancelled) publish({ scope, models: [], status: "error", error: cause instanceof Error ? cause.message : "模型列表加载失败" });
  });
  return () => { cancelled = true; };
}

function loadAgentModels(agentType: AgentType) {
  if (!window.agentApi?.listAgentModels) throw new Error("当前服务未提供模型列表接口，请更新服务");
  return window.agentApi.listAgentModels(agentType);
}

export function useNativeModelCatalog(agentType: AgentType, enabled: boolean, sessionId: string | null) {
  const scope = nativeModelCatalogScope(agentType, sessionId);
  const [state, setState] = useState<NativeModelCatalogState>(() => loadingCatalog(scope));
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    return requestNativeModelCatalog(scope, agentType, loadAgentModels, setState);
  }, [agentType, enabled, scope, revision]);
  const current = enabled && state.scope === scope ? state : loadingCatalog(scope);
  return { ...current, catalogReady: enabled && isNativeModelCatalogReady(agentType, current), retry };
}
