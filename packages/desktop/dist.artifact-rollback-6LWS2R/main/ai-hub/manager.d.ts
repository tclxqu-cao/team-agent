import type { BrowserWindow } from "electron";
import type { ChromeHubBridge } from "./chrome-bridge.js";
import { type HubConfig } from "./config.js";
import { type HubPaneRect } from "./pane-layout-state.js";
export type { HubPaneRect } from "./pane-layout-state.js";
export type GoogleReauthEventState = "started" | "synchronized" | "canceled" | "timeout" | "failed" | "unavailable";
export type HubEvent = {
    type: "loading" | "loaded" | "load-failed" | "title" | "focused";
    siteId: string;
    errorCode?: number;
    title?: string;
} | {
    type: "google-auth-external";
    siteId: string;
} | {
    type: "google-reauth";
    siteId: string;
    state: GoogleReauthEventState;
};
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
    messages?: Array<{
        role: string;
        text: string;
    }>;
    /** 页面仍在生成当前回复，文本稳定不代表完成。 */
    generating?: boolean;
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
interface EmbeddedPageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare class AIHubManager {
    private readonly store;
    private readonly getWindow;
    private readonly getImportedProfilePath?;
    private readonly requestBrowserLogin?;
    private readonly chromeBridge?;
    private readonly pool;
    private readonly layout;
    private backgroundHost;
    private config;
    private readonly listeners;
    constructor(deps: AIHubManagerDeps);
    subscribe(listener: (event: HubEvent) => void): () => void;
    private emit;
    getConfig(): HubConfig;
    setConfig(raw: unknown): HubConfig;
    openSite(siteId: string, options?: {
        applySavedLayout?: boolean;
        conversationId?: string;
    }): Promise<void>;
    usesChrome(siteId: string): boolean;
    closeSite(siteId: string, conversationId?: string): void;
    setBounds(panes: HubPaneRect[]): void;
    reloadSite(siteId: string, conversationId?: string): void;
    openEmbeddedPage(pageId: string, rawUrl: string, options?: {
        allowMedia?: boolean;
    }): Promise<void>;
    setEmbeddedPageBounds(pageId: string, rect: EmbeddedPageRect | null): void;
    reloadEmbeddedPage(pageId: string): void;
    closeEmbeddedPage(pageId: string): void;
    relayBroadcast(text: string, siteIds: string[], images?: string[], options?: {
        background?: boolean;
    }, conversationId?: string): Promise<HubBroadcastResult[]>;
    broadcast(text: string, siteIds: string[], images?: string[], conversationId?: string): Promise<HubBroadcastResult[]>;
    private sendTextViaCdp;
    private sendToChrome;
    destroyAll(): void;
    /** 认证始终在用户日常浏览器中进行。 */
    requestExistingBrowserLogin(siteId: string): boolean;
    captureConversations(siteIds: string[], conversationId?: string): Promise<HubCaptureResult[]>;
    continueGeneration(siteIds: string[], conversationId?: string): Promise<HubBroadcastResult[]>;
    private detach;
    private rememberSentText;
    private isKnownSentText;
    private parkInBackground;
    private keepBackgroundPageActive;
    private applyBounds;
    private ensureBackgroundHost;
    private destroyEntry;
    private ensureView;
    private hardenSession;
    private wireEvents;
    private pasteFallback;
    private pasteImagesFallback;
}
//# sourceMappingURL=manager.d.ts.map