import { useCallback, useSyncExternalStore } from "react";
import type { SessionActivitySnapshot } from "../../../core/src/domain/supervision/types";
import { collaborationRequest } from "../components/collaboration/client";
import { usePageActive } from "./page-activity";
import { createSessionActivityStore } from "./session-activity";
import { useSessionViewSync } from "./use-session-view-sync";

const store = createSessionActivityStore(
  () => collaborationRequest<SessionActivitySnapshot>({ action: "sessionActivity" }),
  listener => typeof window !== "undefined" && window.agentApi?.onEvent ? window.agentApi.onEvent(listener) : () => {},
);

export function useSessionActivity(): SessionActivitySnapshot | null {
  const active = usePageActive();
  useSessionViewSync(active);
  const subscribe = useCallback((notify: () => void) => store.subscribe(notify, active), [active]);
  return useSyncExternalStore(subscribe, store.getSnapshot, () => null);
}
