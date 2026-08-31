"use client";
import { useCallback, useEffect, useState } from "react";

export type AuthStatus = "loading" | "needsSetup" | "needsLogin" | "authenticated";
export interface WebUser { id: string; username: string }

/** Passwordless controller retained behind the existing AuthGate contract. */
export function useWebAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<WebUser | null>(null);
  const [csrfToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/web-console/bootstrap", {
        credentials: "same-origin",
        cache: "no-store",
      });
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
    if (!response.ok) throw new Error("bootstrap failed");
    const body = await response.json();
    setUser(body.user);
    setStatus("authenticated");
    return body.wsNonce;
  }, []);

  const noop = useCallback(async () => true, []);
  return {
    status,
    user,
    error,
    csrfToken,
    setup: noop,
    login: noop,
    logout: refresh,
    refresh,
    getWsNonce,
  };
}
