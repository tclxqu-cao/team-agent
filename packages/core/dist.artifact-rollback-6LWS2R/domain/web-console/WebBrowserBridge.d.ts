export declare const WEBAPP_BROWSER_REQUEST_TYPE = "agent-webapp:browser-request:v1";
export declare const WEBAPP_BROWSER_RESPONSE_TYPE = "agent-web-shell:browser-response:v1";
export declare const WEBAPP_BROWSER_EVENT_TYPE = "agent-web-shell:browser-event:v1";
export declare const WEBAPP_BROWSER_BINARY_FRAME_TYPE = "agent-web-shell:browser-frame:v1";
export declare const WEB_BROWSER_METHODS: readonly ["browser:list", "browser:watch", "browser:unwatch", "browser:desktop-watch", "browser:desktop-unwatch", "browser:takeover", "browser:return", "browser:input", "browser:set-display", "browser:ping", "browser:webrtc", "browser:system"];
export type WebBrowserMethod = typeof WEB_BROWSER_METHODS[number];
export interface WebBrowserRequest {
    type: typeof WEBAPP_BROWSER_REQUEST_TYPE;
    id: number;
    method: WebBrowserMethod;
    payload: Record<string, unknown>;
}
export interface WebBrowserResponse {
    type: typeof WEBAPP_BROWSER_RESPONSE_TYPE;
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
    code?: string;
}
export interface WebBrowserEvent {
    type: typeof WEBAPP_BROWSER_EVENT_TYPE;
    event: Record<string, unknown> & {
        type: string;
    };
}
export interface WebBrowserBinaryFrame {
    type: typeof WEBAPP_BROWSER_BINARY_FRAME_TYPE;
    channelId: number;
    sequence: number;
    data: ArrayBuffer;
}
export declare function parseWebBrowserRequest(data: unknown): WebBrowserRequest | null;
export declare function readWebBrowserRequest(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): WebBrowserRequest | null;
export declare function parseWebBrowserResponse(data: unknown): WebBrowserResponse | null;
export declare function parseWebBrowserEvent(data: unknown): WebBrowserEvent | null;
export declare function parseWebBrowserBinaryFrame(data: unknown): WebBrowserBinaryFrame | null;
//# sourceMappingURL=WebBrowserBridge.d.ts.map