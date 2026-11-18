import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describeRRule, expandRRule, localDateKey, type CalendarEntry, type CalendarRange, type CalendarSourceResult, type CalendarTodoGroup } from "@agent/core";
import { clip } from "./sqlite";
import { parseTomlSubset } from "./toml";

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** Codex automations (automation.toml + RRULE), per-date execution reports and
 * no session plan transcripts. */
export async function readCodexSource(range: CalendarRange, codexHome: string): Promise<CalendarSourceResult> {
  const entries: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];
  const automationsRoot = join(codexHome, "automations");
  const automationDirs = await readdir(automationsRoot, { withFileTypes: true }).catch(() => []);

  for (const dir of automationDirs) {
    if (!dir.isDirectory()) continue;
    const root = join(automationsRoot, dir.name);
    const tomlPath = join(root, "automation.toml");
    const info = await stat(tomlPath).catch(() => null);
    if (!info) continue;
    const toml = parseTomlSubset(await readFile(tomlPath, "utf8"));
    const id = typeof toml.id === "string" ? toml.id : dir.name;
    const name = clip(typeof toml.name === "string" ? toml.name : id, 80);
    const rrule = typeof toml.rrule === "string" ? toml.rrule : "";
    const active = String(toml.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    const cwds = Array.isArray(toml.cwds) ? toml.cwds.filter((c): c is string => typeof c === "string") : [];
    const createdAt = typeof toml.created_at === "number" ? toml.created_at : info.mtimeMs;
    const base = {
      source: "codex" as const, title: name, scheduleId: id,
      scheduleLabel: rrule ? describeRRule(rrule) : undefined,
      cwd: cwds[0], detail: clip(typeof toml.prompt === "string" ? toml.prompt : "", 200),
    };
    const fires = expandRRule(rrule, Math.max(range.fromMs, createdAt), range.toMs, { anchorMs: createdAt });
    for (const at of fires) {
      entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, scheduledAt: at, state: active ? "upcoming" : "paused", recurring: true });
    }

    const reportsRoot = join(root, "reports");
    const reports = await readdir(reportsRoot, { withFileTypes: true }).catch(() => []);
    const reportDates = new Set(reports.map(report => report.isDirectory() ? report.name : report.name.replace(/\.md$/, "")).filter(date => DATE_DIR.test(date)));
    for (const date of reportDates) {
      const dayMs = Date.parse(`${date}T00:00:00`);
      if (!Number.isFinite(dayMs) || dayMs > range.toMs || dayMs + 86_400_000 <= range.fromMs) continue;
      let at = dayMs;
      let detail: string | undefined;
      let failed = false;
      const completionPath = join(reportsRoot, date, "completion.json");
      const completionText = await readFile(completionPath, "utf8").catch(() => null);
      if (completionText !== null) {
        let completion: Record<string, unknown>;
        try { completion = JSON.parse(completionText) as Record<string, unknown>; } catch { continue; }
        const completedAt = Date.parse(String(completion.completed_at ?? ""));
        if (!Number.isFinite(completedAt)) continue;
        at = completedAt;
        failed = String(completion.validation ?? "").toLowerCase() === "failed";
        detail = `处理 ${completion.sources_processed ?? "?"} · 新建 ${completion.pages_created ?? "?"} · 更新 ${completion.pages_updated ?? "?"}`;
      } else {
        const mdPath = join(reportsRoot, `${date}.md`);
        const text = await readFile(mdPath, "utf8").catch(() => "");
        if (!text.trim()) continue;
        at = (await stat(mdPath)).mtimeMs;
        detail = clip(text.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "") ?? "", 120) || undefined;
      }
      const scheduledFires = fires.filter(fire => localDateKey(fire) === date);
      const scheduledAt = scheduledFires.length === 1 ? scheduledFires[0] : undefined;
      if (scheduledAt === undefined && (at < range.fromMs || at > range.toMs)) continue;
      entries.push({ ...base, id: `${id}:run:${date}`, kind: "run", at, scheduledAt, executedAt: at, state: failed ? "failed" : "completed", scheduleLabel: undefined, detail });
    }
  }

  return { entries, groups };
}
