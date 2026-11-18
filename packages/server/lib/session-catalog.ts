import { randomUUID } from "node:crypto";
import { normalizeToolPermissionMode, type CatalogSession, type SessionCatalogPage } from "@agent/core";
import type { UnifiedSessionSummary } from "@agent/native-runtime";
import { agentHost } from "../app/api/agent-host";
import { getNativeRuntimeService } from "./native-runtime-service";
import { collaborationSessionIds } from "./collaboration/visibility";

interface LiveNativeCatalog {
  promise: Promise<UnifiedSessionSummary[]>;
  pending: boolean;
  expiresAt: number;
  sessions?: UnifiedSessionSummary[];
  failure?: { error: unknown };
}
const liveHost = globalThis as typeof globalThis & { __liveNativeSessionCatalog?: LiveNativeCatalog };
const LIVE_NATIVE_CATALOG_TTL_MS = 15_000;
const PICKER_REFRESH_WAIT_MS = 1_000;

/** Keep discovery shared and running after the picker stops waiting for it. */
async function pickerNativeSessions(entry: LiveNativeCatalog): Promise<UnifiedSessionSummary[]> {
  if (entry.sessions) return entry.sessions;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.promise,
      new Promise<UnifiedSessionSummary[]>(resolve => {
        timer = setTimeout(() => resolve(entry.sessions ?? []), PICKER_REFRESH_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runtime list() is explicitly cached until invalidated. Live views must refresh
 * discovery; coalesce viewers and searches without turning every poll into a scan. */
function liveNativeSessions(backgroundRefresh = false): Promise<UnifiedSessionSummary[]> | UnifiedSessionSummary[] {
  const existing = liveHost.__liveNativeSessionCatalog;
  if (existing?.sessions) {
    if (!existing.pending && existing.expiresAt <= Date.now()) {
      existing.pending = true;
      existing.promise = refreshLiveNativeCatalog(existing);
    }
    if (backgroundRefresh && existing.pending) {
      void existing.promise.catch(() => undefined);
      return existing.sessions;
    }
    // Status-sensitive consumers still await fresh activity; the picker
    // follows up in the background while cached tasks remain selectable.
    return existing.pending ? existing.promise : existing.sessions;
  }
  if (existing) return backgroundRefresh ? pickerNativeSessions(existing) : existing.promise;
  const entry: LiveNativeCatalog = { promise: Promise.resolve([]), pending: true, expiresAt: 0 };
  entry.promise = refreshLiveNativeCatalog(entry);
  liveHost.__liveNativeSessionCatalog = entry;
  return backgroundRefresh ? pickerNativeSessions(entry) : entry.promise;
}

function refreshLiveNativeCatalog(entry: LiveNativeCatalog): Promise<UnifiedSessionSummary[]> {
  return getNativeRuntimeService().refresh().then(sessions => {
    entry.sessions = sessions;
    // Match the visible list's polling interval so nearby viewers, searches
    // and run-state updates reuse discovery instead of repeatedly scanning it.
    entry.expiresAt = Date.now() + LIVE_NATIVE_CATALOG_TTL_MS;
    return sessions;
  }, error => {
    if (!entry.sessions) {
      // A bounded picker request may have returned already. Keep a late
      // failure until the next reader can report it and offer a retry.
      entry.failure = { error };
      throw error;
    }
    entry.expiresAt = Date.now() + LIVE_NATIVE_CATALOG_TTL_MS;
    console.warn("Native session catalog refresh failed; serving cached sessions:", error);
    return entry.sessions;
  }).finally(() => {
    entry.pending = false;
  });
}

/** Shared source for existing chat lists, the selector, and the running Dashboard. */
export async function discoverSessions(projectId?: string, refresh = false, options: { includeInternal?: boolean; live?: boolean; backgroundRefresh?: boolean } = {}) {
  const hidden = options.includeInternal ? new Set<string>() : collaborationSessionIds();
  const store = agentHost.getSessionStore();
  const summaries = store.listSummaries ? await store.listSummaries(projectId)
    : (await store.list(projectId)).map(({ messages: _messages, events: _events, ...summary }) => summary);
  const sessions = summaries.filter(session => !hidden.has(session.id));
  const tagged = sessions.map(session => ({
    ...session,
    agentType: "customer-agent" as const,
    messageQueueVersion: 1 as const,
    canDelete: !agentHost.isSessionRunning(session.id),
    permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
  }));
  try {
    const service = getNativeRuntimeService();
    const discoveredNative = options.live
      ? await liveNativeSessions(options.backgroundRefresh)
      : refresh ? await service.refresh(projectId) : await service.list(projectId);
    const native = discoveredNative.filter(session => (!projectId || session.projectId === projectId) && !hidden.has(session.id));
    const entry = liveHost.__liveNativeSessionCatalog;
    return { sessions: [...tagged, ...native],
      ...(options.backgroundRefresh && entry && (entry.pending || entry.sessions !== discoveredNative) ? { refreshing: true } : {}) };
  } catch (error) {
    const failed = liveHost.__liveNativeSessionCatalog;
    if (options.live && failed?.failure && failed.failure.error === error) delete liveHost.__liveNativeSessionCatalog;
    console.error("Native session discovery failed:", error);
    return { sessions: tagged, refreshing: false, discoveryError: error instanceof Error ? error.message : "原生会话发现失败" };
  }
}

export async function catalogSessions(includeInternal = false, backgroundRefresh = false): Promise<{ sessions: CatalogSession[]; discoveryError?: string; refreshing?: boolean }> {
  const discovered = await discoverSessions(undefined, false, { includeInternal, live: true, backgroundRefresh });
  const projects = await agentHost.getProjectStore().list();
  const paths = new Map(projects.map(p => [p.id, p.description]));
  return { discoveryError: discovered.discoveryError,
    ...(discovered.refreshing ? { refreshing: true } : {}),
    sessions: discovered.sessions.map(session => ({
    id: session.id, agentType: session.agentType, title: session.title || "未命名会话",
    cwd: "cwd" in session ? session.cwd : paths.get(session.projectId) || "",
    projectId: session.projectId, updated: session.updated,
    status: session.agentType === "customer-agent"
      ? agentHost.isSessionRunning(session.id) ? "running" : session.status === "failed" ? "failed" : session.status === "completed" ? "completed" : "idle"
      : session.status as CatalogSession["status"],
    canResume: "canResume" in session ? session.canResume : true,
    ...("occupancy" in session ? { occupancy: session.occupancy, readOnly: session.readOnly } : {}),
  })) };
}

interface CatalogSnapshot { sessions: CatalogSession[]; query: string; expiresAt: number }
const shared = globalThis as typeof globalThis & { __sessionCatalogSnapshots?: Map<string, CatalogSnapshot> };
const snapshots = shared.__sessionCatalogSnapshots ??= new Map();

/** Immutable five-minute result snapshots prevent reordering from skipping/duplicating pages. */
export async function querySessionCatalog(input: { query?: string; cursor?: string; limit?: number; backgroundRefresh?: boolean }): Promise<SessionCatalogPage> {
  const query = (input.query ?? "").trim().toLocaleLowerCase();
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt < Date.now()) snapshots.delete(id);
  let id: string, offset = 0, snapshot: CatalogSnapshot | undefined, refreshing = false;
  if (input.cursor) {
    const match = /^catalog\.([a-f0-9-]+)\.(\d+)$/.exec(input.cursor);
    if (!match) throw new Error("会话分页标记无效，请刷新");
    id = match[1]; offset = Number(match[2]); snapshot = snapshots.get(id);
    if (!snapshot || snapshot.query !== query || !Number.isSafeInteger(offset) || offset > snapshot.sessions.length) throw new Error("会话列表已更新，请刷新重新加载");
  } else {
    const result = await catalogSessions(false, input.backgroundRefresh);
    const { sessions, discoveryError } = result;
    refreshing = result.refreshing ?? false;
    if (discoveryError) throw new Error(`原生会话暂时不可用：${discoveryError}`);
    const filtered = sessions.filter(s => `${s.title} ${s.cwd} ${s.agentType}`.toLocaleLowerCase().includes(query));
    filtered.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
    snapshot = { sessions: filtered, query, expiresAt: Date.now() + 300_000 };
    id = randomUUID(); snapshots.set(id, snapshot);
    if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!);
  }
  const data = snapshot.sessions.slice(offset, offset + limit);
  return { data, nextCursor: offset + data.length < snapshot.sessions.length ? `catalog.${id}.${offset + data.length}` : null,
    total: snapshot.sessions.length, ...(refreshing ? { refreshing: true } : {}) };
}
