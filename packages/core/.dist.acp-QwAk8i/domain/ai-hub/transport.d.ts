export interface AiHubSiteInfo {
    id: string;
    name: string;
    url: string;
}
export interface AiHubRelayResult {
    siteId: string;
    ok: boolean;
    reason?: string;
}
export interface AiHubCaptureMessage {
    role: string;
    text: string;
}
export interface AiHubCaptureResult {
    siteId: string;
    ok: boolean;
    strategy?: string;
    messages?: AiHubCaptureMessage[];
    /** 页面仍在生成当前回复；此时文本短暂稳定也不能视为完成。 */
    generating?: boolean;
    /** 页面当前挂着「继续生成」类控件，说明上一条回复被站点截断、等待续跑。 */
    pendingContinue?: boolean;
    reason?: string;
}
export interface AiHubTransport {
    /** 桌面端在线状态与已配置站点列表 */
    status(): Promise<{
        available: boolean;
        sites?: AiHubSiteInfo[];
    }>;
    /** 向站点注入文本（模拟人为发送）；images 为 data:image/*;base64 数据 URL */
    broadcast(text: string, siteIds: string[], images?: string[], conversationId?: string): Promise<{
        available: boolean;
        reason?: string;
        results: AiHubRelayResult[];
    }>;
    /** 只读抓取站点当前对话（站点 DOM 抽取，最近若干条） */
    capture(siteIds: string[], conversationId?: string): Promise<{
        available: boolean;
        reason?: string;
        results: AiHubCaptureResult[];
    }>;
    /** 点击站点的「继续生成」控件，恢复被截断的输出 */
    continueGeneration(siteIds: string[], conversationId?: string): Promise<{
        available: boolean;
        reason?: string;
        results: AiHubRelayResult[];
    }>;
}
//# sourceMappingURL=transport.d.ts.map