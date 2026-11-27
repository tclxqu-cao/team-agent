import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { type CodexDesktopEndpoint, type CodexDesktopEndpointResolver } from "./codex-desktop-endpoint.js";
export type CodexAppServerLaunchMode = "desktop" | "shared" | "standalone";
export type CodexAppServerConnection = ChildProcessWithoutNullStreams | CodexDesktopEndpoint;
export interface CodexAppServerLaunchAttempt {
    readonly mode: CodexAppServerLaunchMode;
    launch(): Promise<CodexAppServerConnection>;
}
export interface CodexAppServerLauncher {
    attempts(): readonly CodexAppServerLaunchAttempt[];
}
export interface CodexAppServerLauncherOptions {
    executable: string;
    environment: NodeJS.ProcessEnv;
    spawnProcess?: typeof spawn;
    startupTimeoutMs?: number;
}
export declare class DesktopCodexAppServerLauncher implements CodexAppServerLaunchAttempt {
    private readonly resolveEndpoint;
    readonly mode: "desktop";
    constructor(resolveEndpoint?: CodexDesktopEndpointResolver);
    launch(): Promise<CodexDesktopEndpoint>;
}
export declare class SharedCodexAppServerLauncher implements CodexAppServerLaunchAttempt {
    readonly mode: "shared";
    private readonly executable;
    private readonly environment;
    private readonly spawnProcess;
    private readonly startupTimeoutMs;
    constructor(options: CodexAppServerLauncherOptions);
    launch(): Promise<ChildProcessWithoutNullStreams>;
}
export declare class StandaloneCodexAppServerLauncher implements CodexAppServerLaunchAttempt {
    readonly mode: "standalone";
    private readonly executable;
    private readonly environment;
    private readonly spawnProcess;
    constructor(options: CodexAppServerLauncherOptions);
    launch(): Promise<ChildProcessWithoutNullStreams>;
}
export declare class FallbackCodexAppServerLauncher implements CodexAppServerLauncher {
    constructor(...attempts: CodexAppServerLaunchAttempt[]);
    private readonly launchAttempts;
    attempts(): readonly CodexAppServerLaunchAttempt[];
}
//# sourceMappingURL=codex-app-server-launcher.d.ts.map