import { spawn } from "node:child_process";
export interface RuntimeBootstrapStatus {
    phase: "idle" | "installing" | "ready" | "error";
    message: string;
}
/** Installs into the user's CLI data directory; never owns or stops the background service. */
export declare class DesktopRuntimeBootstrap {
    private readonly packaged;
    private readonly resourcesPath;
    private readonly executable;
    private readonly spawnWorker;
    private state;
    private pending;
    constructor(packaged: boolean, resourcesPath: string, executable?: string, spawnWorker?: typeof spawn);
    status(): RuntimeBootstrapStatus;
    prepare(): Promise<RuntimeBootstrapStatus>;
}
//# sourceMappingURL=runtime-bootstrap.d.ts.map