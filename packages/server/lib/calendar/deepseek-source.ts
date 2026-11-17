import { randomUUID } from "node:crypto";
import type { CalendarEntry } from "@agent/core";
import { clip } from "./sqlite";
import { EMPTY_RESULT, type CalendarRange, type CalendarSourceResult } from "./types";

export interface DeepSeekEndpoint { origin: string; cookie: string }
export type DeepSeekDiscover = () => Promise<DeepSeekEndpoint | null>;

const CACHE_KEY = "__agentCalendarDeepSeekEndpoint";
const CACHE_MS = 60_000;

/** Borrow-only DeepSeek Harness probe: never spawns a host. When no native
 * Host is listening the source simply reports zero entries. */
export async function readDeepSeekSource(
  range: CalendarRange,
  discover: DeepSeekDiscover,
  request: typeof fetch = fetch,
): Promise<CalendarSourceResult> {
  const cache = globalThis as Record<string, unknown>;
  const cached = cache[CACHE_KEY] as { at: number; endpoint: DeepSeekEndpoint | null } | undefined;
  let endpoint: DeepSeekEndpoint | null;
  if (cached && Date.now() - cached.at < CACHE_MS) endpoint = cached.endpoint;
  else {
    endpoint = await discover().catch(() => null);
    cache[CACHE_KEY] = { at: Date.now(), endpoint };
  }
  if (!endpoint) return EMPTY_RESULT;

  const rpcId = randomUUID();
  const response = await request(`${endpoint.origin}/api/schedule/catalog`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", cookie: endpoint.cookie },
    body: JSON.stringify({ type: "client-request", rpcId, method: "schedule/catalog", payload: { args: {} } }),
    signal: AbortSignal.timeout(2_500),
  }).catch(() => null);
  if (!response?.ok) return EMPTY_RESULT;
  const envelope = await response.json().catch(() => null) as Record<string, unknown> | null;
  const result = envelope?.result as { ok?: boolean; value?: unknown } | undefined;
  if (envelope?.type !== "server-response" || envelope.rpcId !== rpcId || result?.ok !== true) return EMPTY_RESULT;
  const value = result.value;
  const items = Array.isArray(value) ? value
    : Array.isArray((value as { items?: unknown[] })?.items) ? (value as { items: unknown[] }).items : [];

  const entries: CalendarEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? row.scheduleId ?? randomUUID());
    const at = typeof row.nextRunAt === "number" ? row.nextRunAt
      : typeof row.nextRunAt === "string" ? Date.parse(row.nextRunAt) : NaN;
    if (!Number.isFinite(at) || at < range.fromMs || at > range.toMs) continue;
    const active = row.enabled !== false && String(row.status ?? "active").toLowerCase() !== "paused";
    entries.push({
      id: `deepseek:${id}:${at}`, kind: "cron", source: "deepseek",
      title: clip(String(row.title ?? row.name ?? id), 80), at,
      state: active ? "upcoming" : "paused",
      scheduleLabel: typeof row.scheduleLabel === "string" ? row.scheduleLabel : typeof row.cron === "string" ? row.cron : undefined,
      detail: clip(String(row.prompt ?? ""), 200) || undefined,
    });
  }
  return { entries, groups: [] };
}