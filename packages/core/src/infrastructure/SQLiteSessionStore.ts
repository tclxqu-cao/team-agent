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
    // A stale/unknown projectId or parentSessionId must NOT crash session
    // creation with "FOREIGN KEY constraint failed". Resolve to null when the
    // referenced row does not exist so the session degrades to "no project" /
    // "root session" instead of throwing and losing the whole voice turn.
    const projectId = this.resolveProjectId(session.projectId);
    const parentId = this.resolveParentId(session.parentSessionId);
    db.db.prepare(
      "INSERT INTO sessions (id, project_id, parent_id, title, status, created, updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(session.id, projectId, parentId, session.title, session.status, session.created, session.updated, JSON.stringify(session.metadata));
    return session;
  }

  /** Returns projectId if the referenced project exists, otherwise null (FK-safe). */
  private resolveProjectId(projectId?: string): string | null {
    if (!projectId) return null;
    const db = getDatabase(this.baseDir);
    const exists = db.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (exists) return projectId;
    console.warn(`[SQLiteSessionStore] project_id "${projectId}" not found — storing session without project (FK-safe).`);
    return null;
  }

  /** Returns parentSessionId if the referenced session exists, otherwise null (FK-safe). */
  private resolveParentId(parentId?: string): string | null {
    if (!parentId) return null;
    const db = getDatabase(this.baseDir);
    const exists = db.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(parentId);
    if (exists) return parentId;
    console.warn(`[SQLiteSessionStore] parent_id "${parentId}" not found — storing session as root (FK-safe).`);
    return null;
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
      .run(this.resolveProjectId(merged.projectId), merged.title, merged.status, merged.updated, JSON.stringify(merged.metadata), id);
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

  async listChildren(parentId: string): Promise<Session[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM sessions WHERE parent_id = ? ORDER BY updated DESC").all(parentId) as Array<Record<string, unknown>>;
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

  async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    const db = getDatabase(this.baseDir);
    const insert = db.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, timestamp) VALUES (?,?,?,?,?,?,?)"
    );
    const tx = db.db.transaction(() => {
      db.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        insert.run(
          sessionId, m.role, m.content ?? "",
          JSON.stringify(m.toolCalls ?? []),
          m.toolCallId ?? null, m.name ?? null,
          Date.now() + i, // preserve ordering
        );
      }
    });
    tx();
  }

  private rowToSession(row: Record<string, unknown>): Session {
    const db = getDatabase(this.baseDir);
    const msgRows = db.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(row.id as string) as Array<Record<string, unknown>>;
    const evtRows = db.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id ASC").all(row.id as string) as Array<Record<string, unknown>>;

    return {
      id: row.id as string,
      projectId: (row.project_id as string | null) ?? "",
      parentSessionId: (row.parent_id as string | null) ?? undefined,
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
