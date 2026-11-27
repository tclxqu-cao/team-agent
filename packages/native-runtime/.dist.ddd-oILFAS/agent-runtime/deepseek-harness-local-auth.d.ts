/** Native browser-session v1 codec; reads only the local carrier grant, never model/account keys. */
export declare function createHarnessLocalCookie(origin: string, document: string, now?: number): string | null;
/** Reuse the current user's native browser grant without changing Harness's credentials store. */
export declare function readHarnessLocalCookie(origin: string, environment?: NodeJS.ProcessEnv): Promise<string | null>;
//# sourceMappingURL=deepseek-harness-local-auth.d.ts.map