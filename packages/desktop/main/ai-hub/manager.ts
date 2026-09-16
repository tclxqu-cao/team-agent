import { createRequire } from "node:module";
import type { BaseWindow, BrowserWindow, WebContents, WebContentsView } from "electron";
import { CONVERSATION_EXTRACT_SCRIPT, CONTINUE_BUTTON_SCRIPT, ENTER_DISPATCH_SCRIPT, SEND_TARGET_SCRIPT, buildAdapterScript, buildFillInputScript, buildFocusInputScript, buildSubmissionProbeScript } from "./adapters.js";
import type { ChromeHubBridge } from "./chrome-bridge.js";
import { isChromeHubSite, chromeHubErrorMessage } from "./chrome-bridge-protocol.js";
import { HubConfigStore, normalizeHubConfig, type HubAdapterId, type HubConfig } from "./config.js";
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
  /** 页面挂着「继续生成」控件：上一条回复被站点截断，等待续跑。 */
  pendingContinue?: boolean;
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
  host: "none" | "main" | "background";
  loaded: boolean;
  sentTexts: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const poolKey = (siteId: string, conversationId?: string) => conversationId ? `${siteId}::${conversationId}` : siteId;

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
  private backgroundHost: BaseWindow | null = null;
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
  async openSite(siteId: string, options: { applySavedLayout?: boolean; conversationId?: string } = {}): Promise<void> {
    const site = this.config.sites.find((candidate) => candidate.id === siteId);
    if (!site) return;
    if (this.usesChrome(siteId)) return;
    const key = poolKey(site.id, options.conversationId);
    const entry = this.ensureView(key, site.id, site.url);
    if (options.applySavedLayout === false) await this.parkInBackground(entry);
    const pane = options.applySavedLayout === false ? undefined : this.layout.get(siteId);
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
    if (options.applySavedLayout === false && entry.loaded) {
      await this.keepBackgroundPageActive(entry);
    }
  }

  usesChrome(siteId: string): boolean { return isChromeHubSite(siteId) && !!this.chromeBridge; }

  // 关闭并销毁站点视图（pane 头部“关闭页面”；登录态在 persist 分区中保留）
  closeSite(siteId: string, conversationId?: string): void {
    if (this.usesChrome(siteId)) { void this.chromeBridge!.request(siteId, "detach").catch(() => {}); return; }
    const key = poolKey(siteId, conversationId);
    const entry = this.pool.get(key);
    if (!entry) return;
    this.destroyEntry(key, entry);
  }

  setBounds(panes: HubPaneRect[]): void {
    this.layout.replace(panes);
    const window = this.getWindow();
    if (!window) return;
    const listed = new Set<string>();
    for (const pane of panes) {
      const entry = this.pool.get(poolKey(pane.siteId, pane.conversationId));
      if (!entry) continue;
      listed.add(poolKey(pane.siteId, pane.conversationId));
      this.applyBounds(entry, pane);
    }
    // 不在本次布局中的已 attach 视图 → detach（隐藏不销毁）
    for (const [key, entry] of this.pool) {
      if (entry.host === "main" && !listed.has(key)) this.detach(entry);
    }
  }

  reloadSite(siteId: string, conversationId?: string): void {
    if (this.usesChrome(siteId)) { void this.chromeBridge!.request(siteId, "reload").catch(() => {}); return; }
    const entry = this.pool.get(poolKey(siteId, conversationId));
    if (!entry) return;
    entry.view.webContents.reload();
  }

  // 中继触发（web 控制台转发）：显示窗口、打开目标站点并平铺视图，再注入。
  // 不依赖渲染端的 AI Hub 界面是否打开 —— 主进程自己算格子矩形。
  async relayBroadcast(
    text: string,
    siteIds: string[],
    images: string[] = [],
    options: { background?: boolean } = {},
    conversationId?: string,
  ): Promise<HubBroadcastResult[]> {
    const window = this.getWindow();
    const background = options.background === true;
    if (window && !background) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const opened: string[] = [];
    for (const siteId of siteIds) {
      if (!this.config.sites.some((site) => site.id === siteId)) continue;
      if (background) {
        const existing = this.pool.get(poolKey(siteId, conversationId));
        if (existing) await this.parkInBackground(existing);
      }
      await this.openSite(siteId, { applySavedLayout: !background, conversationId });
      opened.push(siteId);
    }
    if (window && opened.length > 0 && !background) {
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
    try {
      return await this.broadcast(text, opened, images, conversationId);
    } finally {
      if (background) {
        for (const siteId of opened) {
          const entry = this.pool.get(poolKey(siteId, conversationId));
          if (entry) await this.parkInBackground(entry);
        }
      }
    }
  }

  // 同步发送：纯文本走适配器优先；带图片或适配器失败走剪贴板粘贴回退；单站点失败不影响其他站点。
  async broadcast(text: string, siteIds: string[], images: string[] = [], conversationId?: string): Promise<HubBroadcastResult[]> {
    const results: HubBroadcastResult[] = [];
    // Chrome tabs do not share Electron's system-clipboard fallback; dispatch them concurrently.
    const chromeResults = new Map([...new Set(siteIds)].filter((siteId) => this.usesChrome(siteId) && this.config.sites.some((site) => site.id === siteId)).map((siteId) => [siteId, this.sendToChrome(siteId, text, images)]));
    for (const siteId of siteIds) {
      const site = this.config.sites.find((candidate) => candidate.id === siteId);
      if (site && this.usesChrome(siteId)) {
        results.push(await chromeResults.get(siteId)!);
        continue;
      }
      const entry = this.pool.get(poolKey(siteId, conversationId));
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
        if (entry.view.webContents.debugger) {
          await this.sendTextViaCdp(entry.view.webContents, site.adapter, text);
        } else {
          await entry.view.webContents.executeJavaScript(buildAdapterScript(site.adapter, text), true);
        }
        this.rememberSentText(entry, text);
        results.push({ siteId, ok: true });
      } catch (adapterError) {
        if (adapterError instanceof Error && adapterError.message.includes("submit-not-confirmed")) {
          results.push({ siteId, ok: false, reason: "网页发送按钮已尝试，但未确认消息提交" });
          continue;
        }
        results.push({
          siteId,
          ok: false,
          reason: adapterError instanceof Error ? adapterError.message.slice(0, 120) : "adapter-failed",
        });
        console.warn("[ai-hub] CDP text send failed:", siteId, adapterError);
      }
    }
    return results;
  }

  private async sendTextViaCdp(webContents: WebContents, adapter: HubAdapterId | undefined, text: string): Promise<void> {
    const cdp = webContents.debugger;
    if (!cdp.isAttached()) cdp.attach("1.3");
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await cdp.sendCommand("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }) as { result?: { value?: T; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "cdp-evaluate-failed");
      }
      return response.result?.value as T;
    };

    const baseline = await evaluate<{ url: string; userCount: number; outputCount: number; inputLength: number }>(buildFillInputScript(adapter, text));
    await sleep(900);
    // Submit exactly once. Runtime click is intentional here: a background
    // WebContentsView can clip the real button outside its viewport, causing
    // coordinate-based CDP mouse events and Enter to be ignored by DeepSeek.
    const target = await evaluate<{ clicked: true } | null>(SEND_TARGET_SCRIPT);
    if (!target?.clicked) {
      await evaluate<boolean>(buildFocusInputScript(adapter));
      await cdp.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await cdp.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
    let attachmentSubmitAttempted = false;
    for (let poll = 0; poll < 8; poll += 1) {
      await sleep(900);
      const probe = await evaluate<{ submitted: boolean; navigated: boolean; userCount: number; outputCount: number; inputLength: number; hasSourceAttachment: boolean }>(buildSubmissionProbeScript(baseline));
      const attachmentPending = probe.hasSourceAttachment
        && probe.userCount <= baseline.userCount
        && probe.outputCount <= baseline.outputCount;
      if (attachmentPending && !attachmentSubmitAttempted) {
        attachmentSubmitAttempted = true;
        // First click converted the oversized prompt into DeepSeek's source
        // attachment. Submit that attachment exactly once; later polls only
        // observe, so a delayed page update cannot duplicate the user turn.
        await evaluate<{ clicked: true } | null>(SEND_TARGET_SCRIPT);
        continue;
      }
      if (probe.submitted) {
        await sleep(2_000);
        const stableProbe = await evaluate<{ submitted: boolean; navigated: boolean; userCount: number; outputCount: number; inputLength: number; hasSourceAttachment: boolean }>(buildSubmissionProbeScript(baseline));
        if (stableProbe.submitted) return;
      }
    }
    throw new Error("submit-not-confirmed");
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
    this.backgroundHost?.close();
    this.backgroundHost = null;
  }

  /** 认证始终在用户日常浏览器中进行。 */
  requestExistingBrowserLogin(siteId: string): boolean {
    if (!this.requestBrowserLogin) return false;
    this.requestBrowserLogin(siteId);
    return true;
  }

  // 会话抽取（web 控制台 capture 轮询）：只读已打开站点的 DOM，未打开的站点返回 site-not-open。
  async captureConversations(siteIds: string[], conversationId?: string): Promise<HubCaptureResult[]> {
    const results: HubCaptureResult[] = [];
    for (const siteId of siteIds) {
      if (this.usesChrome(siteId)) {
        try {
          const extract = await this.chromeBridge!.request(siteId, "snapshot") as { messages?: Array<{ role: string; content: string }>; pendingContinue?: boolean; debug?: Record<string, unknown> };
          results.push({ siteId, ok: true, strategy: siteId, pendingContinue: extract?.pendingContinue === true, debug: extract?.debug, messages: (extract?.messages ?? []).map((message) => ({ role: message.role, text: message.content })) });
        } catch (error) {
          results.push({ siteId, ok: false, reason: error instanceof Error ? error.message : "Chrome 页面读取失败" });
        }
        continue;
      }
      const entry = this.pool.get(poolKey(siteId, conversationId));
      if (!entry) {
        results.push({ siteId, ok: false, reason: "site-not-open" });
        continue;
      }
      try {
        let extract: any;
        const cdp = entry.view.webContents.debugger;
        if (cdp) {
          if (!cdp.isAttached()) cdp.attach("1.3");
          const response = await cdp.sendCommand("Runtime.evaluate", {
            expression: CONVERSATION_EXTRACT_SCRIPT,
            awaitPromise: true,
            returnByValue: true,
          }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
          if (response.exceptionDetails) {
            throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "cdp-capture-failed");
          }
          extract = response.result?.value;
        } else {
          extract = await entry.view.webContents.executeJavaScript(CONVERSATION_EXTRACT_SCRIPT, true);
        }
        const pageTitle = typeof extract?.debug?.title === "string"
          ? extract.debug.title.replace(/\s*-\s*DeepSeek\s*$/i, "").trim()
          : "";
        const messages = Array.isArray(extract?.messages)
          ? extract.messages.map((message: { role?: string; text?: string }) => ({
            role: this.isKnownSentText(entry, String(message?.text || "")) ? "user" : "assistant",
            text: String(message?.text || ""),
          })).filter((message: { text: string }) => {
            const text = message.text.trim();
            return Boolean(text) && text !== pageTitle;
          })
          : [];
        results.push({
          siteId,
          ok: true,
          strategy: typeof extract?.strategy === "string" ? extract.strategy : "none",
          messages,
          pendingContinue: extract?.pendingContinue === true,
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

  // 「继续生成」：provider 检测到站点把回复截断并挂出继续按钮时，由中继触发
  // 真实控件点击续跑。内嵌视图走 CDP Runtime click；Chrome 站点走扩展命令。
  async continueGeneration(siteIds: string[], conversationId?: string): Promise<HubBroadcastResult[]> {
    const results: HubBroadcastResult[] = [];
    for (const siteId of siteIds) {
      if (this.usesChrome(siteId)) {
        try {
          const result = await this.chromeBridge!.request(siteId, "continue") as { clicked?: boolean } | undefined;
          if (result?.clicked !== true) throw new Error("chrome-continue-unconfirmed");
          results.push({ siteId, ok: true });
        } catch (error) {
          results.push({ siteId, ok: false, reason: error instanceof Error ? chromeHubErrorMessage(error.message) : "Chrome 页面继续生成失败" });
          console.warn("[ai-hub] chrome continue failed:", siteId, error);
        }
        continue;
      }
      const entry = this.pool.get(poolKey(siteId, conversationId));
      if (!entry) {
        results.push({ siteId, ok: false, reason: "site-not-open" });
        continue;
      }
      try {
        let clicked = false;
        const cdp = entry.view.webContents.debugger;
        if (cdp) {
          if (!cdp.isAttached()) cdp.attach("1.3");
          const response = await cdp.sendCommand("Runtime.evaluate", {
            expression: CONTINUE_BUTTON_SCRIPT,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          }) as { result?: { value?: { clicked?: boolean } }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
          if (response.exceptionDetails) {
            throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "cdp-continue-failed");
          }
          clicked = response.result?.value?.clicked === true;
        } else {
          const value = await entry.view.webContents.executeJavaScript(CONTINUE_BUTTON_SCRIPT, true) as { clicked?: boolean } | undefined;
          clicked = value?.clicked === true;
        }
        if (!clicked) {
          results.push({ siteId, ok: false, reason: "continue-button-not-found" });
          continue;
        }
        results.push({ siteId, ok: true });
      } catch (error) {
        results.push({
          siteId,
          ok: false,
          reason: error instanceof Error ? error.message.slice(0, 120) : "continue-failed",
        });
        console.warn("[ai-hub] continue click failed:", siteId, error);
      }
    }
    return results;
  }

  private detach(entry: PoolEntry): void {
    entry.view.setVisible(false);
    entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    if (entry.host === "main") {
      this.getWindow()?.contentView.removeChildView(entry.view);
    } else if (entry.host === "background") {
      this.backgroundHost?.contentView.removeChildView(entry.view);
    }
    entry.host = "none";
  }

  private rememberSentText(entry: PoolEntry, text: string): void {
    entry.sentTexts.push(text);
    if (entry.sentTexts.length > 30) entry.sentTexts.splice(0, entry.sentTexts.length - 30);
  }

  private isKnownSentText(entry: PoolEntry, capturedText: string): boolean {
    const normalized = capturedText.trim();
    if (!normalized) return false;
    return entry.sentTexts.some((sentText) => {
      const sent = sentText.trim();
      if (sent === normalized) return true;
      const anchor = sent.match(/^【Agent 转发 · [^】]+】/)?.[0];
      return Boolean(anchor && normalized.includes(anchor));
    });
  }

  private async parkInBackground(entry: PoolEntry): Promise<void> {
    const host = this.ensureBackgroundHost();
    if (entry.host === "main") {
      this.getWindow()?.contentView.removeChildView(entry.view);
      entry.host = "none";
    }
    if (entry.host !== "background") {
      host.contentView.addChildView(entry.view);
      entry.host = "background";
    }
    // A hidden BaseWindow still gives Chromium a real layout viewport. Moving
    // a child view outside the visible main window collapses it to 0x0 on macOS.
    entry.view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    entry.view.setVisible(true);
  }

  private async keepBackgroundPageActive(entry: PoolEntry): Promise<void> {
    const cdp = entry.view.webContents.debugger;
    if (!cdp) return;
    try {
      if (!cdp.isAttached()) cdp.attach("1.3");
      // backgroundThrottling keeps timers running, but an off-screen macOS
      // BaseWindow still reports the page as unfocused. DeepSeek defers its
      // response in that state, so mirror the Chrome bridge's CDP treatment.
      await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      console.warn("[ai-hub] background focus emulation failed:", error);
    }
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
    if (entry.host === "background") {
      this.backgroundHost?.contentView.removeChildView(entry.view);
      entry.host = "none";
    }
    if (entry.host !== "main") {
      window.contentView.addChildView(entry.view);
      entry.host = "main";
    }
    entry.view.setVisible(true);
    entry.view.setBounds({
      x: Math.round(pane.x),
      y: Math.round(pane.y),
      width,
      height,
    });
  }

  private ensureBackgroundHost(): BaseWindow {
    if (this.backgroundHost && !this.backgroundHost.isDestroyed()) return this.backgroundHost;
    const host = new electron.BaseWindow({
      show: false,
      x: -20_000,
      y: -20_000,
      width: 1200,
      height: 800,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      opacity: 0,
      enableLargerThanScreen: true,
    });
    host.setIgnoreMouseEvents(true);
    host.showInactive();
    host.on("closed", () => {
      if (this.backgroundHost === host) this.backgroundHost = null;
    });
    this.backgroundHost = host;
    return host;
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

  private ensureView(key: string, siteId: string, url: string): PoolEntry {
    const existing = this.pool.get(key);
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
        // Agent conversations keep running while their provider view is
        // detached from the visible AI Hub layout.
        backgroundThrottling: false,
        autoplayPolicy: "user-gesture-required",
      },
    });
    view.setBackgroundColor("#ffffff");
    // WebContentsView defaults to visible. Keep newly created provider views
    // hidden until an explicit AI Hub layout attaches and reveals them.
    view.setVisible(false);
    this.hardenSession(view);
    this.wireEvents(siteId, url, view);
    const entry: PoolEntry = { view, host: "none", loaded: false, sentTexts: [] };
    this.pool.set(key, entry);
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
