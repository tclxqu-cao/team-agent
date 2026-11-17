import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { todoState, type CalendarEntry, type CalendarTodoGroup } from "@agent/core";
import { clip } from "./sqlite";
import type { CalendarRange, CalendarSourceResult } from "./types";

/** Claude Code scheduled-task skills (no machine-readable rule on disk, shown
 * as 未排期) and per-session task lists under ~/.claude/tasks/<uuid>/*.json. */
export async function readClaudeSource(range: CalendarRange, claudeHome: string): Promise<CalendarSourceResult> {
  const unscheduledSchedules: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];

  const scheduledRoot = join(claudeHome, "scheduled-tasks");
  for (const dir of await readdir(scheduledRoot, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    const skillPath = join(scheduledRoot, dir.name, "SKILL.md");
    const text = await readFile(skillPath, "utf8").catch(() => "");
    if (!text) continue;
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    const fields = new Map<string, string>();
    for (const line of (front?.[1] ?? "").split("\n")) {
      const eq = line.indexOf(":");
      if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    unscheduledSchedules.push({
      id: `claude:sched:${dir.name}`, kind: "cron", source: "claude",
      title: clip(fields.get("name") || dir.name, 80), at: 0, state: "unscheduled",
      scheduleLabel: "未排期",
      detail: clip(fields.get("description") || "", 200) || undefined,
    });
  }

  const tasksRoot = join(claudeHome, "tasks");
  const projectsRoot = join(claudeHome, "projects");
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const dir of await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    const sessionDir = join(tasksRoot, dir.name);
    const files = (await readdir(sessionDir).catch(() => [])).filter(name => name.endsWith(".json"));
    const todos: CalendarEntry[] = [];
    let updatedAt = 0;
    for (const file of files.slice(0, 200)) {
      const path = join(sessionDir, file);
      const info = await stat(path).catch(() => null);
      if (info) updatedAt = Math.max(updatedAt, info.mtimeMs);
      try {
        const task = JSON.parse(await readFile(path, "utf8")) as { id?: string; subject?: string; status?: string; description?: string };
        if (!task?.subject) continue;
        todos.push({
          id: `claude:${dir.name}:${task.id ?? file}`, kind: "todo", source: "claude",
          title: clip(task.subject, 120), at: 0,
          state: todoState(task.status ?? "pending", undefined, range.nowMs),
          detail: clip(task.description ?? "", 200) || undefined,
        });
      } catch { /* partial write */ }
    }
    if (!todos.length) continue;
    todos.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const meta = await findSessionMeta(projectsRoot, projectDirs.filter(d => d.isDirectory()).map(d => d.name), dir.name);
    groups.push({
      id: `claude:${dir.name}`, source: "claude",
      title: meta.title || `Claude · ${meta.cwd.split("/").pop() || dir.name.slice(0, 8)}`,
      cwd: meta.cwd || undefined, updatedAt, todos,
    });
  }
  return { entries: [], groups, unscheduledSchedules };
}

async function findSessionMeta(projectsRoot: string, projectDirs: string[], sessionId: string): Promise<{ title: string; cwd: string }> {
  for (const dir of projectDirs) {
    const path = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;
    const input = createReadStream(path);
    const reader = createInterface({ input, crlfDelay: Infinity });
    let title = "";
    let cwd = "";
    let lines = 0;
    try {
      for await (const line of reader) {
        if (++lines > 400 || (title && cwd)) break;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
        if (!title && row.type === "user") {
          const message = row.message as { content?: unknown } | undefined;
          const content = message?.content;
          const text = typeof content === "string" ? content
            : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join(" ") : "";
          const clean = text.replace(/<[^>]+>/g, " ").trim();
          if (clean && !clean.startsWith("Caveat")) title = clip(clean, 60);
        }
      }
    } catch { /* unreadable transcript */ } finally {
      reader.close();
      input.destroy();
    }
    return { title, cwd };
  }
  return { title: "", cwd: "" };
}