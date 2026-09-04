import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { HttpClient } from "./infrastructure/http/http-client";
import { AgentHttpGateway } from "./infrastructure/http/agent-http-gateway";
import { LocalSettingsRepository } from "./infrastructure/local/local-settings-repository";
import { installBrowserCryptoCompatibility } from "./infrastructure/browser-crypto";
import { installParentTabSwipeBridge } from "./presentation/parent-tab-swipe";
import { installWebShellSkinBridge } from "./presentation/web-shell-skin";
import { announceWebappReady } from "./presentation/webapp-ready";
// The desktop renderer's design-token sheet — the Electron entry imports it
// via its own main.tsx; without it every var(--…) in the shared UI is void.
import "@desktop/renderer/styles/global.css";
import "@desktop/renderer/styles/composer.css";
import "./presentation/web.css";
import type { AgentApi } from "../../desktop/renderer/global";
import { WebShellProjectBridge } from "./infrastructure/web-shell-project-bridge";

/**
 * Composition root: wire infrastructure adapters to the AgentApi port and
 * mount the shared desktop renderer UI. No login gate — the shell talks to
 * the server's open LAN APIs (same posture as the SDK preview).
 * Order matters — window.agentApi must exist before App evaluates.
 */
installBrowserCryptoCompatibility();
installParentTabSwipeBridge();
installWebShellSkinBridge();
document.body.dataset.webShell = "1";

const http = new HttpClient();
const projectBridge = window.parent === window ? undefined : new WebShellProjectBridge();
const gateway = new AgentHttpGateway(http, new LocalSettingsRepository(), projectBridge);

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
const root = createRoot(container);

function WebappReadySignal() {
  useEffect(() => {
    announceWebappReady();
  }, []);
  return null;
}

void (async () => {
  window.agentApi = gateway as unknown as AgentApi;
  await gateway.refreshServerModel();
  const { default: App } = await import("@desktop/renderer/App");
  root.render(
    <StrictMode>
      <App />
      <WebappReadySignal />
    </StrictMode>,
  );
  startBuildWatchdog();
})();

/**
 * Stale-tab self-heal: a page left open across rebuilds keeps running old
 * code forever (and old builds may even freeze). Poll the server's build id
 * once a minute; force-reload when a newer build has been deployed.
 */
function startBuildWatchdog(): void {
  const ownMatch = [...document.scripts]
    .map((s) => s.src)
    .join(",")
    .match(/index-([^/]+)\.js/);
  const own = ownMatch ? ownMatch[1] : null;
  if (!own) return;
  setInterval(async () => {
    try {
      const res = await fetch("/api/agent/model", { credentials: "same-origin" });
      const info = (await res.json()) as { buildId?: string };
      const server = (info.buildId || "").replace(/^index-|\.js$/g, "");
      if (server && server !== own) location.reload();
    } catch { /* offline — retry next tick */ }
  }, 60000);
}
