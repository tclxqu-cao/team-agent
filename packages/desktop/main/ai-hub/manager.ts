import { createRequire } from "node:module";
import type { BrowserWindow, WebContentsView } from "electron";import { CONVERSATION_EXTRACT_SCRIPT, ENTER_DISPATCH_SCRIPT, buildAdapterScript } from "./adapters.js";
import { HubConfigStore, normalizeHubConfig, type HubConfig } from "./config.js";

const require = createRequire(import.meta.url);
// Load electron via createRequire (CJS) — see main/index.ts for the ESM crash rationale.
// WebContentsView is accessed off the namespace to avoid clashing with the type import.
const electron = require("electron") as typeof import("electron");
const { clipboard, nativeImage } = electron;

// 声明的 Chrome 版本：内核已是 Electron 44（Chromium 140+），直接用真实版本号，
// 与引擎特征天然一致；保留常量以便未来再次调整
const CLAIMED_CHROME_VERSION = process.versions.chrome;

// 标准 Chrome 浏览器 UA，供 AI Hub 站点视图使用：
// Google 登录会拒绝非标准 UA / Chromium 环境（"此浏览器或应用可能不安全"）
function buildChromeUserAgent(): string {
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CLAIMED_CHROME_VERSION} Safari/537.36`;
}

// Chrome 客户端提示（Sec-CH-UA）头与 UA 必须同源一致：Electron 只报 "Chromium" 品牌，
// 与伪装的 Chrome UA 对不上时 Google 登录同样拒绝
function chromeClientHints(): { brands: string; fullVersionBrands: string; platform: string } {
  const chromeVersion = CLAIMED_CHROME_VERSION;
  const major = chromeVersion.split(".")[0] ?? "140";
  const brands = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="99"`;
  const fullVersionBrands = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not_A Brand";v="99"`;
  const platform = process.platform === "win32" ? '"Windows"' : process.platform === "darwin" ? '"macOS"' : '"Linux"';
  return { brands, fullVersionBrands, platform };
}

// 页面内 navigator.userAgentData 同步为 Chrome 品牌（best effort），
// 避免 Google 登录脚本读到 Chromium 品牌后判定环境异常
function buildUserAgentDataShim(): string {
  const { platform } = chromeClientHints();
  const major = CLAIMED_CHROME_VERSION.split(".")[0] ?? "140";
  const platformName = platform === '"Windows"' ? "Windows" : platform === '"macOS"' ? "macOS" : "Linux";
  const platformVersion = (process.platform === "darwin" ? process.getSystemVersion?.() : null) || "10.0.0";
  return `(function(){
    try {
      var brandList = [{brand:"Google Chrome",version:"${major}"},{brand:"Chromium",version:"${major}"},{brand:"Not_A Brand",version:"99"}];
      var shim = {
        brands: brandList, mobile: false, platform: "${platformName}",
        toJSON: function(){ return { brands: brandList, mobile: false, platform: this.platform }; },
        getHighEntropyValues: function(){ return Promise.resolve({ architecture:"${process.arch === "arm64" ? "arm" : "x86"}", bitness:"64", model:"", platform:this.platform, platformVersion:"${platformVersion}", uaFullVersion:"${CLAIMED_CHROME_VERSION}", fullVersionList: brandList }); }
      };
      // 真实 Chrome 的 userAgentData 挂在 Navigator.prototype 上；
      // 实例自有属性会被 Object.getOwnPropertyDescriptor 探测出篡改痕迹
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: function(){ return shim; },
        set: function(){},
        configurable: true,
        enumerable: true
      });
    } catch (e) {}
  })();`;
}

export interface HubPaneRect {
  siteId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HubEvent {
  type: "loading" | "loaded" | "load-failed" | "title";
  siteId: string;
  errorCode?: number;
  title?: string;
}

export interface HubBroadcastResult {
  siteId: string;
  ok: boolean;
  reason?: string;
}

export interface HubCaptureResult {
  siteId: string;
  ok: boolean;
  reason?: string;
  strategy?: string;
  messages?: Array<{ role: string; text: string }>;
  debug?: Record<string, unknown>;
}

interface AIHubManagerDeps {
  configPath: string;
  getWindow: () => BrowserWindow | null;
}

interface PoolEntry {
  view: WebContentsView;
  attached: boolean;
  loaded: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 主进程视图池：每站点一个 WebContentsView，惰性创建，隐藏只 detach 不销毁，
// 保留页面状态与登录态。可见性完全由 setBounds 驱动（列表内 attach，列表外 detach）。
export class AIHubManager {
  private readonly store: HubConfigStore;
  private readonly getWindow: () => BrowserWindow | null;
  private readonly pool = new Map<string, PoolEntry>();
  private config: HubConfig;
  private readonly listeners = new Set<(event: HubEvent) => void>();

