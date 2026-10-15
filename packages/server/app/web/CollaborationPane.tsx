"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, UsersRound } from "lucide-react";
import { readCollaborationContentReady } from "../../../core/src/domain/web-console/CollaborationTabBridge";
import FlowStudioLoading from "./FlowStudioLoading";
import { consoleFrameUrl } from "./console-environment";

/** Shell presentation: keep the shared loader visible until collaboration content is ready. */
export default function CollaborationPane({ groupId, title, onFrame, onLoad }: {
  groupId?: string;
  title: string;
  onFrame: (frame: HTMLIFrameElement | null) => void;
  onLoad: () => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const dashboard = groupId === undefined;

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (readCollaborationContentReady(event, window.location.origin, frame.current?.contentWindow ?? null, groupId ?? null))
        setState("ready");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [groupId]);

  useEffect(() => {
    if (state !== "loading") return;
    const timer = window.setTimeout(() => setState(current => current === "loading" ? "error" : current), 30000);
    return () => window.clearTimeout(timer);
  }, [state, attempt]);

  return <div className="collaboration-pane" aria-busy={state === "loading"}>
    <iframe
      key={attempt}
      ref={element => { frame.current = element; onFrame(element); }}
      className={`webapp-frame collaboration-frame${state === "ready" ? " is-ready" : ""}`}
      style={{ visibility: state === "ready" ? "visible" : "hidden" }}
      src={consoleFrameUrl(dashboard ? "/app/?view=collaboration-dashboard" : `/app/?view=collaboration&groupId=${encodeURIComponent(groupId)}`)}
      title={title}
      onLoad={onLoad}
      onError={() => setState("error")}
    />
    {state === "loading" && <FlowStudioLoading
      label="AGENT COLLABORATION"
      title={dashboard ? "正在打开群聊看板" : "正在进入群聊"}
      caption={dashboard ? "正在加载已保存的群聊" : "正在加载群成员与聊天记录"}
      icon={<UsersRound size={36} strokeWidth={1.5} />}
    />}
    {state === "error" && <div className="collaboration-load-error" role="alert">
      <strong>{dashboard ? "暂时无法打开群聊看板" : "暂时无法打开群聊"}</strong>
      <span>请检查连接后重试。</span>
      <button onClick={() => { setState("loading"); setAttempt(value => value + 1); }}><RefreshCw size={15}/>重新加载</button>
    </div>}
    <style jsx>{`
      .collaboration-pane { position:relative; height:100%; background:var(--ui-term-col-bg, #101014); }
      .collaboration-frame.is-ready { animation:collaboration-appear 220ms ease-out both; }
      .collaboration-load-error { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--ui-text, #e5e7eb); background:var(--ui-term-col-bg, #101014); padding:20px; text-align:center; }
      .collaboration-load-error span { font-size:13px; color:var(--ui-text-muted, #9399aa); }
      .collaboration-load-error button { display:inline-flex; align-items:center; gap:8px; margin-top:6px; min-height:44px; padding:10px 16px; border:1px solid var(--ui-muted-border, #ffffff24); border-radius:9px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
      .collaboration-load-error button:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
      @keyframes collaboration-appear { from { opacity:0; } to { opacity:1; } }
      @media (prefers-reduced-motion:reduce) { .collaboration-frame.is-ready { animation:none; } }
    `}</style>
  </div>;
}
