export declare const PRIMARY_DESKTOP_LIVE_ID = "cli-desktop:primary";
export interface DesktopRun {
    sessionId: string;
    runId: string;
    title?: string;
}
export interface DesktopActivity {
    owner: {
        kind: "agent";
        run: DesktopRun;
    } | {
        kind: "viewer";
    } | null;
    queue: DesktopRun[];
}
export declare class DesktopObservationRequired extends Error {
    readonly name = "DesktopObservationRequired";
    constructor();
}
export declare class DesktopControlCoordinator {
    private readonly idleMs;
    private nextLease;
    private agent;
    private viewer;
    private grantViewer;
    private idleTimer;
    private readonly queue;
    private readonly listeners;
    constructor(idleMs?: number);
    snapshot(): DesktopActivity;
    subscribe(listener: (activity: DesktopActivity) => void): () => void;
    execute<T>(run: DesktopRun, mutating: boolean, operation: (leaseId: number) => Promise<T>, signal?: AbortSignal): Promise<T>;
    endRun(runId: string): void;
    requestViewerControl(): Promise<() => void>;
    private acquire;
    private advance;
    private clearLease;
    private notify;
}
export declare function sharedDesktopControl(): DesktopControlCoordinator;
//# sourceMappingURL=desktop-control.d.ts.map