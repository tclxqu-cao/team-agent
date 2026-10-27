import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeBackgroundJob } from "../global";

export function useSessionBackgroundJobs(sessionId: string) {
  const [jobs, setJobs] = useState<RuntimeBackgroundJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const selectedRef = useRef(sessionId);
  const revisionRef = useRef(0);
  const pendingRef = useRef(new Set<string>());
  selectedRef.current = sessionId;

  const refresh = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const api = window.agentApi;
      if (!api?.listSessionBackgroundJobs) throw new Error("当前服务未提供后台任务接口，请更新服务");
      const rows = await api.listSessionBackgroundJobs(sessionId);
      if (selectedRef.current !== sessionId || revisionRef.current !== revision) return;
      setJobs(rows);
      setError(null);
      setStopping(previous => new Set([...previous].filter(id => rows.some(job => job.id === id && job.status === "running"))));
    } catch (failure) {
      if (selectedRef.current === sessionId && revisionRef.current === revision) {
        setError(failure instanceof Error ? failure.message : "后台任务读取失败");
      }
    } finally {
      if (selectedRef.current === sessionId && revisionRef.current === revision) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    selectedRef.current = sessionId;
    let disposed = false;
    let inFlight = false;
    setJobs([]); setError(null); setActionError(null); setLoading(true); setStopping(new Set());
    pendingRef.current.clear();
    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try { await refresh(); } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      disposed = true; ++revisionRef.current; selectedRef.current = "";
      window.clearInterval(timer); document.removeEventListener("visibilitychange", poll);
    };
  }, [sessionId, refresh]);

  const stop = useCallback(async (jobId: string) => {
    if (pendingRef.current.has(jobId)) return;
    const owner = selectedRef.current;
    pendingRef.current.add(jobId);
    setStopping(previous => new Set([...previous, jobId]));
    setActionError(null);
    ++revisionRef.current;
    try {
      const api = window.agentApi;
      if (!api?.stopSessionBackgroundJob) throw new Error("当前服务未提供后台任务停止接口，请更新服务");
      await api.stopSessionBackgroundJob(sessionId, jobId);
      if (selectedRef.current === owner) await refresh();
    } catch (failure) {
      if (selectedRef.current === owner) {
        setActionError(failure instanceof Error ? failure.message : "后台任务停止失败");
        setStopping(previous => { const next = new Set(previous); next.delete(jobId); return next; });
      }
    } finally { pendingRef.current.delete(jobId); }
  }, [sessionId, refresh]);

  return { jobs, loading, error, actionError, stopping, refresh, stop };
}
