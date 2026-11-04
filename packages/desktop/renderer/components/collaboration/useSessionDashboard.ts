import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDashboardSnapshot } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest } from "./client";
import { useErrorNotice } from "../../lib/use-error-notice";

export function useSessionDashboard() {
  const [snapshot, setSnapshot] = useState<SessionDashboardSnapshot | null>(null);
  const { notice, report, recover, dismiss } = useErrorNotice();
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const live = useRef(true);
  const refresh = useCallback(async (manual = true) => {
    if (pending.current) return;
    pending.current = true;
    try {
      const next = await collaborationRequest<SessionDashboardSnapshot>({ action: "dashboard" });
      if (live.current) {
        setSnapshot(next);
        if (next.discoveryError) report({ source: "dashboard", title: "原生会话加载失败", message: next.discoveryError, onRetry: () => void refresh() }, manual);
        else recover("dashboard");
      }
    } catch (error) {
      if (live.current) report({ source: "dashboard", title: "看板加载失败", message: error instanceof Error ? error.message : "无法加载看板", onRetry: () => void refresh() }, manual);
    }
    finally { pending.current = false; if (live.current) setLoading(false); }
  }, [report, recover]);
  useEffect(() => {
    live.current = true;
    void refresh(false);
    const timer = setInterval(() => { if (!document.hidden) void refresh(false); }, 5000);
    const focus = () => { void refresh(false); };
    window.addEventListener("focus", focus);
    return () => { live.current = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return { snapshot, notice, dismissError: dismiss, loading, refresh };
}
