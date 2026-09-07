// ── Session Domain ──

import type { Message } from '../model/entities.js';
import type { AgentEvent } from '../agent/entities.js';

export type SessionStatus = "active" | "idle" | "completed" | "aborted" | "failed";

export interface Session {
  id: string;
  projectId: string;
  /** If set, this session is a sub-session spawned by a parent agent run */
  parentSessionId?: string;
  title: string;
  status: SessionStatus;
  messages: Message[];
  events: AgentEvent[];
  created: string;
  updated: string;
  metadata: Record<string, unknown>;
}

/** Opaque backward cursor used to request an older session-history window. */
export type SessionHistoryView = "core" | "trace";

export interface SessionHistoryQuery {
  before?: string;
  after?: string;
  anchor?: string;
  limit?: number;
  view?: SessionHistoryView;
  revision?: string;
  /** Native turn selected for on-demand execution-trace hydration. */
  turnId?: string;
}

export interface SessionToolResultRef {
  turnId: string;
  itemId: string;
  revision: string;
  byteSize: number;
  isError?: boolean;
}

export interface SessionToolResultBody extends SessionToolResultRef {
  content: string;
}

export interface SessionQueryIndexEntry {
  messageId: string;
  ordinal: number;
  preview: string;
  pageToken: string;
}

export interface SessionQueryIndex {
  sessionId: string;
  revision: string;
  totalQueries: number;
  entries: SessionQueryIndexEntry[];
}

export interface SessionHistoryWindow {
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
  totalItems: number;
  olderCursor?: string | null;
  newerCursor?: string | null;
  kind?: "latest" | "anchored";
  revision?: string;
  delivery?: SessionHistoryView | "legacy-full";
}

export interface SessionHistoryPage {
  messages: Message[];
  events: AgentEvent[];
  history: SessionHistoryWindow;
}

export interface ISessionStore {
  create(session: Session): Promise<Session>;
  get(id: string): Promise<Session | null>;
  update(id: string, update: Partial<Session>): Promise<Session>;
  delete(id: string): Promise<void>;
  list(projectId?: string): Promise<Session[]>;
  /** List direct children of a parent session */
  listChildren(parentId: string): Promise<Session[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  addEvent(sessionId: string, event: AgentEvent): Promise<void>;
  /** Replace all stored messages for a session (used to persist context compaction). System messages are excluded. */
  replaceMessages(sessionId: string, messages: Message[]): Promise<void>;
}
