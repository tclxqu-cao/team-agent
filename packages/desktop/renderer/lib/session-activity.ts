import type { CatalogSession, SessionActivitySnapshot, SessionDashboardSnapshot } from "../../../core/src/domain/supervision/types";
import { AGENT_TYPES, isAgentType } from "../../../core/src/domain/agent/agent-type";
import { mergeCatalogSessions } from "./all-sessions";

export function applySessionActivity(rows: readonly CatalogSession[], activity: SessionActivitySnapshot | null, query = ""): CatalogSession[] {
  if (!activity) return [...rows];
  const known = new Set(activity.agentTypes);
  const fresh = new Map(activity.sessions.map(session => [session.id, session]));
  const merged = mergeCatalogSessions(rows.map(session => fresh.get(session.id) ?? (known.has(session.agentType) && session.status === "running"
    ? { ...session, status: "idle" as const } : session)), activity.sessions);
  const search = query.trim().toLocaleLowerCase();
  return merged.filter(session => `${session.title} ${session.cwd} ${session.agentType}`.toLocaleLowerCase().includes(search));
}

export function applyDashboardActivity(snapshot: SessionDashboardSnapshot | null, activity: SessionActivitySnapshot | null): SessionDashboardSnapshot | null {
  if (!activity) return snapshot;
  const sessions = applySessionActivity(snapshot?.agents.flatMap(agent => agent.sessions) ?? [], activity).filter(session => session.status === "running");
  return { ...(snapshot ?? { groups: [], groupTotal: 0 }), updatedAt: activity.updatedAt,
    agents: AGENT_TYPES.map(agentType => ({ agentType, sessions: sessions.filter(session => session.agentType === agentType) })) };
}

/** One poll and event subscription per frame, shared by all visible consumers. */
export function createSessionActivityStore(
  read: () => Promise<SessionActivitySnapshot>,
  listen: (listener: (event: unknown) => void) => () => void,
) {
  let server: SessionActivitySnapshot | null = null;
  let snapshot: SessionActivitySnapshot | null = null;
  const seen = new Map<string, CatalogSession>();
  const local = new Map<string, { session: CatalogSession; at: number; revision: number }>();
  let revision = 0;
  const subscribers = new Set<{ notify(): void; active: boolean }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: symbol | undefined;
  let unsubscribe: (() => void) | undefined;
  const active = () => [...subscribers].some(entry => entry.active);
  const publish = () => {
    if (server) {
      for (const session of applySessionActivity([...seen.values()], server)) seen.set(session.id, session);
    }
    for (const [id, entry] of local) seen.set(id, entry.session);
    if (seen.size > 256) {
      for (const [id, session] of seen) {
        if (seen.size <= 256) break;
        if (session.status !== "running") seen.delete(id);
      }
    }
    const rows = new Map(seen);
    snapshot = server || rows.size ? { sessions: [...rows.values()], agentTypes: server?.agentTypes ?? [], updatedAt: new Date().toISOString() } : null;
    subscribers.forEach(entry => entry.notify());
  };
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const event = value as Record<string, unknown>;
    const id = typeof event._sid === "string" ? event._sid : "";
    const supplied = event.type === "session_summary" ? event.session as CatalogSession | undefined : undefined;
    const current = supplied ?? snapshot?.sessions.find(session => session.id === id);
    if (!current || !isAgentType(current.agentType) || !current.id) return;
    let status = current.status;
    if (event.type === "run_admitted") status = "running";
    else if (event.type === "done") status = "completed";
    else if (event.type === "turn_aborted") status = "idle";
    else if (event.type === "error" && !event._preserveActiveRun) status = "failed";
    else if (event.type !== "session_summary") return;
    local.delete(current.id);
    local.set(current.id, { session: { ...current, status, updated: new Date().toISOString() }, at: Date.now(), revision: ++revision });
    if (local.size > 256) local.delete(local.keys().next().value!);
    publish();
  };
  const poll = async () => {
    if (!active() || pending) return;
    const token = Symbol();
    const startedRevision = revision;
    pending = token;
    try {
      const next = await read();
      if (pending !== token || !active()) return;
      if (!Array.isArray(next.sessions) || !Array.isArray(next.agentTypes)) return;
      server = next;
      const found = new Map(next.sessions.map(session => [session.id, session]));
      for (const [id, entry] of local) {
        if ((startedRevision >= entry.revision && found.get(id)?.status === entry.session.status) || Date.now() - entry.at > 30_000) local.delete(id);
      }
      publish();
    } catch { /* Keep visible state; the ordinary catalog owns load-error notices. */ }
    finally {
      if (pending === token) {
        pending = undefined;
        if (active()) timer = setTimeout(() => { void poll(); }, 2_000);
      }
    }
  };
  return {
    getSnapshot: () => snapshot,
    receive,
    subscribe(notify: () => void, enabled: boolean) {
      const entry = { notify, active: enabled };
      subscribers.add(entry);
      unsubscribe ??= listen(receive);
      if (enabled && !pending) { clearTimeout(timer); void poll(); }
      return () => {
        subscribers.delete(entry);
        if (!active()) { clearTimeout(timer); pending = undefined; }
        if (!subscribers.size) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
  };
}
