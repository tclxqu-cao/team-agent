import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIMPLE_TABLES = { memories: "name", mcp_servers: "id", skills: "name", agents: "id", lsp_servers: "id", uploads: "id" };
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const columns = (db, table) => db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((column) => column.name);

/** Preview and apply use the same algorithm against a SQLite snapshot. No source writes. */
export function mergeSource(target, source, sourcePath) {
  const report = { source: sourcePath, projects: 0, sessions: 0, messages: 0, events: 0, settings: 0, catalogs: 0, conflicts: [], activeSessionsSkipped: [] };
  const insert = (table, row, omit = []) => {
    const keys = columns(target, table).filter((key) => key in row && !omit.includes(key));
    target.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
  };
  const rows = (db, table) => columns(db, table).length ? db.prepare(`SELECT * FROM ${quote(table)}`).all() : [];
  const projectIds = new Map();
  const existingProjects = rows(target, "projects");
  for (const row of rows(source, "projects")) {
    const samePath = row.description && existingProjects.find((p) => p.description === row.description);
    if (samePath) { projectIds.set(row.id, samePath.id); continue; }
    const conflict = existingProjects.find((p) => p.id === row.id || p.name === row.name);
    if (conflict) { report.conflicts.push({ table: "projects", id: row.id, reason: "id-or-name-conflict" }); continue; }
    insert("projects", row); existingProjects.push(row); projectIds.set(row.id, row.id); report.projects++;
  }
  const importedSessions = new Set();
  const sessionRows = rows(source, "sessions");
  const existingSessions = new Set(rows(target, "sessions").map((s) => s.id));
  for (const row of sessionRows) {
    if (["active", "running"].includes(row.status)) { report.activeSessionsSkipped.push(row.id); continue; }
    if (existingSessions.has(row.id)) { report.conflicts.push({ table: "sessions", id: row.id, reason: "existing-session-preserved" }); continue; }
    if (row.project_id && !projectIds.has(row.project_id)) { report.conflicts.push({ table: "sessions", id: row.id, reason: "project-conflict" }); continue; }
    insert("sessions", { ...row, project_id: row.project_id ? projectIds.get(row.project_id) : null });
    importedSessions.add(row.id); existingSessions.add(row.id); report.sessions++;
  }
  for (const table of ["messages", "events"]) {
    for (const row of rows(source, table)) {
      if (!importedSessions.has(row.session_id)) continue;
      insert(table, row, ["id"]); report[table]++;
    }
  }
  for (const [table, key] of Object.entries(SIMPLE_TABLES)) {
    if (!columns(target, table).length) continue;
    for (const row of rows(source, table)) {
      if (target.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(key)} = ?`).get(row[key])) { report.conflicts.push({ table, id: row[key], reason: "existing-record-preserved" }); continue; }
      insert(table, row); report.catalogs++;
    }
  }
  for (const row of rows(source, "settings")) {
    if (row.key.startsWith("sharedSettings")) continue;
    const existing = target.prepare("SELECT value FROM settings WHERE key = ?").get(row.key);
    if (!existing) { insert("settings", row); report.settings++; continue; }
    if (row.key === "profiles") {
      const profiles = JSON.parse(existing.value); const imported = JSON.parse(row.value);
      if (!Array.isArray(profiles) || !Array.isArray(imported)) throw new Error("Invalid profiles; migration rolled back");
      for (const profile of imported) {
        if (profiles.some((p) => p.id === profile.id)) { report.conflicts.push({ table: "profiles", id: profile.id, reason: "cli-profile-preserved" }); continue; }
        profiles.push(profile); report.settings++;
      }
      target.prepare("UPDATE settings SET value = ? WHERE key = 'profiles'").run(JSON.stringify(profiles));
    } else if (existing.value !== row.value) report.conflicts.push({ table: "settings", id: row.key, reason: "cli-value-preserved" });
  }
  return report;
}

export async function migrate({ targetPath, sourcePaths, apply = false }) {
  targetPath = resolve(targetPath);
  if (!existsSync(targetPath)) throw new Error("Initialize the target service database before migrating");
  if (sourcePaths.some((path) => resolve(path) === targetPath)) throw new Error("Source and target must differ");
  const target = new Database(targetPath, { readonly: !apply, fileMustExist: true });
  let backup;
  try {
    // Preview mutates only a private in-memory clone, so multiple source previews
    // see conflicts against earlier sources exactly as an actual merge would.
    const temporary = apply ? null : mkdtempSync(join(tmpdir(), "agentroam-migration-"));
    if (temporary) await target.backup(join(temporary, "preview.db"));
    const working = apply ? target : new Database(join(temporary, "preview.db"));
    try {
      if (apply) {
        backup = `${targetPath}.before-unify-${Date.now()}.bak`;
        await target.backup(backup);
        chmodSync(backup, 0o600);
      }
      const reports = working.transaction(() => sourcePaths.map((path) => {
        const source = new Database(resolve(path), { readonly: true, fileMustExist: true });
        try { return source.transaction(() => mergeSource(working, source, resolve(path)))(); }
        finally { source.close(); }
      }))();
      return { applied: apply, target: targetPath, ...(backup ? { backup } : {}), reports };
    } finally { if (!apply) working.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  } finally { target.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const apply = args.includes("--apply");
  const values = args.filter((arg) => arg !== "--apply");
  if (values.length < 2) throw new Error("Usage: node scripts/migrate-shared-customer-data.mjs TARGET_DB SOURCE_DB... [--apply]");
  console.log(JSON.stringify(await migrate({ targetPath: values[0], sourcePaths: values.slice(1), apply }), null, 2));
}
