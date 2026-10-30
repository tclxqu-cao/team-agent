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
}
const liveHost = globalThis as typeof globalThis & { __liveNativeSessionCatalog?: LiveNativeCatalog };

/** Runtime list() is explicitly cached until invalidated. Live views must refresh
 * discovery; coalesce viewers and searches without turning every poll into a scan. */
function liveNativeSessions(): Promise<UnifiedSessionSummary[]> {
  const existing = liveHost.__liveNativeSessionCatalog;
  if (existing && (existing.pending || existing.expiresAt > Date.now())) return existing.promise;
  const entry: LiveNativeCatalog = { promise: Promise.resolve([]), pending: true, expiresAt: 0 };
  entry.promise = getNativeRuntimeService().refresh().then(sessions => {
    entry.pending = false;
    entry.expiresAt = Date.now() + 2000;
    return sessions;
  }, error => {
    if (liveHost.__liveNativeSessionCatalog === entry) delete liveHost.__liveNativeSessionCatalog;
    throw error;
  });
  liveHost.__liveNativeSessionCatalog = entry;
  return entry.promise;
}

/** Shared source for existing chat lists, the selector, and the running Dashboard. */
export async function discoverSessions(projectId?: string, refresh = false, options: { includeInternal?: boolean; live?: boolean } = {}) {
  const hidden = options.includeInternal ? new Set<string>() : collaborationSessionIds();
  const sessions = (await agentHost.getSessionStore().list(projectId)).filter(session => !hidden.has(session.id));
  const tagged = sessions.map(({ messages: _messages, events: _events, ...session }) => ({
    ...session,
    agentType: "customer-agent" as const,
    messageQueueVersion: 1 as const,
    canDelete: !agentHost.isSessionRunning(session.id),
    permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
  }));
  try {
    const service = getNativeRuntimeService();
    const native = options.live
      ? (await liveNativeSessions()).filter(session => !projectId || session.projectId === projectId)
      : refresh ? await service.refresh(projectId) : await service.list(projectId);
    return { sessions: [...tagged, ...native.filter(session => !hidden.has(session.id))] };
  } catch (error) {
    console.error("Native session discovery failed:", error);
    return { sessions: tagged, discoveryError: error instanceof Error ? error.message : "原生会话发现失败" };
  }
}

export async function catalogSessions(includeInternal = false): Promise<{ sessions: CatalogSession[]; discoveryError?: string }> {
  const discovered = await discoverSessions(undefined, false, { includeInternal, live: true });
  const projects = await agentHost.getProjectStore().list();
  const paths = new Map(projects.map(p => [p.id, p.description]));
  return { discoveryError: discovered.discoveryError, sessions: discovered.sessions.map(session => ({
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
export async function querySessionCatalog(input: { query?: string; cursor?: string; limit?: number }): Promise<SessionCatalogPage> {
  const query = (input.query ?? "").trim().toLocaleLowerCase();
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt < Date.now()) snapshots.delete(id);
  let id: string, offset = 0, snapshot: CatalogSnapshot | undefined;
  if (input.cursor) {
    const match = /^catalog\.([a-f0-9-]+)\.(\d+)$/.exec(input.cursor);
    if (!match) throw new Error("会话分页标记无效，请刷新");
    id = match[1]; offset = Number(match[2]); snapshot = snapshots.get(id);
    if (!snapshot || snapshot.query !== query || !Number.isSafeInteger(offset) || offset > snapshot.sessions.length) throw new Error("会话列表已更新，请刷新重新加载");
  } else {
    const { sessions, discoveryError } = await catalogSessions();
    if (discoveryError) throw new Error(`原生会话暂时不可用：${discoveryError}`);
    const filtered = sessions.filter(s => `${s.title} ${s.cwd} ${s.agentType}`.toLocaleLowerCase().includes(query));
    filtered.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
    snapshot = { sessions: filtered, query, expiresAt: Date.now() + 300_000 };
    id = randomUUID(); snapshots.set(id, snapshot);
    if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!);
  }
  const data = snapshot.sessions.slice(offset, offset + limit);
  return { data, nextCursor: offset + data.length < snapshot.sessions.length ? `catalog.${id}.${offset + data.length}` : null, total: snapshot.sessions.length };
}
