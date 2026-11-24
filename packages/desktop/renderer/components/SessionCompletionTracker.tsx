import { useEffect } from "react";
import { usePageActive } from "../lib/page-activity";
import { useSessionActivity } from "../lib/use-session-activity";
import { useSessionCompletionStore } from "../stores/session-completion-store";

export default function SessionCompletionTracker({ viewedSessionId }: { viewedSessionId: string | null }) {
  const active = usePageActive();
  const activity = useSessionActivity();
  const completedAt = useSessionCompletionStore(state => viewedSessionId
    ? state.receipts[viewedSessionId]?.completedAt
    : undefined);

  useEffect(() => {
    if (activity) useSessionCompletionStore.getState().recordCompletions(activity.sessions);
  }, [activity]);
  useEffect(() => {
    if (active && viewedSessionId) {
      useSessionCompletionStore.getState().markViewed(viewedSessionId, Math.max(Date.now(), completedAt ?? 0));
    }
  }, [active, viewedSessionId, completedAt]);
  return null;
}
