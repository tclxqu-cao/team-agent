type OpenSessionFileExecutor = (command: string, args: string[], options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
}) => Promise<{
    stdout: string;
}>;
interface OpenSessionFileOptions {
    excludePids?: Iterable<number>;
    idleAfterMs?: number | null;
    platform?: NodeJS.Platform;
    execute?: OpenSessionFileExecutor;
    nowMs?: number;
    getMtimeMs?: (file: string) => number;
}
type OpenSessionFileSelectionOptions = OpenSessionFileOptions;
export declare function selectOpenSessionFiles(stdout: string, root: string, options?: OpenSessionFileSelectionOptions): Set<string>;
export declare function listOpenSessionFiles(commandName: "codex" | "claude", root: string, options?: OpenSessionFileOptions): Promise<Set<string>>;
export {};
//# sourceMappingURL=native-processes.d.ts.map