import type { CatalogSession, SessionActivitySnapshot } from "@agent/core";
import type { AgentType, UnifiedSessionSummary } from "@agent/native-runtime";
import { agentHost } from "../app/api/agent-host";
import { getNativeRuntimeService } from "./native-runtime-service";
import { collaborationSessionIds } from "./collaboration/visibility";

type NativeActivity = { sessions: UnifiedSessionSummary[]; agentTypes: AgentType[] };
interface ActivityCache { value: NativeActivity; pending?: Promise<NativeActivity>; retryAt: number }
const shared = globalThis as typeof globalThis & { __nativeSessionActivity?: ActivityCache };

/** A stalled broker must not hold up local sessions or other viewers. */
async function nativeActivity(): Promise<NativeActivity> {
  const entry = shared.__nativeSessionActivity ??= { value: { sessions: [], agentTypes: [] }, retryAt: 0 };
  if (!entry.pending && entry.retryAt <= Date.now()) {
    const request = Promise.resolve().then(() => getNativeRuntimeService().liveSessions()).then(value => {
      entry.value = value;
      entry.retryAt = Date.now() + 500;
      return value;
    }, () => {
      entry.retryAt = Date.now() + 5_000;
      return entry.value;
    }).finally(() => { if (entry.pending === request) entry.pending = undefined; });
    entry.pending = request;
  }
  if (!entry.pending) return entry.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([entry.pending, new Promise<NativeActivity>(resolve => {
      timer = setTimeout(() => resolve(entry.value), 500);
    })]);
  } finally { clearTimeout(timer); }
}

export async function sessionActivity(options: { includeInternal?: boolean } = {}): Promise<SessionActivitySnapshot> {
  const store = agentHost.getSessionStore();
  const [native, summaries, projects] = await Promise.all([
    nativeActivity(),
    store.listSummaries ? store.listSummaries() : store.list(),
    agentHost.getProjectStore().list(),
  ]);
  const hidden = options.includeInternal ? new Set<string>() : collaborationSessionIds();
  const paths = new Map(projects.map(project => [project.id, project.description]));
  const recent = Date.now() - 60_000;
  const local: CatalogSession[] = summaries.filter(session => agentHost.isSessionRunning(session.id)
    || Date.parse(session.created) >= recent || Date.parse(session.updated) >= recent).map(session => ({
    id: session.id, agentType: "customer-agent", title: session.title, cwd: paths.get(session.projectId) ?? "",
    projectId: session.projectId, updated: session.updated,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    status: agentHost.isSessionRunning(session.id) ? "running" : session.status === "failed" ? "failed"
      : session.status === "completed" ? "completed" : "idle",
    canResume: true,
  }));
  const sessions = [...local, ...native.sessions.map((session): CatalogSession => ({
    id: session.id, agentType: session.agentType, title: session.title, cwd: session.cwd,
    projectId: session.projectId, updated: session.updated, completedAt: session.completedAt, status: session.status,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    canResume: session.canResume, occupancy: session.occupancy, readOnly: session.readOnly,
  }))].filter(session => !hidden.has(session.id));
  return { sessions, agentTypes: [...new Set<AgentType>(["customer-agent", ...native.agentTypes])], updatedAt: new Date().toISOString() };
}
