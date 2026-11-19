import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOpenCodeSource } from "./opencode-source";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const at = Date.parse("2026-11-19T12:00:00+08:00");
const range = { fromMs: at - 120_000, toMs: at + 120_000, nowMs: at };

describe("OpenCode calendar source", () => {
  it.each(["automation", "schedule", "neither"] as const)("reads the %s schema", async table => {
    const root = mkdtempSync(join(tmpdir(), "opencode-calendar-"));
    try {
      const db = new DatabaseSync(join(root, "opencode.db"));
      try {
        if (table === "automation") {
          db.exec("CREATE TABLE automation(id TEXT, session_id TEXT, directory TEXT, name TEXT, trigger TEXT, status TEXT, next_due_at INTEGER, last_run_at INTEGER, last_outcome TEXT)");
          db.prepare("INSERT INTO automation VALUES (?,?,?,?,?,?,?,?,?)").run("auto", "s1", "/workspace", "巡检", JSON.stringify({ type: "cron", cron: "0 12 * * *" }), "active", at + 60_000, at - 60_000, "failed");
        } else if (table === "schedule") {
          db.exec('CREATE TABLE schedule(id TEXT, session_id TEXT, name TEXT, action TEXT, "when" TEXT, status TEXT, next_due_at INTEGER, last_fired_at INTEGER, last_outcome TEXT, time_created INTEGER)');
          db.prepare("INSERT INTO schedule VALUES (?,?,?,?,?,?,?,?,?,?)").run("schedule", "s1", "巡检", "", "", "active", at + 60_000, at - 60_000, "failed", at - 120_000);
        }
      } finally {
        db.close();
      }
      const { entries } = await readOpenCodeSource(range, root);
      expect(entries.map(entry => [entry.kind, entry.title, entry.at, entry.state])).toEqual(table === "neither" ? [] : [
        ["cron", "巡检", at + 60_000, "upcoming"],
        ["run", "巡检", at - 60_000, "failed"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
