import type { ISessionStore, Session } from './entities.js';
import type { Message } from '../model/entities.js';
import type { AgentEvent } from '../agent/entities.js';
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export class InMemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(session: Session): Promise<Session> {
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async update(id: string, update: Partial<Session>): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    Object.assign(session, update, { updated: new Date().toISOString() });
    return session;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async list(projectId?: string): Promise<Session[]> {
    const all = Array.from(this.sessions.values());
    if (projectId) return all.filter((s) => s.projectId === projectId);
    return all;
  }

  async listChildren(parentId: string): Promise<Session[]> {
    return Array.from(this.sessions.values()).filter((s) => s.parentSessionId === parentId);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(message);
      session.updated = new Date().toISOString();
    }
  }

  async addEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.events.push(event);
    }
  }

  async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [...messages];
      session.updated = new Date().toISOString();
    }
  }
}

export class FileSystemSessionStore implements ISessionStore {
  private readonly sessionsDir: string;
  private readonly memory = new InMemorySessionStore();

  constructor(baseDir: string) {
    this.sessionsDir = join(baseDir, ".sessions");
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.sessionsDir, { recursive: true });
    } catch {
      // exists
    }
  }

  async create(session: Session): Promise<Session> {
    await this.ensureDir();
    await this.persistSession(session);
    return this.memory.create(session);
  }

  async get(id: string): Promise<Session | null> {
    // Check memory first
    const mem = await this.memory.get(id);
    if (mem) return mem;

    // Try to load from disk
    const filePath = join(this.sessionsDir, `${id}.json`);
    try {
      const content = await readFile(filePath, "utf-8");
      const session: Session = JSON.parse(content);
      await this.memory.create(session);
      return session;
    } catch {
      return null;
    }
  }

  async update(id: string, update: Partial<Session>): Promise<Session> {
    const session = await this.memory.update(id, update);
    await this.persistSession(session);
    return session;
  }

  async delete(id: string): Promise<void> {
    await this.memory.delete(id);
  }

  async list(projectId?: string): Promise<Session[]> {
    return this.memory.list(projectId);
  }

  async listChildren(parentId: string): Promise<Session[]> {
    return this.memory.listChildren(parentId);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await this.memory.addMessage(sessionId, message);
    const session = await this.memory.get(sessionId);
    if (session) await this.persistSession(session);
  }

  async addEvent(sessionId: string, event: AgentEvent): Promise<void> {
    await this.memory.addEvent(sessionId, event);
    const session = await this.memory.get(sessionId);
    if (session) await this.persistSession(session);
  }

  async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.memory.replaceMessages(sessionId, messages);
    const session = await this.memory.get(sessionId);
    if (session) await this.persistSession(session);
  }

  private async persistSession(session: Session): Promise<void> {
    await this.ensureDir();
    const filePath = join(this.sessionsDir, `${session.id}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
  }
}
