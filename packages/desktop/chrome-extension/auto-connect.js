import { siteForUrl } from "./bridge-client.js";

export const DISCOVERY_ALARM = "aihub-auto-connect";
const PROVIDER_URLS = ["https://chatgpt.com/*", "https://gemini.google.com/*", "https://grok.com/*"];

export class AutoConnect {
  constructor(api, bridge, loadBootstrap) {
    this.api = api; this.bridge = bridge; this.loadBootstrap = loadBootstrap;
    this.paused = true; this.error = ""; this.initialized = false;
    this.running = null; this.pending = false; this.connecting = null;
    bridge.onReady = () => { this.publishStatus(); void this.discover(); };
    bridge.onUserDetach = () => { void this.setPaused(true); };
    bridge.onResume = () => this.setPaused(false);
    api.tabs.onUpdated.addListener((_id, change) => {
      if (change.status === "complete" || change.url) void this.tick();
    });
    api.tabs.onRemoved.addListener(() => { void this.discover(); });
    api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === DISCOVERY_ALARM) void this.tick(); });
  }

  async start() {
    const saved = await this.api.storage.local.get("autoConnectPaused");
    this.paused = saved.autoConnectPaused === true;
    this.initialized = true;
    await this.api.alarms.create(DISCOVERY_ALARM, { periodInMinutes: 0.5 });
    await this.tick();
  }

  status() { return { ...this.bridge.status(), paused: this.paused, error: this.error }; }
  publishStatus() { this.bridge.send({ type: "auto-connect-status", paused: this.paused }); }

  async setPaused(paused) {
    this.paused = paused;
    this.publishStatus();
    await this.api.storage.local.set({ autoConnectPaused: paused });
    // Keep the authenticated local channel alive so the desktop can explain and resume a pause.
    if (paused) await Promise.all([...this.bridge.tabs.keys()].map((site) => this.bridge.detach(site)));
    else await this.tick();
    return this.status();
  }

  async tick() {
    if (!this.initialized) return;
    if (!this.bridge.ready) {
      if (!this.connecting) {
        this.connecting = (async () => {
          try {
            const pairing = await this.loadBootstrap();
            if (!Number.isInteger(pairing.port) || pairing.port < 1 || pairing.port > 65535 || !/^[a-f0-9]{64}$/.test(pairing.token)) throw new Error("invalid-bootstrap");
            await this.bridge.connect(pairing);
            this.error = "";
          } catch (error) {
            this.error = error.message === "bootstrap-unavailable" || error.message === "invalid-bootstrap"
              ? "请从桌面端「连接 Chrome」打开本机扩展文件夹，重新加载扩展"
              : "等待桌面端启动，将自动重连";
          }
        })().finally(() => { this.connecting = null; });
      }
      await this.connecting;
    }
    await this.discover();
  }

  async discover() {
    if (this.paused || !this.bridge.ready) return;
    if (this.running) { this.pending = true; return this.running; }
    this.running = (async () => {
      do {
        this.pending = false;
        const tabs = await this.api.tabs.query({ url: PROVIDER_URLS });
        // Keep a connected conversation stable; only choose a tab for missing providers.
        tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || a.id - b.id);
        for (const tab of tabs) {
          if (this.paused || !this.bridge.ready) break;
          const siteId = siteForUrl(tab.url);
          if (!siteId || !Number.isInteger(tab.id) || tab.status === "loading" || this.bridge.tabs.has(siteId)) continue;
          try {
            await this.bridge.attach(tab.id);
            if (this.paused) await this.bridge.detach(siteId);
          } catch { /* Login/loading/debugger conflicts are retried on a later event or alarm. */ }
        }
      } while (this.pending && !this.paused && this.bridge.ready);
    })().catch(() => { this.error = "暂时无法发现标签页，将自动重试"; })
      .finally(() => { this.running = null; });
    return this.running;
  }
}
