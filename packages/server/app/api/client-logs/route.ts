import { serverLogger } from "../../../lib/global-logger";

export const dynamic = "force-dynamic";

// Browser / mobile clients POST caught errors here (window.onerror,
// unhandledrejection, ErrorBoundary). Intentionally accepts unauthenticated
// clients: auth breakage is exactly the kind of error worth recording.
// Rate limited per IP; payloads are size-capped so a broken client cannot
// spam the daily log file.

const MAX_ENTRIES_PER_REQUEST = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STACK_LENGTH = 8000;
const MAX_SOURCE_LENGTH = 40;
const MAX_DATA_JSON_LENGTH = 2000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateWindows = new Map<string, number[]>();

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function underRateLimit(ip: string, now: number): boolean {
  const window = (rateWindows.get(ip) ?? []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (window.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateWindows.set(ip, window);
    return false;
  }
  window.push(now);
  rateWindows.set(ip, window);
  if (rateWindows.size > 10_000) {
    for (const [key, stamps] of rateWindows) {
      if (stamps.every((ts) => now - ts >= RATE_LIMIT_WINDOW_MS)) rateWindows.delete(key);
      if (rateWindows.size <= 5_000) break;
    }
  }
  return true;
}

function clampString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

interface IncomingEntry {
  level?: unknown;
  message?: unknown;
  source?: unknown;
  error?: unknown;
  data?: unknown;
}

export async function POST(request: Request) {
  const now = Date.now();
  const ip = clientIp(request);
  if (!underRateLimit(ip, now)) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  let body: { entries?: unknown } & IncomingEntry;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const rawEntries = Array.isArray(body?.entries)
    ? (body.entries as unknown[]).slice(0, MAX_ENTRIES_PER_REQUEST)
    : [body as IncomingEntry];

  const logger = serverLogger();
  let accepted = 0;
  for (const raw of rawEntries) {
    const entry = raw as IncomingEntry;
    const message = clampString(entry.message, MAX_MESSAGE_LENGTH);
    if (!message) continue;
    const requested = typeof entry.level === "string" ? entry.level : "error";
    const level = requested === "fatal" || requested === "warn" ? requested : "error";
    const declaredSource = clampString(entry.source, MAX_SOURCE_LENGTH);
    const errorPayload = entry.error as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
    const error = errorPayload && typeof errorPayload === "object"
      ? {
          name: clampString(errorPayload.name, 200) ?? "Error",
          message: clampString(errorPayload.message, MAX_MESSAGE_LENGTH) ?? "",
          stack: clampString(errorPayload.stack, MAX_STACK_LENGTH),
        }
      : undefined;
    let data: unknown;
    if (entry.data !== undefined) {
      try {
        const json = JSON.stringify(entry.data);
        if (json && json.length <= MAX_DATA_JSON_LENGTH) data = JSON.parse(json);
      } catch {
        data = undefined;
      }
    }
    logger.log(level, message, error, { clientIp: ip, clientSource: declaredSource ?? "webapp", data });
    accepted++;
  }
  return Response.json({ accepted }, { headers: { "cache-control": "no-store" } });
}