  constructor(deps: AIHubManagerDeps) {
    this.store = new HubConfigStore(deps.configPath);
    this.getWindow = deps.getWindow;
    const loaded = this.store.loadSync();
    this.config = loaded.config;
    if (loaded.resetFromCorruption) {
      console.warn("[ai-hub] config was corrupted; backed up and reset to defaults");
    }
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HubEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getConfig(): HubConfig {
    return this.config;
  }

  setConfig(raw: unknown): HubConfig {
    this.config = normalizeHubConfig(raw);
    this.store.saveSync(this.config);
    const validIds = new Set(this.config.sites.map((site) => site.id));
    for (const [siteId, entry] of this.pool) {
      if (!validIds.has(siteId)) this.destroyEntry(siteId, entry);
    }
    return this.config;
  }

  // 打开站点：确保视图存在且已加载；显示交给后续 setBounds 推送。
  async openSite(siteId: string): Promise<void> {
    const site = this.config.sites.find((candidate) => candidate.id === siteId);
    if (!site) return;
    const entry = this.ensureView(site.id, site.url);
    if (!entry.loaded) {
      entry.loaded = true;
      try {
        await entry.view.webContents.loadURL(site.url);
      } catch (error) {
        // did-fail-load 事件已回推渲染层；这里吞掉 loadURL 的 reject（导航被取消等）
        entry.loaded = false;
        console.warn("[ai-hub] loadURL failed:", siteId, error);
      }
    }
  }

  // 关闭并销毁站点视图（侧边栏“关闭页面”；登录态在 persist 分区中保留）
  closeSite(siteId: string): void {
    const entry = this.pool.get(siteId);
    if (!entry) return;
    this.destroyEntry(siteId, entry);
  }

  setBounds(panes: HubPaneRect[]): void {
    const window = this.getWindow();
    if (!window) return;
    const listed = new Set<string>();
    for (const pane of panes) {
      const entry = this.pool.get(pane.siteId);
      if (!entry) continue;
      listed.add(pane.siteId);
      const x = Math.round(pane.x);
      const y = Math.round(pane.y);
      const width = Math.round(pane.width);
      const height = Math.round(pane.height);
      if (width <= 0 || height <= 0) {
        this.detach(entry);
        continue;
      }
      if (!entry.attached) {
        window.contentView.addChildView(entry.view);
        entry.attached = true;
      }
      entry.view.setBounds({ x, y, width, height });
    }
    // 不在本次布局中的已 attach 视图 → detach（隐藏不销毁）
    for (const [siteId, entry] of this.pool) {
      if (entry.attached && !listed.has(siteId)) this.detach(entry);
    }
  }

  reloadSite(siteId: string): void {
    const entry = this.pool.get(siteId);
    if (!entry) return;
    entry.view.webContents.reload();
  }

  // 中继触发（web 控制台转发）：显示窗口、打开目标站点并平铺视图，再注入。
  // 不依赖渲染端的 AI Hub 界面是否打开 —— 主进程自己算格子矩形。
  async relayBroadcast(text: string, siteIds: string[], images: string[] = []): Promise<HubBroadcastResult[]> {
    const window = this.getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const opened: string[] = [];
    for (const siteId of siteIds) {
      if (!this.config.sites.some((site) => site.id === siteId)) continue;
      await this.openSite(siteId);
      opened.push(siteId);
    }
    if (window && opened.length > 0) {
      const content = window.getContentBounds();
      const paneWidth = Math.floor(content.width / opened.length);
      this.setBounds(opened.map((siteId, index) => ({
        siteId,
        x: index * paneWidth,
        y: 0,
        width: index === opened.length - 1 ? content.width - paneWidth * (opened.length - 1) : paneWidth,
        height: content.height,
      })));
    }
    // 等首轮布局/渲染稳定后再注入，否则输入框定位会拿到 0 尺寸视口
    await sleep(800);
    return this.broadcast(text, opened, images);
  }

  // 同步发送：纯文本走适配器优先；带图片或适配器失败走剪贴板粘贴回退；单站点失败不影响其他站点。
  async broadcast(text: string, siteIds: string[], images: string[] = []): Promise<HubBroadcastResult[]> {
    const results: HubBroadcastResult[] = [];
    for (const siteId of siteIds) {
      const site = this.config.sites.find((candidate) => candidate.id === siteId);
      const entry = this.pool.get(siteId);
      if (!site || !entry) {
        results.push({ siteId, ok: false, reason: "site-not-open" });
        continue;
      }
      if (images.length > 0) {
        try {
          await this.pasteImagesFallback(entry, text, images);
          results.push({ siteId, ok: true });
        } catch (fallbackError) {
          results.push({
            siteId,
            ok: false,
            reason: fallbackError instanceof Error ? fallbackError.message.slice(0, 120) : "image-paste-failed",
          });
          console.warn("[ai-hub] broadcast image paste failed:", siteId, fallbackError);
        }
        continue;
      }
      try {
        await entry.view.webContents.executeJavaScript(buildAdapterScript(site.adapter, text), true);
        results.push({ siteId, ok: true });
      } catch (adapterError) {
        try {
          await this.pasteFallback(entry, text);
          results.push({ siteId, ok: true });
        } catch (fallbackError) {
          results.push({
            siteId,
            ok: false,
            reason: adapterError instanceof Error ? adapterError.message.slice(0, 120) : "adapter-failed",
          });
          console.warn("[ai-hub] broadcast fallback failed:", siteId, fallbackError);
        }
      }
    }
    return results;
  }

  destroyAll(): void {
    for (const [siteId, entry] of this.pool) this.destroyEntry(siteId, entry);
  }

  // 会话抽取（web 控制台 capture 轮询）：只读已打开站点的 DOM，未打开的站点返回 site-not-open。
  async captureConversations(siteIds: string[]): Promise<HubCaptureResult[]> {
    const results: HubCaptureResult[] = [];
    for (const siteId of siteIds) {
      const entry = this.pool.get(siteId);
      if (!entry) {
        results.push({ siteId, ok: false, reason: "site-not-open" });
        continue;
      }
      try {
        const extract = await entry.view.webContents.executeJavaScript(CONVERSATION_EXTRACT_SCRIPT, true);
        results.push({
          siteId,
          ok: true,
          strategy: typeof extract?.strategy === "string" ? extract.strategy : "none",
          messages: Array.isArray(extract?.messages) ? extract.messages : [],
          debug: extract?.debug && typeof extract.debug === "object" ? extract.debug : undefined,
        });
      } catch (error) {
        results.push({
          siteId,
          ok: false,
          reason: error instanceof Error ? error.message.slice(0, 120) : "extract-failed",
        });
      }
    }
    return results;
  }

  private detach(entry: PoolEntry): void {
    if (!entry.attached) return;
    this.getWindow()?.contentView.removeChildView(entry.view);
    entry.attached = false;
  }

  private destroyEntry(siteId: string, entry: PoolEntry): void {
    this.detach(entry);
    this.pool.delete(siteId);
    try {
      entry.view.webContents.close();
    } catch {
      // 视图可能已随窗口销毁
    }
  }

  private ensureView(siteId: string, url: string): PoolEntry {
    const existing = this.pool.get(siteId);
    if (existing) return existing;
    const partition = `persist:aihub-${siteId}`;
    const view = new electron.WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: "user-gesture-required",
      },
    });
    view.setBackgroundColor("#ffffff");
    this.sanitizeUserAgent(view);
    this.hardenSession(view);
    this.wireEvents(siteId, view);
    const entry: PoolEntry = { view, attached: false, loaded: false };
    this.pool.set(siteId, entry);
    return entry;
  }

