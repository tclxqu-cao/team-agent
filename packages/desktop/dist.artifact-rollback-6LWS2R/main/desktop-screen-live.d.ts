import type { LiveViewDisplayOption, LiveViewOwnershipState } from "@agent/core";
import { type LiveViewProducerClientPort } from "@agent/core";
import type { LiveScreencastPort } from "@agent/core";
import type { DesktopInputGateway } from "./desktop-input-gateway";
export type ScreenPermission = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export interface DesktopLiveStatus {
    enabled: boolean;
    permissionScreen: ScreenPermission;
    accessibilityTrusted: boolean | null;
    sessionOnline: boolean;
    controlState: LiveViewOwnershipState | null;
    error?: string;
}
export declare const DESKTOP_LIVE_SESSION_ID = "desktop:primary";
/** WebRTC signaling payload exchanged between the controller and this producer. */
export type WebrtcSignal = Record<string, unknown>;
/** Capture display choices published with the session metadata. */
export type LiveDisplayOptions = LiveViewDisplayOption[];
/** Holds the display awake while the live session has an active viewer (see DisplayKeepAwake). */
export type DisplayWakeControl = {
    start(): void;
    stop(): void;
};
type ClientFactory = () => LiveViewProducerClientPort | Promise<LiveViewProducerClientPort>;
type ProbeScreen = () => Promise<ScreenPermission> | ScreenPermission;
type ProbeAccessibility = () => Promise<boolean | null> | boolean | null;
/** Composition root that publishes the primary display as a live-view session and relays remote input. */
export declare class DesktopScreenLive {
    #private;
    private readonly clientFactory;
    private readonly screencast;
    private readonly input;
    private readonly metadata;
    private readonly probeScreen;
    private readonly probeAccessibility;
    private readonly keepAwake;
    private readonly sleep;
    private enabled;
    private enablePromise;
    private loopPromise;
    private currentClient;
    private unsubscribeState;
    private viewerCount;
    private readonly onWebrtcFromViewer;
    private readonly getDisplayOptions;
    private readonly onSetDisplay;
    private status;
    private readonly listeners;
    constructor({ clientFactory, screencast, input, probeScreen, probeAccessibility, keepAwake, sleep, onWebrtcFromViewer, getDisplayOptions, onSetDisplay }: {
        clientFactory: ClientFactory;
        screencast: LiveScreencastPort;
        input: DesktopInputGateway;
        probeScreen?: ProbeScreen;
        probeAccessibility?: ProbeAccessibility;
        keepAwake?: DisplayWakeControl | null;
        sleep?: (ms: number) => Promise<void>;
        /** Viewer→producer WebRTC signaling (start/answer/ICE/stop). */
        onWebrtcFromViewer?: (data: WebrtcSignal) => void;
        /** Capture display choices published with the session metadata. */
        getDisplayOptions?: () => LiveDisplayOptions | null;
        /** Applies a viewer's display switch and returns the refreshed options. */
        onSetDisplay?: ((displayId: string | null) => Promise<LiveDisplayOptions | null>) | null;
    });
    onStatus(listener: (status: DesktopLiveStatus) => void): () => void;
    getStatus(): DesktopLiveStatus;
    refreshPermissions(): Promise<DesktopLiveStatus>;
    enable(): Promise<DesktopLiveStatus>;
    disable(): Promise<DesktopLiveStatus>;
    /** Sends producer→controller WebRTC signaling over the current client. */
    relayWebrtcToViewer(data: WebrtcSignal): Promise<unknown>;
}
export {};
//# sourceMappingURL=desktop-screen-live.d.ts.map