export type BrowserBackend = "ego-browser" | "codex-browser";
export type BrowserTransport = "cdp-jpeg-ws" | "webrtc";
export type BrowserLiveAvailability = "starting" | "ready" | "unavailable";
export type BrowserOwnershipState = "agent-controlled" | "handoff-requested" | "user-controlled" | "return-requested" | "resyncing";
export interface BrowserViewport {
    width: number;
    height: number;
    deviceScaleFactor: number;
}
export interface BrowserLiveSessionView {
    id: string;
    backend: BrowserBackend;
    browserSessionId?: string;
    agentSessionId?: string;
    title: string;
    url: string;
    viewport: BrowserViewport | null;
    transport: BrowserTransport;
    availability: BrowserLiveAvailability;
    capabilityError?: string;
    capabilityErrorCode?: string;
    state: BrowserOwnershipState;
    online: boolean;
    frameSequence: number;
    updatedAt: number;
    viewerCount: number;
    isController: boolean;
    controlledByAnotherViewer: boolean;
}
export type BrowserInput = {
    kind: "pointer";
    action: "down" | "up" | "move" | "wheel";
    x: number;
    y: number;
    button: "left" | "right" | "middle";
    deltaX: number;
    deltaY: number;
} | {
    kind: "key";
    action: "down" | "up";
    key: string;
    code: string;
    text: string;
    modifiers: Array<"Alt" | "Control" | "Meta" | "Shift">;
};
export interface BrowserLiveEvent extends Record<string, unknown> {
    type: string;
}
/** Transport-agnostic peer port implemented by WebSocket infrastructure. */
export interface BrowserLivePeer {
    id: string;
    userId: string;
    send(event: BrowserLiveEvent): void;
    producerSessionIds: Set<string>;
    watchedSessionId: string | null;
}
//# sourceMappingURL=entities.d.ts.map