import type { Message } from "../model/entities.js";
import type { SessionQueryIndex } from "./entities.js";
import { buildSessionQueryIndex, computeSessionHistoryRevision } from "./SessionQueryIndex.js";

export class SessionQueryIndexCache {
  private readonly entries = new Map<string, SessionQueryIndex>();

  constructor(private readonly capacity = 24) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Session query index cache capacity must be positive");
    }
  }

  getOrCreate(sessionId: string, messages: readonly Message[]): SessionQueryIndex {
    const revision = computeSessionHistoryRevision(messages);
    const cached = this.entries.get(sessionId);
    if (cached?.revision === revision) {
      this.entries.delete(sessionId);
      this.entries.set(sessionId, cached);
      return cached;
    }

    const created = buildSessionQueryIndex(sessionId, messages, revision);
    this.entries.delete(sessionId);
    this.entries.set(sessionId, created);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return created;
  }

  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }
}
