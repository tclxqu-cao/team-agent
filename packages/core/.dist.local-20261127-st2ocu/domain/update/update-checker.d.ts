import { type UpdatePlatform, type UpdateStatus } from "./update-release.js";
import { type AppUpdateTarget } from "./app-release.js";
export declare const UPDATE_CHECK_INTERVAL_MS: number;
export type UpdateCheckerOptions = ({
    client: "cli";
    platform: UpdatePlatform;
} | AppUpdateTarget) & {
    currentVersion: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    random?: () => number;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    timeoutMs?: number;
    intervalMs?: number;
};
export declare class UpdateChecker {
    private readonly options;
    private status;
    private checkedAt;
    private readonly registryCache;
    private inFlight;
    private readonly fetchImpl;
    private readonly now;
    private readonly random;
    private readonly setTimer;
    private readonly timeoutMs;
    private readonly intervalMs;
    private readonly listeners;
    private scheduled;
    constructor(options: UpdateCheckerOptions);
    getStatus(): UpdateStatus;
    subscribe(listener: (status: UpdateStatus) => void): () => void;
    schedule(): void;
    private scheduleAfterInterval;
    refresh(options?: {
        force?: boolean;
    }): Promise<UpdateStatus>;
    private runRefresh;
    private readCliRelease;
    private readRegistryCandidate;
    private publish;
}
//# sourceMappingURL=update-checker.d.ts.map