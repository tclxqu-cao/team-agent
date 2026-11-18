import { isAgentType } from "../../../core/src/domain/agent/agent-type";
import type { AgentType } from "../global";

export interface NewSessionWindowOptions {
  agentType: AgentType;
  workspacePath?: string;
}

export function readNewSessionWindow(search: string): NewSessionWindowOptions | null {
  const query = new URLSearchParams(search);
  if (query.get("newSessionWindow") !== "1") return null;
  const agent = query.get("agent");
  return { agentType: isAgentType(agent) ? agent : "customer-agent", workspacePath: query.get("cwd") || undefined };
}

export function newSessionWindowUrl(href: string, options: NewSessionWindowOptions): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("newSessionWindow", "1");
  url.searchParams.set("agent", options.agentType);
  if (options.workspacePath) url.searchParams.set("cwd", options.workspacePath);
  return url.href;
}

/** Open synchronously from the click so browsers can allow the popup. */
export async function openNewSessionWindow(options: NewSessionWindowOptions): Promise<void> {
  if (window.agentApi?.openNewSessionWindow) {
    await window.agentApi.openNewSessionWindow(options);
    return;
  }
  const popup = window.open(newSessionWindowUrl(window.location.href, options), "_blank",
    "popup=yes,width=680,height=480,resizable=yes,scrollbars=yes");
  if (!popup) throw new Error("新会话窗口被浏览器拦截，请允许弹出窗口后重试");
  popup.opener = null;
  popup.focus();
}
