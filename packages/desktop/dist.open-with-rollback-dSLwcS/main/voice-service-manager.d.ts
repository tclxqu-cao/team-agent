import { type ChildProcess } from "node:child_process";
import { VoiceServiceClient } from "./voice-service-client.js";
export type ManagedVoiceProcess = Pick<ChildProcess, "kill" | "once">;
export type VoiceProvider = {
    kind: "native";
} | {
    kind: "service";
    source: "remote" | "local";
    client: VoiceServiceClient;
};
export declare function findVoiceServiceEntry(appPath: string, resourcesPath: string): string | null;
export declare function findVoiceServiceRuntime(options: {
    explicit: string | null;
    pathEnv: string | undefined;
    resourcesPath: string;
}): string | null;
export interface ManagerOptions {
    remoteUrl: string | null;
    remoteToken: string | null;
    localUrl: string;
    localToken: string | null;
    serviceEntry: string | null;
    runtimeExecutable: string | null;
    cwd: string;
    env: Record<string, string | undefined>;
    startupTimeoutMs?: number;
}
export declare function getLocalVoiceServiceLaunch(options: ManagerOptions): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
};
interface ManagerDependencies {
    probe: (url: string, token: string | null) => Promise<boolean>;
    startLocal: () => ManagedVoiceProcess;
}
export declare class VoiceServiceManager {
    private readonly options;
    private readonly dependencies;
    private managedProcess;
    private client;
    constructor(options: ManagerOptions, dependencies?: ManagerDependencies);
    connect(): Promise<VoiceProvider>;
    close(): void;
}
export {};
//# sourceMappingURL=voice-service-manager.d.ts.map