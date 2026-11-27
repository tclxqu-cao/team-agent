export interface SessionView {
    sessionId: string;
    viewedAt: number;
}
export interface SessionViewPage {
    views: SessionView[];
    revision: number;
    hasMore: boolean;
}
export interface SessionViewSyncRequest {
    afterRevision: number;
    views: SessionView[];
}
export declare const SESSION_VIEW_BATCH_SIZE = 256;
export interface SessionViewRepository {
    sync(afterRevision: number, views: readonly SessionView[], pageSize: number): SessionViewPage;
}
export declare function syncSessionViews(repository: SessionViewRepository, request: SessionViewSyncRequest, now: number): SessionViewPage;
//# sourceMappingURL=SyncSessionViews.d.ts.map