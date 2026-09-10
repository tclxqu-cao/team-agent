import { createRequire } from "node:module";
import type { BrowserWindow, WebContents, WebContentsView } from "electron";
import { CONVERSATION_EXTRACT_SCRIPT, ENTER_DISPATCH_SCRIPT, buildAdapterScript, buildFocusInputScript } from "./adapters.js";
import type { ChromeHubBridge } from "./chrome-bridge.js";
import { isChromeHubSite, chromeHubErrorMessage } from "./chrome-bridge-protocol.js";
import { HubConfigStore, normalizeHubConfig, type HubConfig } from "./config.js";
import { isGoogleAuthUrl } from "./navigation-policy.js";
import { HubPaneLayoutState, type HubPaneRect } from "./pane-layout-state.js";
import { resolveHubSessionPlan } from "./session-choice.js";

export type { HubPaneRect } from "./pane-layout-state.js";

const require = createRequire(import.meta.url);
// Load electron via createRequire (CJS) — see main/index.ts for the ESM crash rationale.
// WebContentsView is accessed off the namespace to avoid clashing with the type import.
const electron = require("electron") as typeof import("electron");
const { clipboard, nativeImage, session, shell } = electron;

export type GoogleReauthEventState = "started" | "synchronized" | "canceled" | "timeout" | "failed" | "unavailable";