  // 整串替换为同版本 Chrome 的标准 UA：删 token 的混合 UA 仍带非标准产品名，
  // 且 Sec-CH-UA / userAgentData 暴露 Chromium 环境，会被 Google 判定"浏览器或应用可能不安全"拒绝登录
  private sanitizeUserAgent(view: WebContentsView): void {
    try {
      const userAgent = buildChromeUserAgent();
      view.webContents.setUserAgent(userAgent);
      view.webContents.session.setUserAgent(userAgent);
    } catch (error) {
      console.warn("[ai-hub] sanitizeUserAgent failed:", error);
    }
  }

  private hardenSession(view: WebContentsView): void {
    const session = view.webContents.session;
    session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media");
    });
    const { brands, fullVersionBrands, platform } = chromeClientHints();
    try {
      session.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        requestHeaders["sec-ch-ua"] = brands;
        requestHeaders["sec-ch-ua-mobile"] = "?0";
        requestHeaders["sec-ch-ua-platform"] = platform;
        requestHeaders["sec-ch-ua-full-version-list"] = fullVersionBrands;
        callback({ requestHeaders });
      });
    } catch (error) {
      console.warn("[ai-hub] client hint spoof failed:", error);
    }
  }

  private wireEvents(siteId: string, view: WebContentsView): void {
    const webContents = view.webContents;
    // 导航提交后立即同步 userAgentData（早于页面脚本读取；dom-ready 已晚）
    webContents.on("did-navigate", (event, url) => {
      if (!url.startsWith("http")) return;
      void webContents.executeJavaScript(buildUserAgentDataShim(), true).catch(() => {});
    });
    webContents.on("did-start-loading", () => this.emit({ type: "loading", siteId }));
    webContents.on("did-finish-load", () => this.emit({ type: "loaded", siteId }));
    webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 = 导航被取消（重复导航）
      // 失败时 detach，让渲染层的错误覆盖层可见
      const entry = this.pool.get(siteId);
      if (entry) this.detach(entry);
      this.emit({ type: "load-failed", siteId, errorCode });
    });
    webContents.on("page-title-updated", (_event, title) => this.emit({ type: "title", siteId, title }));
    webContents.on("render-process-gone", () => {
      const entry = this.pool.get(siteId);
      if (entry) this.destroyEntry(siteId, entry);
      this.emit({ type: "load-failed", siteId, errorCode: -1 });
    });
  }

  // 剪贴板粘贴回退：保存 → 写入 → focus + paste → Enter → 恢复。
  // 不依赖站点 DOM，是适配器失效时的可用性底线。
  private async pasteFallback(entry: PoolEntry, text: string): Promise<void> {
    const previous = await clipboard.readText();
    try {
      await clipboard.writeText(text);
      entry.view.webContents.focus();
      entry.view.webContents.paste();
      await sleep(150);
      await entry.view.webContents.executeJavaScript(ENTER_DISPATCH_SCRIPT, true);
    } finally {
      // 给站点输入框足够时间消费剪贴板后再恢复
      setTimeout(() => {
        void clipboard.writeText(previous).catch(() => {
          // 剪贴板恢复失败可忽略
        });
      }, 300);
    }
  }

  // 带图片的注入：剪贴板逐张粘贴图片 → 粘贴文本 → 派发 Enter。
  // 适配器脚本只能填文本，图片必须走真实剪贴板，因此带图时统一走这条路径。
  private async pasteImagesFallback(entry: PoolEntry, text: string, images: string[]): Promise<void> {
    // Electron 44 起剪贴板为 W3C 风格（ClipboardItem 按 MIME 键控），整组回写恢复最稳
    const previousItems = await clipboard.read().catch(() => [] as Electron.ClipboardItem[]);
    const restoreClipboard = () => {
      setTimeout(() => {
        if (previousItems.length === 0) return;
        void clipboard.write(previousItems).catch(() => {
          // 剪贴板恢复失败可忽略
        });
      }, 300);
    };
    try {
      for (const dataUrl of images) {
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
        if (image.isEmpty()) continue;
        await clipboard.write([new electron.ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
        entry.view.webContents.focus();
        entry.view.webContents.paste();
        await sleep(250);
      }
      if (text) {
        await clipboard.writeText(text);
        entry.view.webContents.focus();
        entry.view.webContents.paste();
        await sleep(150);
      }
      await entry.view.webContents.executeJavaScript(ENTER_DISPATCH_SCRIPT, true);
    } catch (error) {
      restoreClipboard();
      throw error;
    }
    restoreClipboard();
  }
}
