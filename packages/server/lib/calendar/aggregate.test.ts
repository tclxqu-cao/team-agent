import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCalendarOverview } from "./aggregate";

const root = mkdtempSync(join(tmpdir(), "cal-test-"));
const codexHome = join(root, "codex");
const automation = join(codexHome, "automations", "wiki-raw");
mkdirSync(join(automation, "reports", "2026-11-02"), { recursive: true });
writeFileSync(join(automation, "automation.toml"), [
  'id = "wiki-raw"',
  'name = "Wiki 整理"',
  'status = "ACTIVE"',
  `created_at = ${new Date(2026, 10, 2, 0, 0).getTime()}`,
  'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO"',
  'cwds = ["/Users/a/wiki"]',
  'prompt = "整理 wiki"',
].join("\n"));
writeFileSync(join(automation, "reports", "2026-11-02", "completion.json"), JSON.stringify({
  completed_at: new Date(2026, 10, 2, 9, 30).toISOString(), validation: "passed",
  sources_processed: 4, pages_created: 2, pages_updated: 3,
}));
// A corrupt WorkBuddy database must degrade to an error badge, not sink the rest.
const workbuddyHome = join(root, "workbuddy");
mkdirSync(workbuddyHome, { recursive: true });
writeFileSync(join(workbuddyHome, "workbuddy.db"), "this is not a sqlite database");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const range = {
  fromMs: new Date(2026, 10, 1).getTime(),
  toMs: new Date(2026, 10, 30, 23, 59, 59).getTime(),
  nowMs: new Date(2026, 10, 17, 12, 0).getTime(),
};

describe("buildCalendarOverview", () => {
  it("buckets codex fires and runs into local days and degrades a corrupt source", async () => {
    const overview = await buildCalendarOverview({
      range, serverBaseDir: join(root, "empty"), projectRoots: [],
      homes: { codex: codexHome, claude: join(root, "none"), workbuddy: workbuddyHome, zcode: join(root, "none"), opencode: join(root, "none") },
      discoverDeepSeek: async () => null,
    });
    expect(overview.sources.codex.ok).toBe(true);
    expect(overview.sources.codex.entries).toBeGreaterThan(0);
    expect(overview.sources.workbuddy.ok).toBe(false);
    expect(overview.sources.workbuddy.error).toBeTruthy();
    expect(overview.sources.deepseek).toEqual({ ok: true, entries: 0, todos: 0 });

    const monday = overview.days["2026-11-02"] ?? [];
    expect(monday.some(e => e.kind === "cron" && e.state === "upcoming")).toBe(true);
    const run = monday.find(e => e.kind === "run");
    expect(run?.state).toBe("completed");
    expect(run?.detail).toContain("处理 4");
    // Five Mondays in November 2026.
    const cronFires = Object.values(overview.days).flat().filter(e => e.source === "codex" && e.kind === "cron");
    expect(cronFires.length).toBe(5);
  });

  it("returns an all-empty overview when no agent state exists", async () => {
    const overview = await buildCalendarOverview({
      range, serverBaseDir: join(root, "empty"), projectRoots: [],
      homes: { codex: join(root, "none"), claude: join(root, "none"), workbuddy: join(root, "none"), zcode: join(root, "none"), opencode: join(root, "none") },
      discoverDeepSeek: async () => null,
    });
    expect(Object.keys(overview.days)).toHaveLength(0);
    expect(overview.unscheduled).toHaveLength(0);
    for (const status of Object.values(overview.sources)) expect(status.ok).toBe(true);
  });
});