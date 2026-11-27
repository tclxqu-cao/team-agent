import type { NativeAgentType } from "@agent/core";
import type { NativeStdioCommand } from "./native-stdio-channel.js";
export type BridgedNativeAgentType = Extract<NativeAgentType, "qoder" | "zcode" | "workbuddy">;
interface Options {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    nodeExecutable?: string;
    fileExists?(path: string): Promise<boolean>;
    workBuddyDesktopConfig?(options: {
        configDir: string;
        platform: NodeJS.Platform;
    }): Promise<string | null>;
}
/** Resolves only entrypoints and child environment; native apps retain their credentials. */
export declare function resolveNativeCliCommand(agent: BridgedNativeAgentType, options?: Options): Promise<NativeStdioCommand>;
export {};
//# sourceMappingURL=native-cli-command.d.ts.map