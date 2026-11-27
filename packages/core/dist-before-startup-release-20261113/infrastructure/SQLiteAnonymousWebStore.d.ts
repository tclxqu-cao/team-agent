export interface AnonymousWebPrincipal {
    userId: string;
    username: string;
}
export declare class SQLiteAnonymousWebStore {
    private readonly db;
    constructor(baseDir: string);
    getOrCreatePrincipal(): AnonymousWebPrincipal;
    issueWsNonce(nonce: string, userId: string, expiresAt: number, now?: number): void;
    consumeWsNonce(nonce: string, now?: number): string | null;
    private findPrincipal;
}
//# sourceMappingURL=SQLiteAnonymousWebStore.d.ts.map