"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type AuthStatus = "loading" | "needsSetup" | "needsLogin" | "authenticated";
export interface WebUser { id: string; username: string }

export function useWebAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<WebUser | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    setStatus("loading"); setError(null);
    const load = async () => {
      const response = await fetch("/api/web-auth/status", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    try {
      let body;
      try { body = await load(); }
      catch { body = await load(); }
      if (body.needsSetup) { setStatus("needsSetup"); setUser(null); return; }
      if (!body.authenticated) { setStatus("needsLogin"); setUser(null); return; }
      setUser(body.user); setCsrfToken(body.csrfToken); setStatus("authenticated");
    } catch {
      const host = typeof location !== "undefined" ? location.host : "";
      const hint = host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "请确认 dev:server 已启动（bun run dev:server）"
        : `请确认 ${host} 可访问且 Gateway 未在重启中`;
      setError(`无法连接认证服务：${hint}`);
      setStatus("needsLogin");
    }
  }, []);

  useEffect(() => { if (initialized.current) return; initialized.current = true; refresh(); }, [refresh]);

  const submit = useCallback(async (mode: "setup" | "login", username: string, password: string) => {
    setError(null);
    const pairingToken=mode==="setup"?new URLSearchParams(location.search).get("pair")||undefined:undefined;
    const response = await fetch(`/api/web-auth/${mode}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, pairingToken }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error?.message || "认证失败"); return false; }
    setUser(body.user); setCsrfToken(body.csrfToken); setStatus("authenticated");if(pairingToken)history.replaceState(null,"",location.pathname);return true;
  }, []);

  const getWsNonce = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/web-console/bootstrap", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) { setStatus("needsLogin"); throw new Error("unauthenticated"); }
    if (!response.ok) throw new Error("bootstrap failed");
    return (await response.json()).wsNonce;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/web-auth/logout", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrfToken } });
    setUser(null); setCsrfToken(""); setStatus("needsLogin");
  }, [csrfToken]);

  return { status, user, error, csrfToken, setup: (u: string, p: string) => submit("setup", u, p), login: (u: string, p: string) => submit("login", u, p), logout, refresh, getWsNonce };
}
