import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDashboardSnapshot } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest } from "./client";

export function useSessionDashboard() {
  const [snapshot, setSnapshot] = useState<SessionDashboardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const next = await collaborationRequest<SessionDashboardSnapshot>({ action: "dashboard" });
      if (live.current) { setSnapshot(next); setError(""); }
    } catch (error) { if (live.current) setError(error instanceof Error ? error.message : "无法加载看板"); }
    finally { pending.current = false; if (live.current) setLoading(false); }
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { live.current = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return { snapshot, error, loading, refresh };
}
