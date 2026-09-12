import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { HttpClient } from "./infrastructure/http/http-client";
import { AgentHttpGateway } from "./infrastructure/http/agent-http-gateway";
import { LocalSettingsRepository } from "./infrastructure/local/local-settings-repository";
import { installBrowserCryptoCompatibility } from "./infrastructure/browser-crypto";
import { installParentTabSwipeBridge } from "./presentation/parent-tab-swipe";
import { installWebShellSkinBridge } from "./presentation/web-shell-skin";
import { installWebShellLiveBridge } from "./presentation/web-shell-live";
import { announceWebappReady } from "./presentation/webapp-ready";
// The desktop renderer's design-token sheet — the Electron entry imports it
// via its own main.tsx; without it every var(--…) in the shared UI is void.
import "@desktop/renderer/styles/global.css";
import "@desktop/renderer/styles/composer.css";
import "./presentation/web.css";
import type { AgentApi } from "../../desktop/renderer/global";
import { WebShellProjectBridge } from "./infrastructure/web-shell-project-bridge";
import { WebShellBrowserBridge } from "./infrastructure/web-shell-browser-bridge";
import { MobileConnectionService } from "./mobile/domain/connection-service";
import { ServerEndpoint } from "./mobile/domain/server-endpoint";
import { CapacitorNativeEnvironment } from "./mobile/infrastructure/capacitor-native-environment";
import { LocalEndpointStorage } from "./mobile/infrastructure/local-endpoint-storage";
import { HttpConnectivityProbe } from "./mobile/infrastructure/http-connectivity-probe";
import { ConnectionScreen } from "./mobile/presentation/connection-screen";

/**
 * Composition root: wire infrastructure adapters to the AgentApi port and
 * mount the shared desktop renderer UI. No login gate — the shell talks to
 * the server's open LAN APIs (same posture as the SDK preview).
 * Order matters — window.agentApi must exist before App evaluates.
 */
installBrowserCryptoCompatibility();
installParentTabSwipeBridge();
installWebShellSkinBridge();
installWebShellLiveBridge();
document.body.dataset.webShell = "1";

const http = new HttpClient();
const projectBridge = window.parent === window ? undefined : new WebShellProjectBridge();
const browserBridge = window.parent === window ? undefined : new WebShellBrowserBridge();
// SSE 也要指向远端服务器：基址在 boot() 里按连接方案填充（web 模式保持空）。
let sseBase = "";
const gateway = new AgentHttpGateway(
  http,
  new LocalSettingsRepository(),
  projectBridge,
  (url) => new EventSource(sseBase + url),
);
window.browserLiveApi = browserBridge;

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
  // 移动端「服务器连接」上下文：浏览器走同源，原生壳必须解析出远端基址。
  const connection = new MobileConnectionService(
    new CapacitorNativeEnvironment(),
    new LocalEndpointStorage(),
    new HttpConnectivityProbe(),
  );
  const plan = await connection.planStartup();
  if (plan.mode === "setup") {
    root.render(
      <ConnectionScreen
        service={connection}
        savedEndpoint={plan.endpoint}
        initialFailure={plan.failure}
        onConnected={(endpoint) => void boot(endpoint)}
      />,
    );
    return;
  }
  await boot(plan.mode === "ready" ? plan.endpoint : null);
})();

async function boot(endpoint: ServerEndpoint | null): Promise<void> {
  try {
    if (endpoint) {
      http.setBaseUrl(endpoint.url);
      sseBase = endpoint.url;
    }
    window.agentApi = gateway as unknown as AgentApi;
    await gateway.refreshServerModel();
    const { default: App } = await import("@desktop/renderer/App");
    root.render(
      <StrictMode>
        <App />
        <WebappReadySignal />
      </StrictMode>,
    );
    // 构建看门狗轮询相对路径的 /api/agent/model，只在同源 web 模式有意义；
    // 原生壳是打包进 App 的静态资源，没有"换构建要自愈"的问题。
    if (!endpoint) startBuildWatchdog();
  } catch (error) {
    // 原生壳里启动失败绝不能静默白屏：把错误直接画到屏幕上，用户才能反馈。
    root.render(
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#f5f6fa", boxSizing: "border-box" }}>
        <div style={{ maxWidth: 560, background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 16, color: "#dc2626" }}>界面启动失败</h2>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#374151", wordBreak: "break-all" }}>
            {error instanceof Error ? `${error.name}: ${error.message}` : String(error)}
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{ padding: "8px 20px", fontSize: 14, borderRadius: 8, border: "1px solid #d6d9e0", background: "#fff", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </div>,
    );
  }
}

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
      const res = await fetch("/api/agent/model", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const info = (await res.json()) as { buildId?: string };
      const server = (info.buildId || "").replace(/^index-|\.js$/g, "");
      if (server && server !== own) location.reload();
    } catch { /* offline — retry next tick */ }
  }, 60000);
}
