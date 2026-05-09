import type { ISessionStore, Session } from '../domain/session/entities.js';

export class ManageSessionUseCase {
  constructor(private readonly sessionStore: ISessionStore) {}

  async create(title: string, projectId = ""): Promise<Session> {
    return this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId,
      title,
      status: "idle",
      messages: [],
      events: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      metadata: {},
    });
  }

  async get(id: string): Promise<Session | null> {
    return this.sessionStore.get(id);
  }

  async list(): Promise<Session[]> {
    return this.sessionStore.list();
  }

  async delete(id: string): Promise<void> {
    return this.sessionStore.delete(id);
  }

  async complete(id: string): Promise<Session> {
    return this.sessionStore.update(id, {
      status: "completed",
      updated: new Date().toISOString(),
    });
  }

  async abort(id: string): Promise<Session> {
    return this.sessionStore.update(id, {
      status: "aborted",
      updated: new Date().toISOString(),
    });
  }
}
