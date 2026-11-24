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

export const SESSION_VIEW_BATCH_SIZE = 256;

export interface SessionViewRepository {
  sync(afterRevision: number, views: readonly SessionView[], pageSize: number): SessionViewPage;
}

export function syncSessionViews(
  repository: SessionViewRepository,
  request: SessionViewSyncRequest,
  now: number,
): SessionViewPage {
  const views = request.views.map(view => ({ ...view, viewedAt: Math.min(view.viewedAt, now) }));
  return repository.sync(request.afterRevision, views, SESSION_VIEW_BATCH_SIZE);
}
