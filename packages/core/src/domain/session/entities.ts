// ── Session Domain ──

import type { Message } from '../model/entities.js';
import type { AgentEvent } from '../agent/entities.js';

export type SessionStatus = "active" | "idle" | "completed" | "aborted";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  messages: Message[];
  events: AgentEvent[];
  created: string;
  updated: string;
  metadata: Record<string, unknown>;
}

export interface ISessionStore {
  create(session: Session): Promise<Session>;
  get(id: string): Promise<Session | null>;
  update(id: string, update: Partial<Session>): Promise<Session>;
  delete(id: string): Promise<void>;
  list(projectId?: string): Promise<Session[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  addEvent(sessionId: string, event: AgentEvent): Promise<void>;
}
