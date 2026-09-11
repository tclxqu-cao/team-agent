import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate-shared-customer-data.mjs";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "merge-customer-")); dirs.push(dir);
  const paths = [join(dir, "target.db"), join(dir, "source.db")];
  for (const path of paths) {
    const db = new Database(path); db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,status TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,content TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY,session_id TEXT,data TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`); db.close();
  }
  const source = new Database(paths[1]);
  source.exec(`INSERT INTO projects VALUES('old-project','Project','/project');
    INSERT INTO sessions VALUES('session','old-project','completed');
    INSERT INTO sessions VALUES('busy','old-project','active');
    INSERT INTO messages VALUES(1,'session','history');
    INSERT INTO events VALUES(1,'session','event');
    INSERT INTO settings VALUES('apiKey','source-secret');`); source.close();
  const target = new Database(paths[0]);
  target.exec(`INSERT INTO projects VALUES('cli-project','Project','/project'); INSERT INTO settings VALUES('apiKey','cli-secret');`); target.close();
  return paths;
}
describe("Customer Agent migration", () => {
  it("previews without writes, remaps projects, preserves CLI values, backs up and is idempotent", async () => {
    const [targetPath, sourcePath] = fixture();
    const preview = await migrate({ targetPath, sourcePaths: [sourcePath] });
    expect(preview.reports[0]).toMatchObject({ sessions: 1, messages: 1, activeSessionsSkipped: ["busy"] });
    const before = new Database(targetPath); expect(before.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 }); before.close();
    const applied = await migrate({ targetPath, sourcePaths: [sourcePath], apply: true });
    expect(applied.backup).toBeTruthy();
    const target = new Database(targetPath);
    expect(target.prepare("SELECT project_id FROM sessions WHERE id='session'").get()).toEqual({ project_id: "cli-project" });
    expect(target.prepare("SELECT value FROM settings WHERE key='apiKey'").get()).toEqual({ value: "cli-secret" }); target.close();
    const again = await migrate({ targetPath, sourcePaths: [sourcePath], apply: true }); expect(again.reports[0].sessions).toBe(0);
  });
});
