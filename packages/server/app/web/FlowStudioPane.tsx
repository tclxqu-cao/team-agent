"use client";

import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";

type PaneState = "loading" | "ready" | "error";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveFlowStudioFrameUrl(configuredUrl: string, pageUrl: string): string {
  const entry = new URL(configuredUrl);
  const page = new URL(pageUrl);
  if (LOOPBACK_HOSTS.has(entry.hostname) && entry.hostname !== page.hostname) {
    entry.hostname = page.hostname;
  }
  return entry.toString();
}

export default function FlowStudioPane({ visible }: { visible: boolean }) {
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [state, setState] = useState<PaneState>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible || entryUrl) return;
    let cancelled = false;
    setState("loading");

    void fetch("/api/flow-studio/config", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Flow Studio config request failed");
        const body = await response.json() as { entryUrl?: string | null };
        if (!body.entryUrl) throw new Error("Flow Studio entry is not configured");
        const parsed = new URL(body.entryUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Flow Studio entry URL is invalid");
        }
        if (!cancelled) setEntryUrl(resolveFlowStudioFrameUrl(parsed.toString(), window.location.href));
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => { cancelled = true; };
  }, [attempt, entryUrl, visible]);

  useEffect(() => {
    if (!entryUrl || state !== "loading") return;
    const timer = window.setTimeout(() => setState("error"), 30000);
    return () => window.clearTimeout(timer);
  }, [entryUrl, state]);

  const retry = () => {
    setEntryUrl(null);
    setState("loading");
    setAttempt((value) => value + 1);
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--ui-term-col-bg, #101014)" }} aria-busy={state === "loading"}>
      {entryUrl && (
        <iframe
          key={entryUrl}
          src={entryUrl}
          title="Flow Studio 数字人"
          referrerPolicy="no-referrer"
          allow="camera; microphone; autoplay; clipboard-read; clipboard-write; fullscreen"
          allowFullScreen
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          style={{ display: "block", width: "100%", height: "100%", border: 0, background: "var(--ui-term-col-bg, #101014)" }}
        />
      )}
      {state !== "ready" && (
        <div
          role={state === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ui-text, #e5e7eb)", background: "var(--ui-term-col-bg, #101014)" }}
        >
          <strong>{state === "error" ? "无法打开 Flow Studio" : "正在打开 Flow Studio"}</strong>
          {state === "error" && (
            <button
              type="button"
              aria-label="重试加载 Flow Studio"
              onClick={retry}
              title="重新加载 Flow Studio"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, width: "auto", height: 32, padding: "0 10px", border: "1px solid var(--ui-muted-border, #3b3d46)", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer" }}
            >
              <RotateCw size={16} aria-hidden="true" />
              <span>重试</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
