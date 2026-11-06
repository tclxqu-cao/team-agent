import { usePageActive, isPageActive } from "../../lib/page-activity";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupervisionMessage, SupervisionMessagePage } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest } from "./client";
import { mergeSupervisionMessages } from "./supervision-timeline";

/** Independent of discussion selection: an otherwise empty group still has a journal. */
export function useSupervisionMessages(groupId: string) {
  const active = usePageActive();
  const [messages, setMessages] = useState<SupervisionMessage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const current = useRef({ groupId, generation: 0, latest: 0, before: null as number | null, loaded: false, older: false });

  useEffect(() => {
    const state = { groupId, generation: current.current.generation + 1, latest: 0, before: null as number | null, loaded: false, older: false };
    current.current = state;
    setMessages([]); setError(""); setBefore(null); setLoading(true); setLoadingOlder(false);
  }, [groupId]);

  useEffect(() => {
    if (!active) return;
    const state = current.current;
    let live = true, inFlight = false;
    const poll = async () => {
      if (inFlight || !groupId || !isPageActive()) return;
      inFlight = true;
      try {
        const page = await collaborationRequest<SupervisionMessagePage>({ action: "supervisionMessages", groupId, limit: 100, ...(state.loaded ? { afterSequence: state.latest } : {}) });
        if (!live) return;
        setMessages(existing => mergeSupervisionMessages(existing, page.messages));
        if (!state.loaded) { state.before = page.nextBefore; setBefore(page.nextBefore); }
        state.latest = Math.max(state.latest, page.latestSequence);
        state.loaded = true; setError("");
      } catch (error) {
        if (live) setError(`监工消息加载失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        inFlight = false;
        if (live) setLoading(false);
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [active, groupId]);

  const loadOlder = useCallback(async () => {
    const state = current.current;
    if (state.groupId !== groupId || state.before === null || state.older) return;
    state.older = true; setLoadingOlder(true);
    try {
      const page = await collaborationRequest<SupervisionMessagePage>({ action: "supervisionMessages", groupId, beforeSequence: state.before, limit: 100 });
      if (current.current !== state) return;
      setMessages(existing => mergeSupervisionMessages(existing, page.messages));
      state.before = page.nextBefore; setBefore(page.nextBefore); setError("");
    } catch (error) {
      if (current.current === state) setError(`历史监工消息加载失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.older = false;
      if (current.current === state) setLoadingOlder(false);
    }
  }, [groupId]);
  return { messages, error, loading, loadingOlder, hasOlder: before !== null, loadOlder };
}
