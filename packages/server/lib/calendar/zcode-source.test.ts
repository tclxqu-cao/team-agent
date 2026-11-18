import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { reconcileCalendarEntries } from "@agent/core";
import { readZCodeSource } from "./zcode-source";

it("uses ZCode's persisted hourly cadence and merges the run at scheduled_at", async () => {
  const root = mkdtempSync(join(tmpdir(), "calendar-zcode-"));
  mkdirSync(join(root, "v2"));
  const db = new DatabaseSync(join(root, "v2", "tasks-index.sqlite"));
  try {
    db.exec("CREATE TABLE automations(automation_id TEXT,title TEXT,cron_expr TEXT,prompt TEXT,schedule_rule TEXT,enabled INTEGER,lifecycle_status TEXT,next_run_at INTEGER,last_run_at INTEGER,workspace_path TEXT,recurring INTEGER,last_error TEXT,created_at INTEGER); CREATE TABLE automation_runs(run_id TEXT,automation_id TEXT,scheduled_at INTEGER,outcome TEXT,session_id TEXT,error TEXT,created_at INTEGER)");
    const day = new Date(2026, 10, 17).getTime();
    const hour = 3_600_000;
    db.prepare("INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("cli", "CLI 巡检", "0 */6 * * *", "", JSON.stringify({ unit: "hourly", interval: 6, anchorAt: day - 10 * hour }), 1, "active", day + 17 * hour, day + 11 * hour, "", 1, "", day - 10 * hour);
    db.prepare("INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?)").run("run", "cli", day + 11 * hour, "succeeded", "session", "", day + 11 * hour + 1000);
    const result = await readZCodeSource({ fromMs: day, toMs: day + 24 * hour - 1, nowMs: day + 14 * hour }, root);
    const entries = reconcileCalendarEntries(result.entries, day + 14 * hour);
    expect(entries.map(entry => new Date(entry.at).getHours())).toEqual([5, 11, 17, 23]);
    expect(entries.map(entry => entry.state)).toEqual(["overdue", "completed", "upcoming", "upcoming"]);
    expect(entries[1]?.sessionId).toBe("session");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