export type HubEvent =
  | { type: "loading" | "loaded" | "load-failed" | "title"; siteId: string; errorCode?: number; title?: string }
  | { type: "google-auth-external"; siteId: string }
  | { type: "google-reauth"; siteId: string; state: GoogleReauthEventState };

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
  /** 已完成导入时返回共享 Profile 快照的绝对路径；null = 保持每站点分区 */
  getImportedProfilePath?: () => string | null;
  /** 在用户日常浏览器中打开登录，不访问其 Cookie。 */
  requestBrowserLogin?: (siteId: string) => void;
  chromeBridge?: ChromeHubBridge;
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
  private readonly getImportedProfilePath?: () => string | null;
  private readonly requestBrowserLogin?: (siteId: string) => void;
  private readonly chromeBridge?: ChromeHubBridge;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly layout = new HubPaneLayoutState();
  private config: HubConfig;
  private readonly listeners = new Set<(event: HubEvent) => void>();

  constructor(deps: AIHubManagerDeps) {
    this.store = new HubConfigStore(deps.configPath);
    this.getWindow = deps.getWindow;
    this.getImportedProfilePath = deps.getImportedProfilePath;
    this.requestBrowserLogin = deps.requestBrowserLogin;
    this.chromeBridge = deps.chromeBridge;
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
    if (this.usesChrome(siteId)) return;
    const entry = this.ensureView(site.id, site.url);
    const pane = this.layout.get(siteId);
    if (pane) this.applyBounds(entry, pane);
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

  usesChrome(siteId: string): boolean { return isChromeHubSite(siteId) && !!this.chromeBridge; }

  // 关闭并销毁站点视图（pane 头部“关闭页面”；登录态在 persist 分区中保留）
  closeSite(siteId: string): void {
    if (this.usesChrome(siteId)) { void this.chromeBridge!.request(siteId, "detach").catch(() => {}); return; }
    const entry = this.pool.get(siteId);
    if (!entry) return;
    this.destroyEntry(siteId, entry);
  }

  setBounds(panes: HubPaneRect[]): void {
    this.layout.replace(panes);
    const window = this.getWindow();
    if (!window) return;
    const listed = new Set<string>();
    for (const pane of panes) {
      const entry = this.pool.get(pane.siteId);
      if (!entry) continue;
      listed.add(pane.siteId);
      this.applyBounds(entry, pane);
    }
    // 不在本次布局中的已 attach 视图 → detach（隐藏不销毁）
    for (const [siteId, entry] of this.pool) {
      if (entry.attached && !listed.has(siteId)) this.detach(entry);
    }
  }

  reloadSite(siteId: string): void {
    if (this.usesChrome(siteId)) { void this.chromeBridge!.request(siteId, "reload").catch(() => {}); return; }
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
    // Chrome tabs do not share Electron's system-clipboard fallback; dispatch them concurrently.
    const chromeResults = new Map([...new Set(siteIds)].filter((siteId) => this.usesChrome(siteId) && this.config.sites.some((site) => site.id === siteId)).map((siteId) => [siteId, this.sendToChrome(siteId, text, images)]));
    for (const siteId of siteIds) {
      const site = this.config.sites.find((candidate) => candidate.id === siteId);
      if (site && this.usesChrome(siteId)) {
        results.push(await chromeResults.get(siteId)!);
        continue;
      }
      const entry = this.pool.get(siteId);
      if (!site || !entry) {
        results.push({ siteId, ok: false, reason: "site-not-open" });
        continue;
      }
      if (images.length > 0) {
        try {
          await entry.view.webContents.executeJavaScript(buildFocusInputScript(site.adapter), true);
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

  private async sendToChrome(siteId: string, text: string, images: string[]): Promise<HubBroadcastResult> {
    try {
      const result = await this.chromeBridge!.request(siteId, "send-message", { text, images }) as { submitted?: boolean } | undefined;
      if (result?.submitted !== true) throw new Error("chrome-submit-unconfirmed");
      return { siteId, ok: true };
    } catch (error) {
      return { siteId, ok: false, reason: error instanceof Error ? chromeHubErrorMessage(error.message) : "Chrome 页面发送失败" };
    }
  }

  destroyAll(): void {
    for (const [siteId, entry] of this.pool) this.destroyEntry(siteId, entry);
  }

  /** 认证始终在用户日常浏览器中进行。 */
  requestExistingBrowserLogin(siteId: string): boolean {
    if (!this.requestBrowserLogin) return false;
    this.requestBrowserLogin(siteId);
    return true;
  }

  // 会话抽取（web 控制台 capture 轮询）：只读已打开站点的 DOM，未打开的站点返回 site-not-open。
  async captureConversations(siteIds: string[]): Promise<HubCaptureResult[]> {
    const results: HubCaptureResult[] = [];
    for (const siteId of siteIds) {
      if (this.usesChrome(siteId)) {
        try {
          const extract = await this.chromeBridge!.request(siteId, "snapshot") as { messages?: Array<{ role: string; content: string }>; debug?: Record<string, unknown> };
          results.push({ siteId, ok: true, strategy: siteId, debug: extract?.debug, messages: (extract?.messages ?? []).map((message) => ({ role: message.role, text: message.content })) });
        } catch (error) {
          results.push({ siteId, ok: false, reason: error instanceof Error ? error.message : "Chrome 页面读取失败" });
        }
        continue;
      }
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

  private applyBounds(entry: PoolEntry, pane: HubPaneRect): void {
    const width = Math.round(pane.width);
    const height = Math.round(pane.height);
    if (width <= 0 || height <= 0) {
      this.detach(entry);
      return;
    }
    const window = this.getWindow();
    if (!window) return;
    if (!entry.attached) {
      window.contentView.addChildView(entry.view);
      entry.attached = true;
    }
    entry.view.setBounds({
      x: Math.round(pane.x),
      y: Math.round(pane.y),
      width,
      height,
    });
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
    // 已导入 Profile：全部窗格共享同一 Session（一个浏览器身份）；否则保持每站点持久分区
    const plan = resolveHubSessionPlan(siteId, this.getImportedProfilePath?.() ?? null);
    const view = new electron.WebContentsView({
      webPreferences: {
        ...(plan.kind === "shared-imported"
          ? { session: session.fromPath(plan.profilePath) }
          : { partition: plan.partition }),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: "user-gesture-required",
      },
    });
    view.setBackgroundColor("#ffffff");
    this.hardenSession(view);
    this.wireEvents(siteId, url, view);
    const entry: PoolEntry = { view, attached: false, loaded: false };
    this.pool.set(siteId, entry);
    return entry;
  }

  private hardenSession(view: WebContentsView): void {
    view.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media");
    });
  }

  private wireEvents(siteId: string, siteUrl: string, view: WebContentsView): void {
    const webContents = view.webContents;
    const openGoogleAuthExternally = () => {
      // 认证转交日常浏览器，不尝试从调试 Chrome 迁移 Cookie。
      if (this.requestExistingBrowserLogin(siteId)) return;
      this.emit({ type: "google-auth-external", siteId });
      void shell.openExternal(siteUrl).catch((error) => {
        console.warn("[ai-hub] failed to open provider in system browser:", siteId, error instanceof Error ? error.message : "unknown error");
      });
    };
    const protectNavigation = (target: WebContents, close?: () => void) => {
      const handleNavigation = (event: Electron.Event, url: string) => {
        if (!isGoogleAuthUrl(url)) return;
        event.preventDefault();
        close?.();
        openGoogleAuthExternally();
      };
      target.on("will-navigate", handleNavigation);
      target.on("will-redirect", handleNavigation);
    };
    protectNavigation(webContents);
    webContents.setWindowOpenHandler(({ url }) => {
      if (!isGoogleAuthUrl(url)) return { action: "allow" };
      openGoogleAuthExternally();
      return { action: "deny" };
    });
    webContents.on("did-create-window", (window) => {
      protectNavigation(window.webContents, () => window.close());
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
