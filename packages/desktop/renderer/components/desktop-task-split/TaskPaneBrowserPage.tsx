import { ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  paneId: string;
  url: string;
  visible?: boolean;
  onFocus?: () => void;
}

export function taskPaneBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

export function taskPaneBrowserSandbox(value: string, hostOrigin?: string): string {
  const permissions = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
  const target = taskPaneBrowserUrl(value);
  // Cross-origin sites retain their own login/storage origin. App-origin pages
  // stay opaque so script cannot remove the sandbox through its parent document.
  return target && hostOrigin && hostOrigin !== "null" && new URL(target).origin !== hostOrigin
    ? `${permissions} allow-same-origin` : permissions;
}

/** Browser framing stays subject to the destination's embedding and login policies. */
export default function TaskPaneBrowserPage({ paneId, url, visible = true, onFocus }: Props) {
  const target = taskPaneBrowserUrl(url);
  const sandbox = taskPaneBrowserSandbox(url, typeof window === "undefined" ? undefined : window.location.origin);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "waiting" | "error">("loading");
  useEffect(() => {
    setState("loading");
    const timeout = window.setTimeout(() => setState(current => current === "loading" ? "waiting" : current), 15_000);
    return () => window.clearTimeout(timeout);
  }, [url, attempt]);
  const retry = () => setAttempt(value => value + 1);

  return <div className="task-pane-web-page task-pane-web-page--browser" aria-label="网页" aria-hidden={!visible} style={{ visibility: visible ? undefined : "hidden" }}
    onFocusCapture={onFocus} onPointerDownCapture={onFocus}>
    <div className="task-pane-web-address">
      <span title={url}>{url}</span>
      <button type="button" className="ui-icon-button" aria-label="刷新网页" title="刷新网页" disabled={!target} onClick={retry}><RotateCw size={14} /></button>
      {target && <a className="ui-icon-button" href={target} target="_blank" rel="noopener noreferrer" aria-label="在新标签页打开" title="在新标签页打开"><ExternalLink size={14} /></a>}
    </div>
    <div className="task-pane-web-embedding-note">若网站限制内嵌或页面无法登录，请在新标签页打开。</div>
    <div className="task-pane-web-content" aria-busy={Boolean(target && state === "loading")}>
      {target && <iframe key={`${paneId}:${url}:${attempt}`} className="task-pane-web-frame" src={target} title={`网页：${url}`}
        sandbox={sandbox} referrerPolicy="no-referrer"
        onLoad={() => setState("loaded")} onError={() => setState("error")} />}
      {(!target || state === "error") && <div className="task-pane-web-status" role="alert">
        <span>{target ? "网页未能载入，请重试或在新标签页打开。" : "只能预览 HTTP 或 HTTPS 网页。"}</span>
        {target && <button type="button" onClick={retry}>重试</button>}
      </div>}
      {target && state === "loading" && <div className="task-pane-web-status task-pane-web-status--loading" role="status"><LoaderCircle className="task-split-spinner" size={20} /><span>正在载入网页…</span></div>}
      {target && state === "waiting" && <div className="task-pane-web-waiting" role="status"><span>网页仍在载入，可继续等待或重试。</span><button type="button" onClick={retry}>重试</button></div>}
    </div>
  </div>;
}
