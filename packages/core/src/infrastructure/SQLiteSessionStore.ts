// ── SQLite Session Store ──
import type { ISessionStore, Session } from '../domain/session/entities.js';
import type { Message } from '../domain/model/entities.js';
import type { AgentEvent } from '../domain/agent/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteSessionStore implements ISessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async create(session: Session): Promise<Session> {
    const db = getDatabase(this.baseDir);
    // Use null for empty projectId to satisfy FK constraint
    const projectId = session.projectId || null;
    db.db.prepare(
      "INSERT INTO sessions (id, project_id, title, status, created, updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(session.id, projectId, session.title, session.status, session.created, session.updated, JSON.stringify(session.metadata));
    return session;
  }

  async get(id: string): Promise<Session | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSession(row);
  }

  async update(id: string, update: Partial<Session>): Promise<Session> {
    const db = getDatabase(this.baseDir);
    const existing = await this.get(id);
    if (!existing) throw new Error(`Session not found: ${id}`);
    const merged = { ...existing, ...update, updated: new Date().toISOString() };
    db.db.prepare("UPDATE sessions SET project_id=?, title=?, status=?, updated=?, metadata=? WHERE id=?")
      .run(merged.projectId, merged.title, merged.status, merged.updated, JSON.stringify(merged.metadata), id);
    return merged;
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    db.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async list(projectId?: string): Promise<Session[]> {
    const db = getDatabase(this.baseDir);
    let rows: Array<Record<string, unknown>>;
    if (projectId) {
      rows = db.db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated DESC").all(projectId) as Array<Record<string, unknown>>;
    } else {
      rows = db.db.prepare("SELECT * FROM sessions ORDER BY updated DESC").all() as Array<Record<string, unknown>>;
    }
    return rows.map((r) => this.rowToSession(r));
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, timestamp) VALUES (?,?,?,?,?,?,?)"
    ).run(
      sessionId, message.role, message.content ?? "",
      JSON.stringify(message.toolCalls ?? []),
      message.toolCallId ?? null, message.name ?? null,
      Date.now()
    );
  }

  async addEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT INTO events (session_id, type, data, timestamp) VALUES (?,?,?,?)"
    ).run(sessionId, event.type, JSON.stringify(event), Date.now());
  }

  private rowToSession(row: Record<string, unknown>): Session {
    const db = getDatabase(this.baseDir);
    const msgRows = db.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(row.id as string) as Array<Record<string, unknown>>;
    const evtRows = db.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id ASC").all(row.id as string) as Array<Record<string, unknown>>;

    return {
      id: row.id as string,
      projectId: (row.project_id as string | null) ?? "",
      title: row.title as string,
      status: row.status as Session["status"],
      messages: msgRows.map((m) => ({
        role: m.role as Message["role"],
        content: m.content as string,
        toolCalls: JSON.parse(m.tool_calls as string),
        toolCallId: m.tool_call_id as string | undefined,
        name: m.name as string | undefined,
      })),
      events: evtRows.map((e) => JSON.parse(e.data as string)),
      created: row.created as string,
      updated: row.updated as string,
      metadata: JSON.parse(row.metadata as string),
    };
  }
}
