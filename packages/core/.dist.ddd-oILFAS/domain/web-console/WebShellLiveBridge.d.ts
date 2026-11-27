export declare const WEB_SHELL_OPEN_BROWSER_LIVE_TYPE = "agent-web-shell:open-browser-live:v1";
export interface WebShellOpenBrowserLiveMessage {
    type: typeof WEB_SHELL_OPEN_BROWSER_LIVE_TYPE;
}
export declare function parseWebShellOpenBrowserLive(data: unknown): WebShellOpenBrowserLiveMessage | null;
export declare function readWebShellOpenBrowserLive(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): WebShellOpenBrowserLiveMessage | null;
//# sourceMappingURL=WebShellLiveBridge.d.ts.map