type DiscoveryExecutor = (command: string, args: string[], options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
}) => Promise<{
    stdout: string;
}>;
interface Options {
    configDir: string;
    platform?: NodeJS.Platform;
    execute?: DiscoveryExecutor;
}
/** Borrow the configuration published by the running desktop daemon, never its bootstrap catalog. */
export declare function discoverWorkBuddyDesktopProductConfig(options: Options): Promise<string | null>;
export {};
//# sourceMappingURL=workbuddy-desktop-config.d.ts.map