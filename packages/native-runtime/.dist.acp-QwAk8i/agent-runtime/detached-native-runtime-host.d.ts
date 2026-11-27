export interface DetachedNativeRuntimeHostOptions {
    directory: string;
    codexExecutable?: string;
    opencodeExecutable?: string;
    /** A packaged gateway may replace an older broker before serving requests. */
    packageVersion?: string;
    /** The built distribution to load; defaults to this package's bundled entry. */
    moduleUrl?: string;
    timeoutMs?: number;
}
/** Runs in the detached child while it holds the broker startup lock. */
export declare function prepareDetachedNativeRuntimeHost({ directory, packageVersion }: DetachedNativeRuntimeHostOptions): Promise<"reuse" | "start" | "replaced">;
/** Detached stdio and a stable cwd let native processes outlive a Web restart. */
export declare function startDetachedNativeRuntimeHost(options: DetachedNativeRuntimeHostOptions): Promise<number>;
//# sourceMappingURL=detached-native-runtime-host.d.ts.map