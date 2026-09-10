import { BrowserControlGate, guardedObject } from "./browser-control-gate.mjs";
import { BrowserLiveProducerClient } from "./browser-live-producer-client.mjs";
import { BrowserLiveProducer } from "./browser-live-producer.mjs";
import { EgoScreencastAdapter } from "./cdp-screencast-adapter.mjs";

function viewportFromPageInfo(info) {
  const width = Math.round(Number(info?.w));
  const height = Math.round(Number(info?.h));
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    const error = new Error("ego-browser did not return a usable browser viewport");
    error.code = "BROWSER_LIVE_VIEWPORT_UNAVAILABLE";
    throw error;
  }
  return { width, height, deviceScaleFactor: 1 };
}

function safeErrorHandler(onError, error) {
  try { onError(error); } catch {}
}

/** Starts a live producer inside an ego-browser `nodejs` invocation. */
export async function startEgoBrowserLive({
  cdp,
  subscribe,
  pageInfo,
  agentControls = {},
  endpoint = "http://127.0.0.1:3000",
  agentSessionId = "ego-browser",
  taskSpaceId,
  tabId = "active",
  fps = 5,
  onError = () => undefined,
  client = new BrowserLiveProducerClient({ endpoint }),
} = {}) {
  if (typeof cdp !== "function" || typeof subscribe !== "function" || typeof pageInfo !== "function") {
    throw new Error("startEgoBrowserLive requires ego-browser cdp, pageInfo, and screencast subscribe helpers");
  }
  const rawSessionId = `${agentSessionId}:ego:${taskSpaceId ?? "task"}:${tabId}`;
  const pageState = async () => {
    const info = await pageInfo();
    return { ...viewportFromPageInfo(info), title: info.title || "ego-browser", url: info.url || "" };
  };
  const initial = await pageState();
  const screencast = new EgoScreencastAdapter({
    send: (method, params) => cdp(method, params),
    subscribe,
    pageState,
    fps,
  });
  const gate = new BrowserControlGate();
  let lastResync = null;
  const producer = new BrowserLiveProducer({
    client,
    screencast,
    metadata: {
      sessionId: rawSessionId.slice(0, 120),
      browserSessionId: `ego:${taskSpaceId ?? "task"}:${tabId}`,
      agentSessionId,
      backend: "ego-browser",
      title: initial.title,
      url: initial.url,
      viewport: initial,
    },
    pauseAgent: async () => gate.pause(),
    resyncAgent: async () => {
      lastResync = await pageState();
      gate.resume();
    },
    onError,
  });
  const completion = producer.run();
  completion.catch((error) => safeErrorHandler(onError, error));
  let closed = false;
  return {
    id: producer.metadata.sessionId,
    helpers: guardedObject(agentControls, gate),
    completion,
    get lastResync() { return lastResync; },
    async close() {
      if (closed) return;
      closed = true;
      gate.resume();
      await screencast.stop();
      await client.close(producer.metadata.sessionId).catch(() => client.disconnect());
    },
  };
}

export { viewportFromPageInfo };
