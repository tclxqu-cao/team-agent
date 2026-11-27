export interface DetachedNativeRuntimeHostOptions {
    directory: string;
    codexExecutable?: string;
    opencodeExecutable?: string;
    /** The built distribution to load; defaults to this package's bundled entry. */
    moduleUrl?: string;
    timeoutMs?: number;
}
/** Detached stdio and a stable cwd let native processes outlive a Web restart. */
export declare function startDetachedNativeRuntimeHost(options: DetachedNativeRuntimeHostOptions): Promise<number>;
//# sourceMappingURL=detached-native-runtime-host.d.ts.map