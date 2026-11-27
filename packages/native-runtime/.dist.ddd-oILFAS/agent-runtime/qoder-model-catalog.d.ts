import type { NativeStdioCommand } from "./native-stdio-channel.js";
import { type RuntimeModelInfo } from "./types.js";
export type QoderModelCatalogLoader = () => Promise<RuntimeModelInfo[]>;
type CatalogExecutor = (command: string, args: string[], options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    shell: false;
    windowsHide: true;
}) => Promise<{
    stdout: string;
}>;
/** Qoder CLI 1.1.85 emits a single MODEL column, even with JSON output requested. */
export declare function parseQoderModelCatalog(stdout: string): RuntimeModelInfo[];
/** Enumerate models without starting ACP or creating/resuming any native session. */
export declare function loadQoderModelCatalog(options?: {
    resolveCommand?: () => Promise<NativeStdioCommand>;
    execute?: CatalogExecutor;
}): Promise<RuntimeModelInfo[]>;
export {};
//# sourceMappingURL=qoder-model-catalog.d.ts.map