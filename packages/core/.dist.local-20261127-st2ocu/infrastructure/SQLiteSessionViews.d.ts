import type { SessionView, SessionViewPage, SessionViewRepository } from "../application/session/SyncSessionViews.js";
export declare class SQLiteSessionViews implements SessionViewRepository {
    private readonly baseDir;
    constructor(baseDir: string);
    sync(afterRevision: number, views: readonly SessionView[], pageSize: number): SessionViewPage;
}
//# sourceMappingURL=SQLiteSessionViews.d.ts.map