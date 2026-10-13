"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultComputerSettings, validateComputerTools, validateSavedComputerPages,
  type ComputerSettings, type ComputerToolId, type SavedComputerPage,
} from "../../../core/src/domain/web-console/computer-settings";
import { readComputers, saveComputers } from "../../public/pwa/computer-directory.js";

class SettingsRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function requestSettings(csrfToken: string, update?: Record<string, unknown>): Promise<ComputerSettings> {
  const response = await fetch("/api/web-console/computer-settings", {
    method: update ? "PATCH" : "GET", credentials: "same-origin", cache: "no-store",
    headers: update ? { "content-type": "application/json", "x-csrf-token": csrfToken } : undefined,
    body: update ? JSON.stringify(update) : undefined, signal: AbortSignal.timeout(15_000),
  }).catch(cause => {
    throw new Error(cause?.name === "TimeoutError" ? "电脑响应超时，请检查连接后重试。" : "无法连接当前电脑，请检查连接后重试。");
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new SettingsRequestError(body?.error?.message ?? "电脑配置保存失败，请检查连接后重试。", response.status);
  if (!body?.settings || !Number.isSafeInteger(body.settings.revision)) throw new Error("无法读取电脑配置，请重新加载。");
  return {
    ...body.settings,
    visibleTools: validateComputerTools(body.settings.visibleTools),
    savedPages: body.settings.savedPages === null ? null : validateSavedComputerPages(body.settings.savedPages),
  };
}

export function useComputerSettings(csrfToken: string) {
  const [settings, setSettings] = useState<ComputerSettings>(() => defaultComputerSettings(""));
  const current = useRef(settings);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const apply = useCallback((value: ComputerSettings) => {
    current.current = value;
    if (mounted.current) setSettings(value);
  }, []);

  const reload = useCallback(async () => {
    if (busy.current) return;
    const attempt = ++generation.current;
    setError(""); setNotice("");
    try {
      let value = await requestSettings(csrfToken);
      if (value.savedPages === null) {
        const legacyPages = readComputers().find(computer => computer.origin === location.origin)?.pages ?? [];
        try { value = await requestSettings(csrfToken, { expectedRevision: value.revision, initializePages: legacyPages }); }
        catch (cause) {
          if (!(cause instanceof SettingsRequestError) || cause.status !== 409) throw cause;
          value = await requestSettings(csrfToken);
          if (value.savedPages === null) throw new Error("电脑配置已更新，请重试旧页面导入。");
        }
      }
      if (!mounted.current || attempt !== generation.current) return;
      apply(value);
      setLoaded(true);
      // The DB owns initialized pages. Keep only not-yet-imported legacy pages in the directory.
      try {
        saveComputers(readComputers().map(computer => {
          if (computer.origin !== location.origin) return computer;
          const { pages: _legacy, ...connection } = computer;
          return { ...connection, pagesMigrated: true };
        }));
      } catch { /* DB initialization remains authoritative even if browser storage is unavailable. */ }
    } catch (cause) {
      if (mounted.current && attempt === generation.current) setError(cause instanceof Error ? cause.message : "无法读取电脑配置。");
    }
  }, [apply, csrfToken]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const focus = () => { void reload(); };
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; generation.current++; window.removeEventListener("focus", focus); };
  }, [reload]);

  const save = useCallback(async (update: { visibleTools?: ComputerToolId[]; savedPages?: SavedComputerPage[] }) => {
    if (!loaded || busy.current) throw new Error("配置尚未就绪，请稍后重试。");
    busy.current = true;
    generation.current++;
    setSaving(true); setError(""); setNotice("");
    const previous = current.current;
    if (update.visibleTools) apply({ ...previous, visibleTools: update.visibleTools });
    try {
      apply(await requestSettings(csrfToken, { ...update, expectedRevision: previous.revision }));
      if (mounted.current) setNotice("已保存到当前电脑");
    } catch (cause) {
      apply(previous);
      if (cause instanceof SettingsRequestError && cause.status === 409) {
        try { apply(await requestSettings(csrfToken)); } catch { /* Keep last confirmed values and expose the conflict. */ }
      }
      const message = cause instanceof Error ? cause.message : "电脑配置保存失败，请重试。";
      if (mounted.current) setError(message);
      throw new Error(message);
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [apply, csrfToken, loaded]);

  return {
    settings, loaded, saving, error, notice, reload,
    setVisibleTools: (tools: ComputerToolId[]) => save({ visibleTools: validateComputerTools(tools) }),
    setSavedPages: (pages: SavedComputerPage[]) => save({ savedPages: validateSavedComputerPages(pages) }),
  };
}

export type ComputerSettingsController = ReturnType<typeof useComputerSettings>;
