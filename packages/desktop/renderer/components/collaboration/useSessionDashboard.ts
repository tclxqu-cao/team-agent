import { usePageActive, isPageActive } from "../../lib/page-activity";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDashboardSnapshot } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest } from "./client";
import { useErrorNotice } from "../../lib/use-error-notice";

export function useSessionDashboard() {
  const active = usePageActive();
  const [snapshot, setSnapshot] = useState<SessionDashboardSnapshot | null>(null);
  const { notice, report, recover, dismiss } = useErrorNotice();
  const [loading, setLoading] = useState(true);
  const pending = useRef<symbol | null>(null);
  const live = useRef(true);
  const refresh = useCallback(async (manual = true) => {
    if (pending.current || !isPageActive()) return;
    const request = Symbol();
    pending.current = request;
    try {
      const next = await collaborationRequest<SessionDashboardSnapshot>({ action: "dashboard" });
      if (live.current && pending.current === request && isPageActive()) {
        setSnapshot(next);
        if (next.discoveryError) report({ source: "dashboard", title: "原生会话加载失败", message: next.discoveryError, onRetry: () => void refresh() }, manual);
        else recover("dashboard");
      }
    } catch (error) {
      if (live.current && pending.current === request && isPageActive()) report({ source: "dashboard", title: "看板加载失败", message: error instanceof Error ? error.message : "无法加载看板", onRetry: () => void refresh() }, manual);
    }
    finally {
      if (pending.current === request) {
        pending.current = null;
        if (live.current) setLoading(false);
      }
    }
  }, [report, recover]);
  useEffect(() => {
    if (!active) return;
    live.current = true;
    recover("dashboard");
    setLoading(true);
    void refresh(false);
    const timer = setInterval(() => { if (isPageActive()) void refresh(false); }, 5000);
    const focus = () => { void refresh(false); };
    window.addEventListener("focus", focus);
    return () => {
      live.current = false;
      // A request from the previous visit must neither block nor overwrite re-entry.
      pending.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [active, refresh, recover]);
  return { snapshot, notice, dismissError: dismiss, loading, refresh };
}
