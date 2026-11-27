export type WebrtcSignal = Record<string, unknown>;
type SendToViewer = (data: WebrtcSignal) => Promise<unknown>;
export interface WebrtcLiveOptions {
    /** Path resolver for the capture page (dev assets vs packaged resources). */
    capturePagePath: () => string;
    preloadPath: () => string;
    /** Forwards producer→controller signaling through the live-view client. */
    sendToViewer: SendToViewer;
    /** While the peer connection carries the video, the JPEG loop stands by. */
    setStandby: (standby: boolean) => void;
    /** Logical dimensions of the selected Electron display. */
    captureSize?: () => {
        width: number;
        height: number;
    } | null;
    log?: (line: string) => void;
    now?: () => number;
}
/**
 * Owns the hidden capture window that publishes the primary display as a
 * WebRTC track (native resolution, hardware encode) and relays its signaling
 * between the renderer and the live-view controller.
 */
export declare class WebrtcLive {
    #private;
    private readonly options;
    private window;
    private closeTimer;
    private mediaTimer;
    private startAt;
    private connected;
    private readonly mediaPolicy;
    private requestedProfile;
    private receiverProfiles;
    private lastDecisionKey;
    constructor(options: WebrtcLiveOptions);
    /** Viewer→producer signaling entry (wired to DesktopScreenLive). */
    handleViewerSignal(data: WebrtcSignal): void;
    /** Stops capture unconditionally (control released, live disabled, app quit). */
    stop(): void;
    /** Re-captures with the current display choice. No-op when no stream is
     *  running — the next start already picks the fresh display. The viewer
     *  answers the new offer on its existing peer connection (renegotiation). */
    restart(): void;
}
/** Default path resolvers mirroring the desktop-input helper layout. */
export declare function defaultWebrtcCapturePagePath(dirname: string, isPackaged: boolean, resourcesPath: string): string;
export {};
//# sourceMappingURL=webrtc-live.d.ts.map