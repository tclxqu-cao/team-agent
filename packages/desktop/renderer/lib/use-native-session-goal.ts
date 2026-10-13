import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeGoalMutation, NativeSessionGoal } from "../global";

/** Selected-session projection; native Host owns persistence, scheduling and activation. */
export function useNativeSessionGoal(sessionId: string | null, enabled: boolean) {
  const [goal, setGoal] = useState<NativeSessionGoal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectedRef = useRef(sessionId);
  selectedRef.current = sessionId;
  const revisionRef = useRef(0);
  const mutationRef = useRef(false);
  const refresh = useCallback(async (id: string, clearError = true) => {
    if (!window.agentApi?.getSessionNativeGoal) throw new Error("当前服务未提供原生目标接口，请更新服务");
    const revision = ++revisionRef.current;
    const value = await window.agentApi.getSessionNativeGoal(id);
    if (selectedRef.current === id && revisionRef.current === revision) {
      setGoal(value);
      if (clearError) setError(null);
    }
    return value;
  }, []);
  useEffect(() => {
    ++revisionRef.current;
    setGoal(null);
    setError(null);
    if (!enabled || !sessionId) return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight || mutationRef.current || document.visibilityState === "hidden") return;
      inFlight = true;
      try { await refresh(sessionId); }
      catch (failure) {
        if (!disposed && selectedRef.current === sessionId) setError(failure instanceof Error ? failure.message : "目标读取失败");
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    document.addEventListener("visibilitychange", poll);
    return () => { disposed = true; ++revisionRef.current; window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [sessionId, enabled, refresh]);
  const mutate = useCallback(async (id: string, mutation: NativeGoalMutation) => {
    if (!window.agentApi?.mutateSessionNativeGoal) throw new Error("当前服务未提供原生目标接口，请更新服务");
    if (mutationRef.current) throw new Error("目标正在更新，请稍候");
    mutationRef.current = true;
    const revision = ++revisionRef.current;
    setPending(true);
    setError(null);
    try {
      const value = await window.agentApi.mutateSessionNativeGoal(id, mutation);
      if (selectedRef.current === id && revisionRef.current === revision) setGoal(value);
      return value;
    } catch (failure) {
      if (selectedRef.current === id) {
        setError(failure instanceof Error ? failure.message : "目标操作失败");
        void refresh(id, false).catch(() => undefined);
      }
      throw failure;
    } finally { mutationRef.current = false; setPending(false); }
  }, [refresh]);
  return { goal, error, pending, refresh, mutate };
}
