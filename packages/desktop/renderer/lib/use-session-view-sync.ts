import { useEffect } from "react";
import { SESSION_VIEW_BATCH_SIZE, type SessionView } from "../../../core/src/application/session/SyncSessionViews";
import { useSessionCompletionStore } from "../stores/session-completion-store";

const POLL_MS = 2_000;
const store = useSessionCompletionStore;
let revision = 0;
let subscribed = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let ready = false;
const sent = new Map<string, number>();

function pendingViews(): SessionView[] {
  const { receipts, sharedViews } = store.getState();
  const views: SessionView[] = [];
  for (const [sessionId, { viewedAt }] of Object.entries(receipts)) {
    if (!viewedAt || !Number.isSafeInteger(viewedAt) || viewedAt <= 0 || !sessionId || sessionId.length > 400) continue;
    if (viewedAt <= Math.max(sharedViews.get(sessionId) ?? 0, sent.get(sessionId) ?? 0)) continue;
    views.push({ sessionId, viewedAt });
    if (views.length === SESSION_VIEW_BATCH_SIZE) break;
  }
  return views;
}

function schedule(delay: number) {
  clearTimeout(timer);
  if (subscribed) timer = setTimeout(() => void sync(), delay);
}

async function sync() {
  const api = window.agentApi;
  if (pending || !subscribed || !api?.syncSessionViews) return;
  pending = true;
  let delay = POLL_MS;
  try {
    const views = ready ? pendingViews() : [];
    const page = await api.syncSessionViews({ afterRevision: revision, views });
    revision = page.revision;
    ready = !page.hasMore;
    store.getState().receiveViews(page.views);
    for (const { sessionId, viewedAt } of views) sent.set(sessionId, viewedAt);
    if (page.hasMore || pendingViews().length) delay = 0;
  } catch {
    // Retain local receipts so an interrupted write can be retried.
  } finally {
    pending = false;
    schedule(delay);
  }
}

export function useSessionViewSync(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    subscribed++;
    const stop = store.subscribe((state, previous) => {
      if (!pending && state.receipts !== previous.receipts && pendingViews().length) schedule(0);
    });
    if (subscribed === 1) schedule(0);
    return () => {
      stop();
      if (!--subscribed) clearTimeout(timer);
    };
  }, [active]);
}
