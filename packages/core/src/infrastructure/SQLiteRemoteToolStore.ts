import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from "../domain/remote-tools/entities.js";
import type { RemoteToolStore } from "../domain/remote-tools/RemoteToolStore.js";

function now(): string { return new Date().toISOString(); }
function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function jsonArray(value: unknown): string { return JSON.stringify(Array.isArray(value) ? value : []); }
function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function parseArray(value: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(value || "[]");
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

type ToolRow = {
  id: string; project_id: string; scheme: string; purpose: string; url: string; method: "POST";
  headers: string; input_schema: string; output_schema: string; examples: string; auth: string;
  enabled: number; created: string; updated: string;
};

type JobRow = {
  id: string; project_id: string; scheme: string; request_payload: string; status: RemoteToolJob["status"];
  response_payload: string | null; error: string | null; created: string; updated: string;
};

export class SQLiteRemoteToolStore implements RemoteToolStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  upsertTools(projectId: string, tools: RemoteToolRegistration[]): RemoteToolDefinition[] {
    const stamp = now();
    const stmt = this.db.prepare(`
      INSERT INTO remote_tools (id, project_id, scheme, purpose, url, method, headers, input_schema, output_schema, examples, auth, enabled, created, updated)
      VALUES (@id, @projectId, @scheme, @purpose, @url, @method, @headers, @inputSchema, @outputSchema, @examples, @auth, 1, @created, @updated)
      ON CONFLICT(project_id, scheme) DO UPDATE SET
        purpose = excluded.purpose,
        url = excluded.url,
        method = excluded.method,
        headers = excluded.headers,
        input_schema = excluded.input_schema,
        output_schema = excluded.output_schema,
        examples = excluded.examples,
        auth = excluded.auth,
        enabled = 1,
        updated = excluded.updated
    `);
    const tx = this.db.transaction(() => {
      for (const tool of tools) {
        stmt.run({
          id: crypto.randomUUID(), projectId, scheme: tool.scheme, purpose: tool.purpose, url: tool.url,
          method: tool.method ?? "POST", headers: JSON.stringify(tool.headers ?? {}), inputSchema: json(tool.inputSchema),
          outputSchema: json(tool.outputSchema), examples: jsonArray(tool.examples), auth: json(tool.auth), created: stamp, updated: stamp,
        });
      }
    });
    tx();
    return tools.map((tool) => this.getTool(projectId, tool.scheme)).filter(Boolean) as RemoteToolDefinition[];
  }

  listEnabledTools(projectId: string): RemoteToolDefinition[] {
    const rows = this.db.prepare("SELECT * FROM remote_tools WHERE project_id = ? AND enabled = 1 ORDER BY scheme").all(projectId) as ToolRow[];
    return rows.map((row) => this.mapTool(row));
  }

  getTool(projectId: string, scheme: string): RemoteToolDefinition | null {
    const row = this.db.prepare("SELECT * FROM remote_tools WHERE project_id = ? AND scheme = ? AND enabled = 1").get(projectId, scheme) as ToolRow | undefined;
    return row ? this.mapTool(row) : null;
  }

  createJob(projectId: string, scheme: string, requestPayload: Record<string, unknown>): RemoteToolJob {
    const stamp = now();
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO remote_tool_jobs (id, project_id, scheme, request_payload, status, created, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(id, projectId, scheme, JSON.stringify(requestPayload), stamp, stamp);
    return this.getJob(id)!;
  }

  markJobRunning(id: string): void { this.updateStatus(id, "running", null, null); }
  markJobSucceeded(id: string, responsePayload: Record<string, unknown>): void { this.updateStatus(id, "succeeded", JSON.stringify(responsePayload), null); }
  markJobFailed(id: string, error: string): void { this.updateStatus(id, "failed", null, error); }

  getJob(id: string): RemoteToolJob | null {
    const row = this.db.prepare("SELECT * FROM remote_tool_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  private updateStatus(id: string, status: RemoteToolJob["status"], responsePayload: string | null, error: string | null): void {
    this.db.prepare("UPDATE remote_tool_jobs SET status = ?, response_payload = COALESCE(?, response_payload), error = ?, updated = ? WHERE id = ?").run(status, responsePayload, error, now(), id);
  }

  private mapTool(row: ToolRow): RemoteToolDefinition {
    return { id: row.id, projectId: row.project_id, scheme: row.scheme, purpose: row.purpose, url: row.url, method: row.method, headers: parseObject(row.headers) as Record<string, string>, inputSchema: parseObject(row.input_schema), outputSchema: parseObject(row.output_schema), examples: parseArray(row.examples), auth: parseObject(row.auth), enabled: row.enabled === 1, createdAt: row.created, updatedAt: row.updated };
  }

  private mapJob(row: JobRow): RemoteToolJob {
    return { id: row.id, projectId: row.project_id, scheme: row.scheme, requestPayload: parseObject(row.request_payload), status: row.status, responsePayload: row.response_payload ? parseObject(row.response_payload) : null, error: row.error, createdAt: row.created, updatedAt: row.updated };
  }
}
