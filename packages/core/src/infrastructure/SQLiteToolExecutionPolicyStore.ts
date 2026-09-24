import type Database from "better-sqlite3";
import {
  validateToolExecutionPolicy,
  type StoredToolExecutionPolicy,
  type ToolExecutionPolicy,
  type ToolExecutionPolicyStore,
} from "../domain/tool/execution-policy.js";
import { getDatabase } from "./SQLiteDatabase.js";

interface PolicyRow {
  id: string;
  name: string;
  enabled: number;
  definition: string;
  created: string;
  updated: string;
}

export class SQLiteToolExecutionPolicyStore implements ToolExecutionPolicyStore {
  private readonly db: Database;

  constructor(baseDirOrDatabase: string | Database) {
    this.db = typeof baseDirOrDatabase === "string"
      ? getDatabase(baseDirOrDatabase).db
      : baseDirOrDatabase;
  }

  async list(): Promise<StoredToolExecutionPolicy[]> {
    const rows = this.db.prepare(
      "SELECT id, name, enabled, definition, created, updated FROM tool_execution_policies ORDER BY name, id",
    ).all() as PolicyRow[];
    return rows.map(readRow);
  }

  async get(id: string): Promise<StoredToolExecutionPolicy | null> {
    const row = this.db.prepare(
      "SELECT id, name, enabled, definition, created, updated FROM tool_execution_policies WHERE id = ?",
    ).get(id) as PolicyRow | undefined;
    return row ? readRow(row) : null;
  }

  async save(value: ToolExecutionPolicy): Promise<StoredToolExecutionPolicy> {
    const policy = validateToolExecutionPolicy(value);
    const existing = this.db.prepare(
      "SELECT created FROM tool_execution_policies WHERE id = ?",
    ).get(policy.id) as { created: string } | undefined;
    const now = new Date().toISOString();
    const created = existing?.created ?? now;
    this.db.prepare(`
      INSERT INTO tool_execution_policies (id, name, enabled, definition, created, updated)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        definition = excluded.definition,
        updated = excluded.updated
    `).run(policy.id, policy.name, policy.enabled ? 1 : 0, JSON.stringify(policy), created, now);
    return { ...policy, created, updated: now };
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM tool_execution_policies WHERE id = ?").run(id).changes > 0;
  }
}

function readRow(row: PolicyRow): StoredToolExecutionPolicy {
  const parsed = validateToolExecutionPolicy(JSON.parse(row.definition));
  return {
    ...parsed,
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    created: row.created,
    updated: row.updated,
  };
}
