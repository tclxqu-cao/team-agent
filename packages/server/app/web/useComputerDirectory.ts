"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { validateComputerConnections, type SavedComputerConnection } from "../../../core/src/domain/web-console/computer-directory";
import { readComputers, rememberComputer, saveComputers } from "../../public/pwa/computer-directory.js";
import { consoleOrigin } from "./console-environment";

async function requestDirectory(csrfToken: string, method = "GET", body?: unknown): Promise<SavedComputerConnection[]> {
  const response = await fetch("/api/web-console/computers", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "content-type": "application/json", "x-csrf-token": csrfToken } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error("无法连接当前电脑，请检查连接后重试。"); });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? "电脑列表保存失败，请重试。");
  return validateComputerConnections(result?.computers);
}

/** SQLite owns the directory; browser storage only imports old connections and carries legacy pages. */
export function useComputerDirectory(csrfToken: string) {
  const [computers, setComputers] = useState<SavedComputerConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const busy = useRef(false);
  const generation = useRef(0);
  const imported = useRef(false);
  const apply = useCallback((connections: SavedComputerConnection[]) => {
    if (!mounted.current) return;
    setComputers(previous => previous.length === connections.length
      && previous.every((connection, index) => connection.origin === connections[index].origin && connection.name === connections[index].name)
      ? previous : connections);
    setLoaded(true);
    try {
      const legacy = readComputers();
      saveComputers(connections.map(connection => ({
        ...legacy.find(entry => entry.origin === connection.origin), ...connection,
      })));
    } catch { /* A browser cache failure does not invalidate persisted database connections. */ }
  }, []);

  const reload = useCallback(async () => {
    if (busy.current) return;
    const attempt = ++generation.current;
    try {
      const legacy = !imported.current
        ? rememberComputer(consoleOrigin(), undefined).map(({ origin, name }) => ({ origin, name }))
        : undefined;
      const connections = await requestDirectory(csrfToken, legacy ? "POST" : "GET", legacy ? { computers: legacy } : undefined);
      if (!mounted.current || attempt !== generation.current) return;
      imported.current = true;
      apply(connections);
      setError("");
    } catch (cause) {
      if (mounted.current && attempt === generation.current) setError(cause instanceof Error ? cause.message : "无法读取电脑列表。");
    }
  }, [apply, csrfToken]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const refresh = () => { if (!document.hidden) void reload(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      mounted.current = false; generation.current++;
      window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh);
      window.clearInterval(timer);
    };
  }, [reload]);

  const mutate = useCallback(async (method: string, body: unknown) => {
    if (!loaded || busy.current) throw new Error("电脑列表尚未就绪，请稍后重试。");
    busy.current = true; generation.current++;
    setSaving(true); setError("");
    try { apply(await requestDirectory(csrfToken, method, body)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "电脑列表保存失败，请重试。";
      if (mounted.current) setError(message);
      throw new Error(message);
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [apply, csrfToken, loaded]);

  const rename = useCallback((origin: string, name: string) => mutate("PATCH", validateComputerConnections([{ origin, name }])[0]), [mutate]);
  const remove = useCallback(async (origin: string) => {
    if (new URL(origin).origin === consoleOrigin()) throw new Error("不能删除当前连接的电脑。");
    await mutate("DELETE", { origin });
  }, [mutate]);
  const add = useCallback((origin: string, name: string) => mutate("POST", { computers: validateComputerConnections([{ origin, name }]), restore: true }), [mutate]);
  return { computers, loaded, saving, error, reload, rename, remove, add };
}
