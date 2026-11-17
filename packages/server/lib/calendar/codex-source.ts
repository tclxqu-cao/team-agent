import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { todoState, type CalendarEntry, type CalendarTodoGroup } from "@agent/core";
import { describeRRule, expandRRule } from "./schedule-expand";
import { clip } from "./sqlite";
import { parseTomlSubset } from "./toml";
import type { CalendarRange, CalendarSourceResult } from "./types";

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const ROLLOUT_SCAN_WINDOW_MS = 14 * 86_400_000;
const ROLLOUT_FILE_CAP = 80;
const ROLLOUT_SIZE_CAP = 64 * 1024 * 1024;

/** Codex automations (automation.toml + RRULE), per-date execution reports and
 * the latest update_plan snapshot from recent rollout transcripts. */
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
      source: "codex" as const, title: name,
      scheduleLabel: rrule ? describeRRule(rrule) : undefined,
      cwd: cwds[0], detail: clip(typeof toml.prompt === "string" ? toml.prompt : "", 200),
    };
    for (const at of expandRRule(rrule, range.fromMs, range.toMs, { anchorMs: createdAt })) {
      entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, state: active ? "upcoming" : "paused", recurring: true });
    }

    const reportsRoot = join(root, "reports");
    const reports = await readdir(reportsRoot, { withFileTypes: true }).catch(() => []);
    for (const report of reports) {
      const date = report.isDirectory() ? report.name : report.name.replace(/\.md$/, "");
      if (!DATE_DIR.test(date)) continue;
      const dayMs = Date.parse(`${date}T00:00:00`);
      if (!Number.isFinite(dayMs) || dayMs > range.toMs || dayMs + 86_400_000 <= range.fromMs) continue;
      let at = dayMs;
      let detail: string | undefined;
      let failed = false;
      if (report.isDirectory()) {
        const completionPath = join(reportsRoot, report.name, "completion.json");
        const completionInfo = await stat(completionPath).catch(() => null);
        if (completionInfo) {
          at = completionInfo.mtimeMs;
          try {
            const completion = JSON.parse(await readFile(completionPath, "utf8")) as Record<string, unknown>;
            const completedAt = Date.parse(String(completion.completed_at ?? ""));
            if (Number.isFinite(completedAt)) at = completedAt;
            failed = String(completion.validation ?? "").toLowerCase() === "failed";
            detail = `处理 ${completion.sources_processed ?? "?"} · 新建 ${completion.pages_created ?? "?"} · 更新 ${completion.pages_updated ?? "?"}`;
          } catch { /* keep mtime placement */ }
        } else {
          at = (await stat(join(reportsRoot, report.name)).catch(() => null))?.mtimeMs ?? dayMs;
        }
      } else {
        const mdPath = join(reportsRoot, report.name);
        at = (await stat(mdPath).catch(() => null))?.mtimeMs ?? dayMs;
        const head = await readFile(mdPath, "utf8").then(text => text.split("\n").find(line => line.trim()) ?? "").catch(() => "");
        detail = clip(head.replace(/^#+\s*/, ""), 120) || undefined;
      }
      if (at < range.fromMs || at > range.toMs) continue;
      entries.push({ ...base, id: `${id}:run:${date}`, kind: "run", at, state: failed ? "failed" : "completed", scheduleLabel: undefined, detail });
    }
  }

  groups.push(...await scanRolloutPlans(join(codexHome, "sessions"), range));
  return { entries, groups };
}

interface RolloutPlan { step: string; status: string }

async function scanRolloutPlans(sessionsRoot: string, range: CalendarRange): Promise<CalendarTodoGroup[]> {
  const candidates: { path: string; mtime: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile() && item.name.startsWith("rollout-") && item.name.endsWith(".jsonl")) {
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs >= range.nowMs - ROLLOUT_SCAN_WINDOW_MS && info.size <= ROLLOUT_SIZE_CAP) {
          candidates.push({ path, mtime: info.mtimeMs });
        }
      }
    }
  };
  await walk(sessionsRoot, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);

  const groups: CalendarTodoGroup[] = [];
  for (const candidate of candidates.slice(0, ROLLOUT_FILE_CAP)) {
    let plan: RolloutPlan[] | null = null;
    let cwd = "";
    let sessionTitle = "";
    const input = createReadStream(candidate.path);
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.includes("update_plan") && !line.includes("session_meta") && !sessionTitle && !line.includes("user_message")) continue;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const payload = row.payload as Record<string, unknown> | undefined;
        if (!payload) continue;
        if (row.type === "session_meta" && typeof payload.cwd === "string") cwd = payload.cwd;
        if (!sessionTitle && payload.type === "user_message" && typeof payload.message === "string") {
          sessionTitle = clip(payload.message, 60);
        }
        if (payload.type === "function_call" && payload.name === "update_plan" && typeof payload.arguments === "string") {
          try {
            const args = JSON.parse(payload.arguments) as { plan?: RolloutPlan[] };
            if (Array.isArray(args.plan) && args.plan.length) plan = args.plan;
          } catch { /* partial write */ }
        }
      }
    } catch { /* unreadable transcript */ } finally {
      reader.close();
      input.destroy();
    }
    if (!plan) continue;
    const sessionId = candidate.path.split("/").pop()!.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    groups.push({
      id: `codex:${sessionId}`, source: "codex",
      title: sessionTitle || `Codex · ${cwd.split("/").pop() || sessionId.slice(0, 8)}`,
      cwd: cwd || undefined, updatedAt: candidate.mtime,
      todos: plan.map((item, index) => ({
        id: `codex:${sessionId}:${index}`, kind: "todo", source: "codex",
        title: clip(item.step || `步骤 ${index + 1}`, 120), at: 0,
        state: todoState(item.status, undefined, range.nowMs),
      })),
    });
  }
  return groups;
}