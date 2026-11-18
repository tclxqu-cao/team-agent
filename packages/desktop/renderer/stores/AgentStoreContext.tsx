import { createContext, useContext, type ReactNode } from "react";
import { useAgentStore, type AgentStore } from "./agentStore";

const AgentStoreContext = createContext<AgentStore | null>(null);

export function AgentStoreProvider({ store, children }: { store: AgentStore; children: ReactNode }) {
  return <AgentStoreContext.Provider value={store}>{children}</AgentStoreContext.Provider>;
}

/** Nested tool cards and settings must observe the same session store as their ChatView. */
export function useScopedAgentStore<T>(selector: (state: ReturnType<AgentStore["getState"]>) => T): T {
  const useStore = useContext(AgentStoreContext) ?? useAgentStore;
  return useStore(selector);
}
