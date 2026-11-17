import { homedir } from "node:os";
import { join } from "node:path";
import {
  CALENDAR_SOURCES, localDateKey,
  type CalendarEntry, type CalendarOverview, type CalendarSourceId, type CalendarSourceStatus, type CalendarTodoGroup,
} from "@agent/core";
import { readClaudeSource } from "./claude-source";
import { readCodexSource } from "./codex-source";
import { readCustomerAgentSource } from "./customer-agent-source";
import { readDeepSeekSource, type DeepSeekDiscover } from "./deepseek-source";
import { readOpenCodeSource } from "./opencode-source";
import { sourceError, type CalendarRange, type CalendarSourceResult } from "./types";
import { readWorkBuddySource } from "./workbuddy-source";
import { readZCodeSource } from "./zcode-source";

export interface CalendarHomes {
  codex?: string;
  claude?: string;
  workbuddy?: string;
  zcode?: string;
  opencode?: string;
}

export interface BuildCalendarOptions {
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
    const datedTodos = result.entries.filter(entry => entry.kind === "todo").length;
    const groupTodos = result.groups.reduce((sum, group) => sum + group.todos.length, 0);
    sources[source] = { ok: !error, ...(error ? { error } : {}), entries: result.entries.length, todos: datedTodos + groupTodos };
    for (const entry of result.entries) {
      const key = localDateKey(entry.at);
      (days[key] ??= []).push(entry);
    }
    unscheduled.push(...result.groups);
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