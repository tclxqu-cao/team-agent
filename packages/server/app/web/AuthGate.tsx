"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { useWebAuth } from "./useWebAuth";

export type WebAuthController = ReturnType<typeof useWebAuth>;

export function connectionElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

interface AuthGateProps {
  children: (auth: WebAuthController, onWorkspaceReady: () => void) => ReactNode;
}

/** Keep one boot surface mounted across gateway auth and WebApp hydration. */
export default function AuthGate({ children }: AuthGateProps) {
  const auth = useWebAuth();
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const authenticated = auth.status === "authenticated";
  const ready = authenticated && workspaceReady;
  const markWorkspaceReady = useCallback(() => setWorkspaceReady(true), []);

  useEffect(() => {
    if (!authenticated) setWorkspaceReady(false);
  }, [authenticated]);

  useEffect(() => {
    if (ready || auth.error) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [auth.error, ready]);

  const detail = auth.error || "数字人核心正在就绪";

  return (
    <>
      {authenticated ? children(auth, markWorkspaceReady) : null}
      <main
        className={`neural-boot${ready ? " is-ready" : ""}${auth.error ? " is-error" : ""}`}
        role={auth.error ? "alert" : "status"}
        aria-live="polite"
        aria-busy={!ready && !auth.error}
        aria-hidden={ready}
      >
        <div className="neural-grid" aria-hidden="true" />
        <div className="neural-rail neural-rail-left" aria-hidden="true" />
        <div className="neural-rail neural-rail-right" aria-hidden="true" />

        <section className="neural-content">
          <div className="neural-brand" aria-hidden="true">
            <span className="neural-brand-signal" />
            <span>AgentRoam</span>
            <small>NEURAL LINK</small>
          </div>

          <div className="neural-portrait" aria-hidden="true">
            <span className="neural-ring neural-ring-outer" />
            <span className="neural-ring neural-ring-inner" />
            <span className="neural-axis neural-axis-x" />
            <span className="neural-axis neural-axis-y" />
            <span className="neural-node neural-node-one" />
            <span className="neural-node neural-node-two" />
            <span className="neural-node neural-node-three" />
            <span className="neural-node neural-node-four" />
            <div className="neural-avatar-frame">
              <div className="neural-avatar">
                <Bot className="neural-avatar-icon" size={66} strokeWidth={1.3} />
                <span className="neural-visor" />
              </div>
            </div>
          </div>

          <div className="neural-copy">
            <strong>正在唤醒工作区</strong>
            <span>{detail}</span>
          </div>

          <div className="neural-progress" aria-hidden="true"><span /></div>
          <div className="neural-meta" aria-hidden="true">
            <span>AGENT CORE</span>
            <span className="neural-meta-time">
              T+{connectionElapsedSeconds(startedAt, now).toString().padStart(2, "0")}S
            </span>
          </div>

          {auth.error && (
            <button
              type="button"
              className="neural-retry"
              aria-label="重试连接"
              title="重试连接"
              onClick={() => void auth.refresh()}
            >
              <RefreshCw size={18} aria-hidden="true" />
            </button>
          )}
        </section>

      </main>
    </>
  );
}
