import { discoverHarnessEndpoint } from "@agent/native-runtime";
import { SQLiteProjectStore } from "@agent/core";
import { buildCalendarOverview } from "../../../lib/calendar/aggregate";
import { getAgentWorkingDirectory, getServerBaseDir } from "../../../lib/server-data-dir";
import { anonymousPrincipal } from "../../../lib/web-auth/anonymous";

export const dynamic = "force-dynamic";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_MS = 400 * 86_400_000;
const CACHE_MS = 15_000;
const CACHE_KEY = "__agentCalendarOverviewCache";

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function defaultRange(nowMs: number): { fromMs: number; toMs: number } {
  const now = new Date(nowMs);
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fromMs = startOfDay(first.getTime()) - ((first.getDay() + 6) % 7) * 86_400_000;
  const toMs = startOfDay(last.getTime()) + ((7 - last.getDay()) % 7) * 86_400_000 + 86_400_000 - 1;
  return { fromMs, toMs };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const nowMs = Date.now();
  let { fromMs, toMs } = defaultRange(nowMs);
  const fromParam = params.get("from");
  const toParam = params.get("to");
  if (fromParam && toParam && DATE_KEY.test(fromParam) && DATE_KEY.test(toParam)) {
    const from = Date.parse(`${fromParam}T00:00:00`);
    const to = Date.parse(`${toParam}T00:00:00`);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= MAX_SPAN_MS) {
      fromMs = from;
      toMs = to + 86_400_000 - 1;
    }
  }

  const cache = globalThis as Record<string, unknown>;
  const cached = cache[CACHE_KEY] as { key: string; at: number; body: unknown } | undefined;
  const key = `${fromMs}:${toMs}`;
  if (cached && cached.key === key && nowMs - cached.at < CACHE_MS) {
    return Response.json(cached.body, { headers: { "cache-control": "no-store" } });
  }

  const baseDir = getServerBaseDir();
  const projectRoots: string[] = await new SQLiteProjectStore(baseDir).list()
    .then(projects => projects.map(project => project.description).filter(path => path.startsWith("/")))
    .catch(() => [] as string[]);
  projectRoots.push(getAgentWorkingDirectory());

  const overview = await buildCalendarOverview({
    range: { fromMs, toMs, nowMs },
    serverBaseDir: baseDir,
    ownerId: anonymousPrincipal().userId,
    projectRoots,
    discoverDeepSeek: () => discoverHarnessEndpoint(),
  });
  cache[CACHE_KEY] = { key, at: nowMs, body: overview };
  return Response.json(overview, { headers: { "cache-control": "no-store" } });
}
