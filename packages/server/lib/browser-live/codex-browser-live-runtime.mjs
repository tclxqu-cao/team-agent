import { BrowserLiveProducerClient } from "./browser-live-producer-client.mjs";
import { BrowserLiveProducer } from "./browser-live-producer.mjs";
import { CdpScreencastAdapter } from "./cdp-screencast-adapter.mjs";
import { BrowserControlGate, guardedObject } from "./browser-control-gate.mjs";

const INSTALLATION = Symbol.for("agentroam.browser-live.codex.installation");

function viewportFromLayoutMetrics(metrics) {
  const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
  const width = Math.round(Number(viewport?.clientWidth ?? viewport?.width));
  const height = Math.round(Number(viewport?.clientHeight ?? viewport?.height));
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    const error = new Error("CDP did not return a usable browser viewport");
    error.code = "BROWSER_LIVE_VIEWPORT_UNAVAILABLE";
    throw error;
  }
  return { width, height, deviceScaleFactor: 1 };
}

function liveSessionId(agentSessionId, browserId, tabId) {
  return `${agentSessionId}:${browserId}:${tabId}`.slice(0, 120);
}

async function inferAgentSessionId(cua, browserId) {
  const state = await cua.getState();
  const browser = state?.browsers?.find((candidate) => candidate.id === browserId);
  return browser?.metadata?.codexSessionId || "codex-browser";
}

async function createSession({ cua, tab, browserId, endpoint, agentSessionId, fps, onError }) {
  const cdp = await tab.capabilities.get("cdp");
  const resolvedAgentSessionId = agentSessionId || await inferAgentSessionId(cua, browserId);
  const pageState = async () => {
    const [metrics, title, url] = await Promise.all([
      cdp.send("Page.getLayoutMetrics"),
      tab.title(),
      tab.url(),
    ]);
    return { ...viewportFromLayoutMetrics(metrics), title, url };
  };
  const initial = await pageState();
  const gate = new BrowserControlGate();
  let lastResync = null;
  const client = new BrowserLiveProducerClient({ endpoint });
  const screencast = new CdpScreencastAdapter({
    send: (method, params) => cdp.send(method, params),
    readEvents: (options) => cdp.readEvents(options),
    pageState,
    fps,
  });
  const producer = new BrowserLiveProducer({
    client,
    screencast,
    metadata: {
      sessionId: liveSessionId(resolvedAgentSessionId, browserId, tab.id),
      browserSessionId: `${browserId}:${tab.id}`,
      agentSessionId: resolvedAgentSessionId,
      backend: "codex-browser",
      title: initial.title,
      url: initial.url,
      viewport: initial,
    },
    pauseAgent: async () => gate.pause(),
    resyncAgent: async () => {
      if (typeof tab.getAXState === "function") {
        lastResync = await tab.getAXState({ disableDiffing: true, emit: false });
      } else {
        lastResync = await pageState();
      }
      gate.resume();
    },
    onError,
  });
  const completion = producer.run();
  completion.catch((error) => {
    try { onError(error); } catch {}
  });
  return {
    id: producer.metadata.sessionId,
    tab: guardedObject(tab, gate),
    completion,
    get lastResync() { return lastResync; },
    async close() {
      gate.resume();
      await screencast.stop();
      await client.close(producer.metadata.sessionId).catch(() => client.disconnect());
    },
  };
}

/** Installs a one-time live relay around Codex CUA tab acquisition. */
export async function installCodexBrowserLive({
  cua,
  endpoint = "http://127.0.0.1:3000",
  agentSessionId,
  fps = 5,
  onError = () => undefined,
} = {}) {
  if (!cua || typeof cua.createBrowserTab !== "function" || typeof cua.getTab !== "function") {
    throw new Error("installCodexBrowserLive requires the initialized Codex CUA API");
  }
  if (cua[INSTALLATION]) return cua[INSTALLATION];

  const sessions = new Map();
  const originalCreateBrowserTab = cua.createBrowserTab.bind(cua);
  const originalGetTab = cua.getTab.bind(cua);
  const attach = async (tab, browserId) => {
    const key = `${browserId}:${tab.id}`;
    const existing = sessions.get(key);
    if (existing) return existing.tab;
    const session = await createSession({ cua, tab, browserId, endpoint, agentSessionId, fps, onError });
    sessions.set(key, session);
    session.completion.finally(() => sessions.delete(key)).catch(() => undefined);
    return session.tab;
  };

  cua.createBrowserTab = async (browserId, ...args) => attach(
    await originalCreateBrowserTab(browserId, ...args),
    browserId,
  );
  cua.getTab = async (tabId, options = {}) => {
    const browserId = options.browser || "iab";
    return attach(await originalGetTab(tabId, options), browserId);
  };

  const installation = {
    sessions,
    async dispose() {
      cua.createBrowserTab = originalCreateBrowserTab;
      cua.getTab = originalGetTab;
      await Promise.allSettled([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      delete cua[INSTALLATION];
    },
  };
  cua[INSTALLATION] = installation;
  return installation;
}

export { BrowserControlGate, guardedObject, viewportFromLayoutMetrics };
