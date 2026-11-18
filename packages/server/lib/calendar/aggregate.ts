import { homedir } from "node:os";
import { join } from "node:path";
import {
  CALENDAR_SOURCES, localDateKey, reconcileCalendarEntries, sourceError,
  type CalendarEntry, type CalendarOverview, type CalendarRange, type CalendarSourceId, type CalendarSourceResult, type CalendarSourceStatus, type CalendarTodoGroup,
} from "@agent/core";
import { readClaudeSource } from "./claude-source";
import { readCodexSource } from "./codex-source";
import { readCustomerAgentSource } from "./customer-agent-source";
import { readDeepSeekSource, type DeepSeekDiscover } from "./deepseek-source";
import { readOpenCodeSource } from "./opencode-source";
import { readWorkBuddySource } from "./workbuddy-source";
import { readZCodeSource } from "./zcode-source";
import { readTodoCalendar } from "./todo-reminder-source";

export interface CalendarHomes {
  codex?: string;
  claude?: string;
  workbuddy?: string;
  zcode?: string;
  opencode?: string;
}

export interface BuildCalendarOptions {
  ownerId?: string;
  range: CalendarRange;
  serverBaseDir: string;
  projectRoots: string[];
  homes?: CalendarHomes;
  env?: NodeJS.ProcessEnv;
  discoverDeepSeek?: DeepSeekDiscover;
}

/** Fan out to every agent's on-disk state in parallel; one broken source
 * degrades to an error badge instead of sinking the whole calendar. */
export async function buildCalendarOverview(options: BuildCalendarOptions): Promise<CalendarOverview> {
  const env = options.env ?? process.env;
  const home = homedir();
  const homes = options.homes ?? {};
  const readers: Record<CalendarSourceId, () => Promise<CalendarSourceResult>> = {
    "customer-agent": () => readCustomerAgentSource(options.range, options.serverBaseDir, options.projectRoots),
    codex: () => readCodexSource(options.range, homes.codex ?? env.CODEX_HOME ?? join(home, ".codex")),
    claude: () => readClaudeSource(options.range, homes.claude ?? env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")),
    workbuddy: () => readWorkBuddySource(options.range, homes.workbuddy ?? env.WORKBUDDY_CONFIG_DIR ?? env.CODEBUDDY_CONFIG_DIR ?? join(home, ".workbuddy")),
    zcode: () => readZCodeSource(options.range, homes.zcode ?? env.ZCODE_HOME ?? join(home, ".zcode")),
    opencode: () => readOpenCodeSource(options.range, homes.opencode ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode")),
    deepseek: () => options.discoverDeepSeek
      ? readDeepSeekSource(options.range, options.discoverDeepSeek)
      : Promise.resolve({ entries: [], groups: [] }),
  };

  const results = await Promise.all(CALENDAR_SOURCES.map(async source => {
    try {
      return { source, result: await readers[source](), error: undefined as string | undefined };
    } catch (error) {
      return { source, result: { entries: [], groups: [] } as CalendarSourceResult, error: sourceError(source, error) };
    }
  }));

  const days: Record<string, CalendarEntry[]> = {};
  const unscheduled: CalendarTodoGroup[] = [];
  const unscheduledSchedules: CalendarEntry[] = [];
  const sources = {} as Record<CalendarSourceId, CalendarSourceStatus>;
  const sourceOrder = new Map(CALENDAR_SOURCES.map((source, index) => [source, index]));

  for (const { source, result, error } of results) {
    const own = source === "customer-agent" ? readTodoCalendar(options.range, options.serverBaseDir, options.ownerId) : [];
    const entries = reconcileCalendarEntries([...result.entries.filter(e => e.kind !== "todo"), ...own], options.range.nowMs);
    sources[source] = { ok: !error, ...(error ? { error } : {}), entries: entries.length, todos: 0 };
    for (const entry of entries) {
      const key = localDateKey(entry.at);
      (days[key] ??= []).push({ ...entry, ...(entry.scheduleId && !entry.scheduleRef ? { scheduleRef: `${entry.source}:${entry.scheduleId}` } : {}) });
    }
    unscheduledSchedules.push(...(result.unscheduledSchedules ?? []));
  }

  for (const entries of Object.values(days)) {
    entries.sort((a, b) => a.at - b.at || (sourceOrder.get(a.source) ?? 0) - (sourceOrder.get(b.source) ?? 0));
  }
  unscheduled.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return {
    from: localDateKey(options.range.fromMs),
    to: localDateKey(options.range.toMs),
    generatedAt: Date.now(),
    days, unscheduled, unscheduledSchedules, sources,
  };
}
