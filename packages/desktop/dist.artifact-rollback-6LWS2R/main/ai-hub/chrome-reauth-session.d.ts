import { spawn } from "node:child_process";
import { type ElectronCookieDetails } from "./cookie-migration.js";
export declare const GOOGLE_REAUTH_TEMP_PREFIX = "google-reauth-";
export type GoogleReauthStatus = "synchronized" | "waiting" | "canceled" | "timeout" | "failed" | "unavailable";
export interface GoogleReauthResult {
    status: GoogleReauthStatus;
    /** 稳定错误类别；绝不含 cookie 值、URL 查询串或密钥材料 */
    reason?: string;
}
export interface GoogleReauthRequest {
    siteId: string;
    /** 提供方配置的主页 URL（受信任的站点配置，非渲染层回调数据） */
    homeUrl: string;
    /** 登录成功回落的目标提供方 origin，如 https://gemini.google.com */
    successOrigin: string;
    /** 同步成功时的 cookie 写入回调；只在主进程内使用，不跨 IPC */
    onCookies: (details: ElectronCookieDetails[]) => Promise<void>;
}
export interface CdpConnection {
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    onEvent(listener: (event: {
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
    }) => void): void;
    close(): void;
}
export interface DevToolsEndpoint {
    port: number;
    browserPath: string;
}
export type CdpConnector = (endpoint: DevToolsEndpoint) => Promise<CdpConnection>;
export interface ChromeReauthDeps {
    chromePath: string;
    tempRoot: string;
    timeoutMs?: number;
    spawnProcess?: typeof spawn;
    connectCdp?: CdpConnector;
    waitForPortFile?: (path: string, timeoutMs: number) => Promise<DevToolsEndpoint | null>;
}
export declare function parseDevToolsActivePort(content: string): DevToolsEndpoint | null;
/** 两行都写完才连接：第一行端口，第二行 Chrome 生成的 browser WebSocket 路径。 */
export declare function waitForDevToolsPortFile(path: string, timeoutMs: number): Promise<DevToolsEndpoint | null>;
/** 连接本次 Chrome 生成的回环端点；断开时立即结束所有待完成请求。 */
export declare function connectBrowserCdp(endpoint: DevToolsEndpoint): Promise<CdpConnection>;
/**
 * 使用系统 Chrome 的一次性私有 Profile 登录。用户完成登录后明确点击同步，
 * 不将提供方首页、OAuth 回跳或任意 Cookie 的存在推断为认证成功。
 */
export declare class ChromeReauthController {
    private readonly deps;
    private active;
    constructor(deps: ChromeReauthDeps);
    isRunning(): boolean;
    /** 重复导航只能复用正在进行的登录；不会隐式触发 Cookie 同步。 */
    start(request: GoogleReauthRequest): Promise<GoogleReauthResult>;
    /** 只有目标站点的用户确认按钮能同步；并发点击共享同一个同步结果。 */
    attemptSyncNow(siteId: string): Promise<GoogleReauthResult>;
    private synchronize;
    cancel(): GoogleReauthResult;
}
/** 清理上次异常退出遗留的临时 Chrome Profile。 */
export declare function cleanupAbandonedReauthProfiles(tempRoot: string): Promise<void>;
//# sourceMappingURL=chrome-reauth-session.d.ts.map