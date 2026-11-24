import { isAgentType } from "../../../core/src/domain/agent/agent-type";
import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";
import { includeSessionAncestors } from "./session-tree";

export const ALL_SESSIONS_CACHE_KEY = "agentroam.all-sessions.v2";
const FIRST_PAGE_SIZE = 20;
export interface AllSessionsCache { data: CatalogSession[]; total: number }

/** Restore summaries only. Server cursors expire and must come from a fresh page. */
export function readAllSessionsCache(storage?: Pick<Storage, "getItem">): AllSessionsCache | null {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const value: unknown = JSON.parse(target?.getItem(ALL_SESSIONS_CACHE_KEY) ?? "null");
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.data)
      || !value.data.every(isCatalogSession) || typeof value.total !== "number"
      || !Number.isSafeInteger(value.total) || value.total < value.data.length) return null;
    return { data: value.data, total: value.total };
  } catch {
    return null;
  }
}

export function writeAllSessionsCache(page: SessionCatalogPage, storage?: Pick<Storage, "setItem">): void {
  const data = includeSessionAncestors(page.data.slice(0, FIRST_PAGE_SIZE), [...page.data, ...(page.ancestors ?? [])]);
  writeCache({ data, total: page.total }, storage);
}

function writeCache(cache: AllSessionsCache, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(ALL_SESSIONS_CACHE_KEY, JSON.stringify({ version: 2, ...cache }));
  } catch {
    // Background refresh remains usable when browser storage is unavailable.
  }
}

export function removeSessionsFromAllSessionsCache(ids: readonly string[], storage?: Pick<Storage, "getItem" | "setItem">): void {
  const cached = readAllSessionsCache(storage);
  if (!cached) return;
  const removed = new Set(ids);
  const data = cached.data.filter(session => !removed.has(session.id));
  writeCache({ data, total: Math.max(data.length, cached.total - removed.size) }, storage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCatalogSession(value: unknown): value is CatalogSession {
  return isRecord(value) && typeof value.id === "string" && isAgentType(value.agentType)
    && typeof value.title === "string" && typeof value.cwd === "string" && typeof value.updated === "string"
    && (value.completedAt === undefined || typeof value.completedAt === "string")
    && typeof value.status === "string" && ["idle", "running", "completed", "failed"].includes(value.status)
    && typeof value.canResume === "boolean"
    && (value.projectId === undefined || typeof value.projectId === "string")
    && (value.parentSessionId === undefined || typeof value.parentSessionId === "string")
    && (value.readOnly === undefined || typeof value.readOnly === "boolean")
    && (value.occupancy === undefined || typeof value.occupancy === "string"
      && ["available", "owned-by-customer-agent", "owned-externally"].includes(value.occupancy));
}
