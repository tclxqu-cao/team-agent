"use client";
import { useCallback, useEffect, useState } from "react";

export type AuthStatus = "loading" | "needsSetup" | "needsLogin" | "authenticated";
export interface WebUser { id: string; username: string }

/** The outer gateway owns device pairing; this controller refreshes its session. */
export function useWebAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<WebUser | null>(null);
  // Legacy UI persistence marker; the gateway validates Origin on cookie-authenticated writes.
  const [csrfToken] = useState("same-origin");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/web-console/bootstrap", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if ((response.status === 401 || response.status === 423)) { window.location.reload(); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setUser(body.user);
      setStatus("authenticated");
    } catch {
      setError("无法连接远程控制台");
      setStatus("needsLogin");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const getWsNonce = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/web-console/bootstrap", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if ((response.status === 401 || response.status === 423)) window.location.reload();
    if (!response.ok) throw new Error("bootstrap failed");
    const body = await response.json();
    setUser(body.user);
    setStatus("authenticated");
    return body.wsNonce;
  }, []);

  const pairRequired = useCallback(async () => { window.location.reload(); return false; }, []);
  const logout = useCallback(async () => {
    const response = await fetch("/api/pairing/logout", { method: "POST", credentials: "same-origin" });
    if (response.ok || (response.status === 401 || response.status === 423)) window.location.reload();
    else setError("退出失败，请重试");
  }, []);
  return {
    status,
    user,
    error,
    csrfToken,
    setup: pairRequired,
    login: pairRequired,
    logout,
    refresh,
    getWsNonce,
  };
}
