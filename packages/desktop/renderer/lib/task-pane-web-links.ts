import { isWebShell } from "../web/webLayout";

export const TASK_PANE_WEB_LINK_EVENT = "agentroam:task-pane-web-link";

export interface TaskPaneWebLinkRequest {
  url: string;
}

/** An empty desktop pane can claim a link; every other surface keeps native navigation. */
export function requestTaskPaneWebLink(raw: string): boolean {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function"
    || (!isWebShell() && typeof window.agentApi?.taskPageOpen !== "function")) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !window.dispatchEvent(new CustomEvent<TaskPaneWebLinkRequest>(TASK_PANE_WEB_LINK_EVENT, {
    cancelable: true, detail: { url: url.toString() },
  }));
}

export function isPlainWebLinkClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

