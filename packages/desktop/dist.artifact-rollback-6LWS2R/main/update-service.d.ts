import { type UpdatePlatform, type UpdateStatus } from "@agent/core";
export interface DesktopUpdateDependencies {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    downloadsDirectory: string;
    reveal(path: string): void;
    fetch?: typeof fetch;
}
export declare class DesktopUpdateService {
    private readonly dependencies;
    private readonly checker;
    private status;
    private readonly listeners;
    private installPromise;
    constructor(dependencies: DesktopUpdateDependencies);
    schedule(): void;
    getStatus(): UpdateStatus;
    subscribe(listener: (status: UpdateStatus) => void): () => void;
    check(): Promise<UpdateStatus>;
    install(): Promise<UpdateStatus>;
    private download;
    private publish;
}
export declare function desktopPlatform(platform: NodeJS.Platform, arch: string): UpdatePlatform | null;
//# sourceMappingURL=update-service.d.ts.map