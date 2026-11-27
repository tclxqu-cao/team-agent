export declare const REMOTE_DESKTOP_VISIBILITY_TYPE = "agent-web-shell:remote-desktop-visibility:v1";
export declare const REMOTE_DESKTOP_CLOSE_TYPE = "agent-webapp:remote-desktop-close:v1";
export declare const REMOTE_DESKTOP_CONTENT_READY_TYPE = "agent-webapp:remote-desktop-content-ready:v1";
export declare function readRemoteDesktopVisibility(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): boolean | null;
//# sourceMappingURL=RemoteDesktopTabBridge.d.ts.map