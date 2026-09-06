import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cancelQueuedSessionMessage,
  cancelSessionGoal,
  enqueueSessionGoal,
  enqueueSessionMessage,
  finishActiveSessionGoal,
  mergeReasoningSummaryDelta,
  NEW_SESSION_PLACEHOLDER_TITLE,
  normalizeToolPermissionMode,
  paginateSessionHistory,
  promoteNextSessionQueueItem,
  queuedSessionMessages,
  readSessionGoalState,
  reorderQueuedSessionGoals,
  reorderQueuedSessionMessages,
  sessionQueueItemKind,
  SQLiteDatabase,
  SessionQueryIndexCache,
  StaleSessionAnchorError,
  updateQueuedSessionMessage,
  type AgentEvent,
  type Message,
  type SessionGoal,
  type SessionGoalState,
  type SessionMessagePayload,
  type SessionHistoryQuery,
  type SessionQueryIndex,
  type ToolPermissionMode,
} from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { normalizeAgentWorkspacePath, workspacePageSize } from "./agent-workspace-index.js";
import { ClaudeRuntimeAdapter } from "./claude-runtime-adapter.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  CodexSessionDiskCatalog,
  type CodexDiskSessionCatalogEntry,
  type CodexSessionCatalogRepository,
} from "./codex-session-disk-catalog.js";
import { CodexSessionCompatibilityService } from "./codex-session-compatibility.js";
import { CodexRuntimeAdapter } from "./codex-runtime-adapter.js";
import { OpenCodeRuntimeAdapter } from "./opencode-runtime-adapter.js";
import { OpenCodeServerClient } from "./opencode-server-client.js";
import { decodeUnifiedSessionId, encodeUnifiedSessionId } from "./session-id.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  AgentWorkspace,
  CreateRuntimeSessionOptions,
  ImportedAgentWorkspace,
  ImportedAgentWorkspaceRepository,
  ImportAgentWorkspaceResult,
  NativeReasoningEffort,
  RuntimeHealth,
  RuntimeModelInfo,
  RuntimeModelSelection,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  SessionCompatibility,
  SessionOccupancy,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";
import {
  shouldReuseSessionDetailCache,
  UnifiedSessionService,
} from "./unified-session-service.js";

const BROKER_SOCKET_NAME = "native-runtime.sock";
const EXTERNAL_OBSERVATION_DEBOUNCE_MS = 5_000;
const TERMINAL_RETENTION_MS = 10 * 60_000;
const ABORT_FALLBACK_MS = 3_000;

type NativeAgentType = Exclude<AgentType, "customer-agent">;
export type NativeRuntimeController = "web" | "desktop";

export interface BrokerRunEvent {
  runId: string;
  sequence: number;
  event: AgentEvent;
}

export interface BrokerRunStart {
  runId: string;
  snapshotRevision: number;
  permissionMode: ToolPermissionMode;
}

export interface BrokerGoalEnqueueResult {
  state: SessionGoalState;
  started?: BrokerRunStart;
}

export interface BrokerMessageSteerResult {
  steered: boolean;
  state: SessionGoalState;
}

export interface BrokerQueuedMessageInput {
  sourceMessageId: string;
  content: string;
  messagePayload?: SessionMessagePayload;
}

export interface NativeRuntimeBrokerSnapshot {
  sessionId: string;
  runId: string | null;
  snapshotRevision: number;
  events: BrokerRunEvent[];
  controller: NativeRuntimeController | null;
}

export interface NativeRuntimeBrokerCallbacks {
  onApprovalResolved(questionId: string): void;
  importedWorkspaceRepository: ImportedAgentWorkspaceRepository;
  codexSessionCatalogRepository: CodexSessionCatalogRepository;
}

export type NativeRuntimeBrokerRuntimeFactory = (
  callbacks: NativeRuntimeBrokerCallbacks,
) => UnifiedSessionService;

export interface NativeRuntimeBrokerOptions {
  directory?: string;
  runtimeFactory?: NativeRuntimeBrokerRuntimeFactory;
  now?: () => number;
}

interface BrokerRunRecord {
  sessionId: string;
  runId: string;
  agentType: NativeAgentType;
  nativeSessionId: string;
  input: string;
  permissionMode: ToolPermissionMode;
  controller: NativeRuntimeController;
  status: "active" | "terminal";
  nextSequence: number;
  createdAt: number;
  terminalAt: number | null;
  goalId: string | null;
}

interface BrokerLockRecord {
  sessionId: string;
  occupancy: SessionOccupancy;
  revision: number;
  sampleState: "occupied" | "clean" | null;
  sampleAt: number | null;
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
}

interface BrokerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface BrokerSubscription {
  sessionId: string;
  runId: string | null;
  afterSequence: number;
}

interface LocalBrokerSubscription extends BrokerSubscription {
  listener: (event: BrokerRunEvent) => void;
}

interface StoredRunRow {
  session_id: string;
  run_id: string;
  agent_type: NativeAgentType;
  native_session_id: string;
  input: string;
  permission_mode: ToolPermissionMode;
  controller: NativeRuntimeController;
  status: "active" | "terminal";
  next_sequence: number;
  created_at: number;
  terminal_at: number | null;
  goal_id?: string | null;
}

interface StoredEventRow {
  run_id: string;
  sequence: number;
  payload: string;
}

interface StoredTurnCompletionRow {
  run_id: string;
  session_id: string;
  input: string;
  final_text: string;
  duration_ms: number;
  completed_at: number;
}

interface StoredImportedWorkspaceRow {
  workspace_id: string;
  agent_type: NativeAgentType;
  normalized_path: string;
  name: string;
  created_at: number;
}

interface StoredLockRow {
  session_id: string;
  occupancy: SessionOccupancy;
  revision: number;
  sample_state: "occupied" | "clean" | null;
  sample_at: number | null;
}

interface StoredCodexCatalogRow {
  canonical_path: string;
  size: number;
  mtime_ns: string;
  native_session_id: string;
  probeable: number;
  producer_version: string | null;
  cwd: string;
  created: string;
  updated: string;
  parent_session_id: string | null;
  format_key: string | null;
  compatibility: string;
}

interface SnapshotProjection {
  run: BrokerRunRecord | null;
  events: BrokerRunEvent[];
}

/**
 * Durable state owned by exactly one local broker. The socket makes this a
 * cross-process boundary while SQLite makes page reloads independent of a
 * particular Next.js route or Electron renderer instance.
 */
class NativeRuntimeBrokerState implements ImportedAgentWorkspaceRepository, CodexSessionCatalogRepository {
  private readonly database: SQLiteDatabase;

  constructor(
    directory: string,
    private readonly now: () => number,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Best effort on filesystems without POSIX modes. */ }
    this.database = new SQLiteDatabase(directory);
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS native_runtime_policy (
        session_id TEXT PRIMARY KEY,
        permission_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_run (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        input TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        controller TEXT NOT NULL,
        status TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        terminal_at INTEGER,
        goal_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS native_runtime_active_run_per_session
        ON native_runtime_run(session_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS native_runtime_runs_by_session
        ON native_runtime_run(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS native_runtime_turn_completion (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input TEXT NOT NULL,
        final_text TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS native_runtime_turn_completion_by_session
        ON native_runtime_turn_completion(session_id, completed_at ASC, run_id ASC);
      CREATE TABLE IF NOT EXISTS native_runtime_event (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS native_runtime_approval (
        question_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS native_runtime_approval_by_run
        ON native_runtime_approval(run_id, state);
      CREATE TABLE IF NOT EXISTS native_runtime_lock (
        session_id TEXT PRIMARY KEY,
        occupancy TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sample_state TEXT,
        sample_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_goal_state (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_pending_session (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_session_title (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        auto_title_pending INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_hidden_session (
        session_id TEXT PRIMARY KEY,
        hidden_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_runtime_imported_workspace (
        workspace_id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(agent_type, normalized_path)
      );
      CREATE INDEX IF NOT EXISTS native_runtime_imported_workspace_order
        ON native_runtime_imported_workspace(agent_type, created_at ASC, workspace_id ASC);
      CREATE TABLE IF NOT EXISTS codex_session_catalog (
        canonical_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ns TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        probeable INTEGER NOT NULL,
        producer_version TEXT,
        cwd TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        parent_session_id TEXT,
        format_key TEXT,
        compatibility TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        registry_version INTEGER NOT NULL,
        reader_version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS codex_session_catalog_native_id
        ON codex_session_catalog(native_session_id);
    `);
    const runColumns = this.database.db.prepare("PRAGMA table_info(native_runtime_run)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "goal_id")) {
      this.database.db.exec("ALTER TABLE native_runtime_run ADD COLUMN goal_id TEXT");
    }
  }

  load(options: {
    schemaVersion: number;
    registryVersion: number;
    readerVersion: string;
  }): CodexDiskSessionCatalogEntry[] {
    const rows = this.database.db.prepare(`
      SELECT canonical_path, size, mtime_ns, native_session_id, probeable,
             producer_version, cwd, created, updated, parent_session_id,
             format_key, compatibility
      FROM codex_session_catalog
      WHERE schema_version = ? AND registry_version = ? AND reader_version = ?
      ORDER BY updated DESC, native_session_id ASC
    `).all(options.schemaVersion, options.registryVersion, options.readerVersion) as StoredCodexCatalogRow[];
    return rows.flatMap((row) => {
      try {
        return [{
          canonicalPath: row.canonical_path,
          size: row.size,
          mtimeNs: row.mtime_ns,
          nativeSessionId: row.native_session_id,
          probeable: row.probeable === 1,
          ...(row.producer_version ? { producerVersion: row.producer_version } : {}),
          cwd: row.cwd,
          created: row.created,
          updated: row.updated,
          ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
          ...(row.format_key ? { formatKey: row.format_key } : {}),
          compatibility: JSON.parse(row.compatibility) as SessionCompatibility,
        } satisfies CodexDiskSessionCatalogEntry];
      } catch {
        return [];
      }
    });
  }

  replace(entries: readonly CodexDiskSessionCatalogEntry[], options: {
    schemaVersion: number;
    registryVersion: number;
    readerVersion: string;
  }): void {
    const replaceAll = this.database.db.transaction(() => {
      this.database.db.prepare("DELETE FROM codex_session_catalog").run();
      const insert = this.database.db.prepare(`
        INSERT INTO codex_session_catalog(
          canonical_path, size, mtime_ns, native_session_id, probeable,
          producer_version, cwd, created, updated, parent_session_id,
          format_key, compatibility, schema_version, registry_version, reader_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(
          entry.canonicalPath,
          entry.size,
          entry.mtimeNs,
          entry.nativeSessionId,
          entry.probeable ? 1 : 0,
          entry.producerVersion ?? null,
          entry.cwd,
          entry.created,
          entry.updated,
          entry.parentSessionId ?? null,
          entry.formatKey ?? null,
          JSON.stringify(entry.compatibility),
          options.schemaVersion,
          options.registryVersion,
          options.readerVersion,
        );
      }
    });
    replaceAll();
  }

  updateCompatibility(
    canonicalPath: string,
    size: number,
    mtimeNs: string,
    compatibility: SessionCompatibility,
  ): void {
    this.database.db.prepare(`
      UPDATE codex_session_catalog SET compatibility = ?
      WHERE canonical_path = ? AND size = ? AND mtime_ns = ?
    `).run(JSON.stringify(compatibility), canonicalPath, size, mtimeNs);
  }

  list(agentType: NativeAgentType): ImportedAgentWorkspace[] {
    const rows = this.database.db.prepare(`
      SELECT workspace_id, agent_type, normalized_path, name, created_at
      FROM native_runtime_imported_workspace
      WHERE agent_type = ?
      ORDER BY created_at ASC, workspace_id ASC
    `).all(agentType) as StoredImportedWorkspaceRow[];
    return rows.map(toImportedWorkspace);
  }

  findByPath(agentType: NativeAgentType, normalizedPath: string): ImportedAgentWorkspace | null {
    const row = this.database.db.prepare(`
      SELECT workspace_id, agent_type, normalized_path, name, created_at
      FROM native_runtime_imported_workspace
      WHERE agent_type = ? AND normalized_path = ?
    `).get(agentType, normalizedPath) as StoredImportedWorkspaceRow | undefined;
    return row ? toImportedWorkspace(row) : null;
  }

  findImportedWorkspace(agentType: NativeAgentType, workspaceId: string): ImportedAgentWorkspace | null {
    const row = this.database.db.prepare(`
      SELECT workspace_id, agent_type, normalized_path, name, created_at
      FROM native_runtime_imported_workspace
      WHERE agent_type = ? AND workspace_id = ?
    `).get(agentType, workspaceId) as StoredImportedWorkspaceRow | undefined;
    return row ? toImportedWorkspace(row) : null;
  }

  save(workspace: ImportedAgentWorkspace): { workspace: ImportedAgentWorkspace; existing: boolean } {
    const result = this.database.db.prepare(`
      INSERT OR IGNORE INTO native_runtime_imported_workspace(
        workspace_id, agent_type, normalized_path, name, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      workspace.workspaceId,
      workspace.agentType,
      workspace.normalizedPath,
      workspace.name,
      workspace.createdAt,
    );
    return {
      workspace: this.findByPath(workspace.agentType, workspace.normalizedPath) ?? workspace,
      existing: result.changes === 0,
    };
  }

  recoverInterruptedRuns(): void {
    const runs = this.database.db.prepare(
      "SELECT * FROM native_runtime_run WHERE status = 'active'",
    ).all() as StoredRunRow[];
    for (const row of runs) {
      this.appendTerminal(row.run_id, {
        type: "error",
        code: "NATIVE_PROTOCOL_ERROR",
        message: "Native runtime restarted; this turn was interrupted. You can send again.",
      });
      const activeItem = this.getGoalState(row.session_id).active;
      if (
        row.goal_id
        && activeItem?.id === row.goal_id
        && sessionQueueItemKind(activeItem) === "message"
      ) {
        this.finishGoal(row.session_id, row.goal_id, "failed", "Native runtime restarted during this message.");
      }
    }
    this.pruneExpiredTerminals();
  }

  getPermissionMode(sessionId: string): ToolPermissionMode {
    const row = this.database.db.prepare(
      "SELECT permission_mode FROM native_runtime_policy WHERE session_id = ?",
    ).get(sessionId) as { permission_mode?: unknown } | undefined;
    return normalizeToolPermissionMode(row?.permission_mode);
  }

  setPermissionMode(sessionId: string, permissionMode: ToolPermissionMode): ToolPermissionMode {
    const mode = normalizeToolPermissionMode(permissionMode);
    this.database.db.prepare(`
      INSERT INTO native_runtime_policy(session_id, permission_mode, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET permission_mode=excluded.permission_mode, updated_at=excluded.updated_at
    `).run(sessionId, mode, this.now());
    return mode;
  }

  trackPendingAutoTitle(sessionId: string, title: string): void {
    if (title !== NEW_SESSION_PLACEHOLDER_TITLE) return;
    this.database.db.prepare(`
      INSERT OR IGNORE INTO native_runtime_session_title(
        session_id, title, auto_title_pending, updated_at
      ) VALUES (?, ?, 1, ?)
    `).run(sessionId, title, this.now());
  }

  getDisplayTitle(sessionId: string): string | null {
    const row = this.database.db.prepare(
      "SELECT title FROM native_runtime_session_title WHERE session_id = ?",
    ).get(sessionId) as { title?: string } | undefined;
    return row?.title ?? null;
  }

  listPendingSessions(): UnifiedSessionSummary[] {
    const rows = this.database.db.prepare(
      "SELECT payload FROM native_runtime_pending_session ORDER BY updated_at DESC",
    ).all() as Array<{ payload: string }>;
    return rows.flatMap((row) => {
      const parsed = parsePendingSession(row.payload);
      return parsed ? [parsed] : [];
    });
  }

  savePendingSession(session: UnifiedSessionSummary): void {
    this.database.db.prepare(`
      INSERT INTO native_runtime_pending_session(session_id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run(session.id, JSON.stringify(session), this.now());
  }

  deletePendingSession(sessionId: string): void {
    this.database.db.prepare(
      "DELETE FROM native_runtime_pending_session WHERE session_id = ?",
    ).run(sessionId);
  }

  assertSessionCanHide(sessionId: string): void {
    if (this.activeRun(sessionId)) {
      throw new RuntimeSessionError("Session is currently running", "SESSION_OCCUPIED");
    }
  }

  hideSession(sessionId: string): void {
    const hide = this.database.db.transaction(() => {
      this.assertSessionCanHide(sessionId);
      this.database.db.prepare(`
        INSERT OR IGNORE INTO native_runtime_hidden_session(session_id, hidden_at)
        VALUES (?, ?)
      `).run(sessionId, this.now());
      this.database.db.prepare(
        "DELETE FROM native_runtime_pending_session WHERE session_id = ?",
      ).run(sessionId);
      this.database.db.prepare(
        "DELETE FROM native_runtime_goal_state WHERE session_id = ?",
      ).run(sessionId);
      this.database.db.prepare(
        "DELETE FROM native_runtime_turn_completion WHERE session_id = ?",
      ).run(sessionId);
    });
    hide();
  }

  isSessionHidden(sessionId: string): boolean {
    return Boolean(this.database.db.prepare(
      "SELECT 1 AS hidden FROM native_runtime_hidden_session WHERE session_id = ?",
    ).get(sessionId));
  }

  filterHiddenSessions(sessions: UnifiedSessionSummary[]): UnifiedSessionSummary[] {
    const hiddenIds = new Set((this.database.db.prepare(
      "SELECT session_id FROM native_runtime_hidden_session",
    ).all() as Array<{ session_id: string }>).map((row) => row.session_id));
    return sessions.filter((session) => !hiddenIds.has(session.id));
  }

  assertSessionVisible(sessionId: string): void {
    if (this.isSessionHidden(sessionId)) {
      throw new RuntimeSessionError(`Native session not found: ${sessionId}`, "SESSION_NOT_FOUND");
    }
  }

  getGoalState(sessionId: string): SessionGoalState {
    const row = this.database.db.prepare(
      "SELECT payload FROM native_runtime_goal_state WHERE session_id = ?",
    ).get(sessionId) as { payload?: string } | undefined;
    if (!row?.payload) return readSessionGoalState(undefined);
    try {
      return readSessionGoalState({ goalState: JSON.parse(row.payload) });
    } catch {
      return readSessionGoalState(undefined);
    }
  }

  enqueueGoal(sessionId: string, objective: string, sourceMessageId?: string): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => enqueueSessionGoal(state, {
      id: randomUUID(),
      sessionId,
      objective,
      sourceMessageId,
      now: this.now(),
    }));
  }

  enqueueMessage(sessionId: string, input: BrokerQueuedMessageInput): SessionGoalState {
    const activate = !this.activeRun(sessionId);
    return this.updateGoalState(sessionId, (state) => enqueueSessionMessage(state, {
      id: randomUUID(),
      sessionId,
      objective: input.content,
      sourceMessageId: input.sourceMessageId,
      messagePayload: input.messagePayload,
      now: this.now(),
      activate,
    }));
  }

  reorderGoals(sessionId: string, orderedIds: readonly string[]): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => reorderQueuedSessionGoals(state, orderedIds));
  }

  reorderMessages(sessionId: string, orderedIds: readonly string[]): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => reorderQueuedSessionMessages(state, orderedIds));
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    messagePayload?: SessionMessagePayload,
  ): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => updateQueuedSessionMessage(
      state,
      messageId,
      content,
      messagePayload,
      this.now(),
    ));
  }

  cancelGoal(sessionId: string, goalId: string): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => cancelSessionGoal(state, goalId, this.now()));
  }

  cancelMessage(sessionId: string, messageId: string): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => cancelQueuedSessionMessage(state, messageId));
  }

  finishGoal(sessionId: string, goalId: string, outcome: "completed" | "failed", reason?: string): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => (
      state.active?.id === goalId
        ? finishActiveSessionGoal(state, outcome, this.now(), reason)
        : state
    ));
  }

  promoteNextItem(sessionId: string): SessionGoalState {
    return this.updateGoalState(sessionId, (state) => promoteNextSessionQueueItem(state, this.now()));
  }

  queuedMessages(sessionId: string): SessionGoal[] {
    return queuedSessionMessages(this.getGoalState(sessionId));
  }

  listResumableQueueItems(): SessionGoal[] {
    const rows = this.database.db.prepare(
      "SELECT session_id, payload FROM native_runtime_goal_state",
    ).all() as Array<{ session_id: string; payload: string }>;
    return rows.flatMap((row) => {
      try {
        let state = readSessionGoalState({ goalState: JSON.parse(row.payload) });
        if (!state.active && state.queued.length > 0) state = this.promoteNextItem(row.session_id);
        return state.active ? [state.active] : [];
      } catch {
        return [];
      }
    });
  }

  private updateGoalState(
    sessionId: string,
    update: (state: SessionGoalState) => SessionGoalState,
  ): SessionGoalState {
    const transaction = this.database.db.transaction(() => {
      const next = update(this.getGoalState(sessionId));
      this.database.db.prepare(`
        INSERT INTO native_runtime_goal_state(session_id, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
      `).run(sessionId, JSON.stringify(next), this.now());
      return next;
    });
    return transaction();
  }

  admit(input: {
    sessionId: string;
    agentType: NativeAgentType;
    nativeSessionId: string;
    message: string;
    controller: NativeRuntimeController;
    goalId?: string;
  }): BrokerRunRecord {
    const create = this.database.db.transaction(() => {
      const active = this.database.db.prepare(
        "SELECT run_id FROM native_runtime_run WHERE session_id = ? AND status = 'active'",
      ).get(input.sessionId) as { run_id?: string } | undefined;
      if (active?.run_id) {
        throw new RuntimeSessionError("Session is already running", "SESSION_ALREADY_RUNNING");
      }
      const createdAt = this.now();
      if (input.message.trim()) {
        this.database.db.prepare(`
          UPDATE native_runtime_session_title
          SET title = ?, auto_title_pending = 0, updated_at = ?
          WHERE session_id = ? AND auto_title_pending = 1
        `).run(input.message.slice(0, 60), createdAt, input.sessionId);
      }
      const run: BrokerRunRecord = {
        sessionId: input.sessionId,
        runId: randomUUID(),
        agentType: input.agentType,
        nativeSessionId: input.nativeSessionId,
        input: input.message,
        permissionMode: this.getPermissionMode(input.sessionId),
        controller: input.controller,
        status: "active",
        nextSequence: 0,
        createdAt,
        terminalAt: null,
        goalId: input.goalId ?? null,
      };
      this.database.db.prepare(`
        INSERT INTO native_runtime_run(
          run_id, session_id, agent_type, native_session_id, input, permission_mode,
          controller, status, next_sequence, created_at, terminal_at, goal_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.runId,
        run.sessionId,
        run.agentType,
        run.nativeSessionId,
        run.input,
        run.permissionMode,
        run.controller,
        run.status,
        run.nextSequence,
        run.createdAt,
        run.terminalAt,
        run.goalId,
      );
      this.transitionLock(input.sessionId, "owned-by-customer-agent", null, null);
      return run;
    });
    return create();
  }

  appendEvent(runId: string, event: AgentEvent): BrokerRunEvent | null {
    const append = this.database.db.transaction(() => {
      const run = this.getRunById(runId);
      if (!run || run.status !== "active") return null;
      const eventAt = this.now();
      const recordedEvent: AgentEvent = event.type === "done"
        ? { ...event, durationMs: Math.max(0, eventAt - run.createdAt) }
        : event;
      const sequence = run.nextSequence + 1;
      this.database.db.prepare(
        "INSERT INTO native_runtime_event(run_id, sequence, payload, created_at) VALUES (?, ?, ?, ?)",
      ).run(runId, sequence, JSON.stringify(recordedEvent), eventAt);
      this.database.db.prepare(
        "UPDATE native_runtime_run SET next_sequence = ? WHERE run_id = ?",
      ).run(sequence, runId);
      if (recordedEvent.type === "ask_user") {
        this.database.db.prepare(`
          INSERT INTO native_runtime_approval(question_id, run_id, state, created_at, resolved_at)
          VALUES (?, ?, 'pending', ?, NULL)
          ON CONFLICT(question_id) DO NOTHING
        `).run(recordedEvent.questionId, runId, eventAt);
      }
      if (recordedEvent.type === "done") {
        this.database.db.prepare(`
          INSERT OR IGNORE INTO native_runtime_turn_completion(
            run_id, session_id, input, final_text, duration_ms, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          run.runId,
          run.sessionId,
          run.input,
          recordedEvent.finalText,
          recordedEvent.durationMs,
          eventAt,
        );
      }
      if (isTerminalEvent(recordedEvent)) this.finalizeRun(run, eventAt);
      return { runId, sequence, event: recordedEvent } satisfies BrokerRunEvent;
    });
    return append();
  }

  appendTerminal(runId: string, event: Extract<AgentEvent, { type: "error" | "done" }>): BrokerRunEvent | null {
    const current = this.getRunById(runId);
    if (!current || current.status !== "active") return null;
    return this.appendEvent(runId, event);
  }

  getSnapshot(sessionId: string, afterSequence = 0): NativeRuntimeBrokerSnapshot {
    const projection = this.projection(sessionId, afterSequence);
    return {
      sessionId,
      runId: projection.run?.runId ?? null,
      snapshotRevision: projection.run?.nextSequence ?? 0,
      events: projection.events,
      controller: projection.run?.status === "active" ? projection.run.controller : null,
    };
  }

  projection(sessionId: string, afterSequence = 0): SnapshotProjection {
    const run = this.getLatestRetainedRun(sessionId);
    if (!run) return { run: null, events: [] };
    const rows = this.database.db.prepare(`
      SELECT run_id, sequence, payload FROM native_runtime_event
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(run.runId, afterSequence) as StoredEventRow[];
    const events = rows.flatMap((row): BrokerRunEvent[] => {
      const event = parseAgentEvent(row.payload);
      if (!event || (event.type === "ask_user" && !this.isApprovalVisible(event.questionId))) return [];
      return [{ runId: row.run_id, sequence: row.sequence, event }];
    });
    return { run, events };
  }

  claimApproval(questionId: string): BrokerRunRecord | null {
    const claim = this.database.db.transaction(() => {
      const row = this.database.db.prepare(`
        SELECT approval.run_id
        FROM native_runtime_approval approval
        JOIN native_runtime_run run ON run.run_id = approval.run_id
        WHERE approval.question_id = ? AND approval.state = 'pending' AND run.status = 'active'
      `).get(questionId) as { run_id?: string } | undefined;
      if (!row?.run_id) return null;
      const changed = this.database.db.prepare(`
        UPDATE native_runtime_approval SET state = 'claimed'
        WHERE question_id = ? AND state = 'pending'
      `).run(questionId).changes;
      return changed === 1 ? this.getRunById(row.run_id) : null;
    });
    return claim();
  }

  resolveApproval(questionId: string): BrokerRunEvent | null {
    const runId = this.database.db.transaction(() => {
      const row = this.database.db.prepare(`
        SELECT run_id FROM native_runtime_approval
        WHERE question_id = ? AND state IN ('pending', 'claimed')
      `).get(questionId) as { run_id?: string } | undefined;
      if (!row?.run_id) return null;
      const changed = this.database.db.prepare(`
        UPDATE native_runtime_approval SET state = 'resolved', resolved_at = ?
        WHERE question_id = ? AND state IN ('pending', 'claimed')
      `).run(this.now(), questionId).changes;
      return changed === 1 ? row.run_id : null;
    })();
    return runId
      ? this.appendEvent(runId, { type: "approval_resolved", questionId })
      : null;
  }

  restoreApproval(questionId: string): void {
    this.database.db.prepare(`
      UPDATE native_runtime_approval SET state = 'pending', resolved_at = NULL
      WHERE question_id = ? AND state = 'claimed'
    `).run(questionId);
  }

  changeController(sessionId: string, controller: NativeRuntimeController): NativeRuntimeBrokerSnapshot {
    this.database.db.prepare(`
      UPDATE native_runtime_run SET controller = ? WHERE session_id = ? AND status = 'active'
    `).run(controller, sessionId);
    return this.getSnapshot(sessionId);
  }

  activeRun(sessionId: string): BrokerRunRecord | null {
    const row = this.database.db.prepare(
      "SELECT * FROM native_runtime_run WHERE session_id = ? AND status = 'active'",
    ).get(sessionId) as StoredRunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  hasActiveRuns(): boolean {
    const row = this.database.db.prepare(
      "SELECT 1 AS active FROM native_runtime_run WHERE status = 'active' LIMIT 1",
    ).get() as { active?: number } | undefined;
    return row?.active === 1;
  }

  sessionIdForRun(runId: string): string | null {
    return this.getRunById(runId)?.sessionId ?? null;
  }

  recordExplicitExternalOwnership(sessionId: string): void {
    if (this.activeRun(sessionId)) return;
    this.transitionLock(sessionId, "owned-externally", "occupied", this.now());
  }

  observeDiscovery(sessionId: string, externallyOccupied: boolean): BrokerLockRecord {
    if (this.activeRun(sessionId)) {
      return this.transitionLock(sessionId, "owned-by-customer-agent", null, null);
    }
    const lock = this.getLock(sessionId);
    const nextSample = externallyOccupied ? "occupied" : "clean";
    const now = this.now();
    if (lock.sampleState === nextSample && lock.sampleAt !== null && now - lock.sampleAt >= EXTERNAL_OBSERVATION_DEBOUNCE_MS) {
      const nextOccupancy: SessionOccupancy = externallyOccupied ? "owned-externally" : "available";
      return this.transitionLock(sessionId, nextOccupancy, nextSample, now);
    }
    this.database.db.prepare(`
      INSERT INTO native_runtime_lock(session_id, occupancy, revision, sample_state, sample_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET sample_state=excluded.sample_state, sample_at=excluded.sample_at, updated_at=excluded.updated_at
    `).run(sessionId, lock.occupancy, lock.revision, nextSample, now, now);
    return { ...lock, sampleState: nextSample, sampleAt: now };
  }

  applySummary(summary: UnifiedSessionSummary): UnifiedSessionSummary {
    const observed = summary.occupancy === "owned-externally";
    const lock = this.observeDiscovery(summary.id, observed);
    const policy = this.getPermissionMode(summary.id);
    const active = this.activeRun(summary.id);
    const occupancy = active ? "owned-by-customer-agent" : lock.occupancy;
    return {
      ...summary,
      title: this.getDisplayTitle(summary.id) ?? summary.title,
      occupancy,
      status: active ? "running" : summary.status,
      canResume: occupancy !== "owned-externally"
        && (summary.compatibility === undefined || summary.compatibility.status === "direct"),
      canDelete: !active,
      permissionMode: policy,
      occupancyRevision: lock.revision,
      controller: active?.controller ?? null,
      goalState: this.getGoalState(summary.id),
      messageQueueVersion: 1,
    };
  }

  applyDetail(detail: UnifiedSessionDetail): UnifiedSessionDetail {
    const summary = this.applySummary(detail);
    const projection = this.projection(detail.id);
    const projectedMessages = mergeProjectionMessages(detail.messages, projection.run, projection.events);
    const completionRows = this.database.db.prepare(`
      SELECT run_id, session_id, input, final_text, duration_ms, completed_at
      FROM native_runtime_turn_completion
      WHERE session_id = ?
      ORDER BY completed_at ASC, run_id ASC
    `).all(detail.id) as StoredTurnCompletionRow[];
    const messages = applyTurnCompletions(projectedMessages, completionRows);
    return {
      ...detail,
      ...summary,
      messages,
      events: projection.events.map(({ event }) => event),
      snapshotRevision: projection.run?.nextSequence ?? 0,
      snapshotRunId: projection.run?.runId ?? null,
    };
  }

  private getRunById(runId: string): BrokerRunRecord | null {
    const row = this.database.db.prepare(
      "SELECT * FROM native_runtime_run WHERE run_id = ?",
    ).get(runId) as StoredRunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  private getLatestRetainedRun(sessionId: string): BrokerRunRecord | null {
    const row = this.database.db.prepare(`
      SELECT * FROM native_runtime_run
      WHERE session_id = ? AND (status = 'active' OR terminal_at >= ?)
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
    `).get(sessionId, this.now() - TERMINAL_RETENTION_MS) as StoredRunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  private isApprovalVisible(questionId: string): boolean {
    const row = this.database.db.prepare(
      "SELECT state FROM native_runtime_approval WHERE question_id = ?",
    ).get(questionId) as { state?: string } | undefined;
    return row?.state === "pending" || row?.state === "claimed";
  }

  private finalizeRun(run: BrokerRunRecord, terminalAt: number): void {
    this.database.db.prepare(`
      UPDATE native_runtime_run SET status = 'terminal', terminal_at = ? WHERE run_id = ?
    `).run(terminalAt, run.runId);
    this.database.db.prepare(`
      UPDATE native_runtime_approval SET state = 'resolved', resolved_at = ?
      WHERE run_id = ? AND state IN ('pending', 'claimed')
    `).run(terminalAt, run.runId);
    this.transitionLock(run.sessionId, "available", null, null);
  }

  private getLock(sessionId: string): BrokerLockRecord {
    const row = this.database.db.prepare(
      "SELECT * FROM native_runtime_lock WHERE session_id = ?",
    ).get(sessionId) as StoredLockRow | undefined;
    return row ? {
      sessionId: row.session_id,
      occupancy: row.occupancy,
      revision: row.revision,
      sampleState: row.sample_state,
      sampleAt: row.sample_at,
    } : {
      sessionId,
      occupancy: "available",
      revision: 0,
      sampleState: null,
      sampleAt: null,
    };
  }

  private transitionLock(
    sessionId: string,
    occupancy: SessionOccupancy,
    sampleState: "occupied" | "clean" | null,
    sampleAt: number | null,
  ): BrokerLockRecord {
    const previous = this.getLock(sessionId);
    const revision = previous.occupancy === occupancy ? previous.revision : previous.revision + 1;
    const now = this.now();
    this.database.db.prepare(`
      INSERT INTO native_runtime_lock(session_id, occupancy, revision, sample_state, sample_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        occupancy=excluded.occupancy,
        revision=excluded.revision,
        sample_state=excluded.sample_state,
        sample_at=excluded.sample_at,
        updated_at=excluded.updated_at
    `).run(sessionId, occupancy, revision, sampleState, sampleAt, now);
    return { sessionId, occupancy, revision, sampleState, sampleAt };
  }

  private pruneExpiredTerminals(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    const oldRuns = this.database.db.prepare(
      "SELECT run_id FROM native_runtime_run WHERE status = 'terminal' AND terminal_at < ?",
    ).all(cutoff) as Array<{ run_id: string }>;
    const prune = this.database.db.transaction(() => {
      for (const row of oldRuns) {
        this.database.db.prepare("DELETE FROM native_runtime_event WHERE run_id = ?").run(row.run_id);
        this.database.db.prepare("DELETE FROM native_runtime_approval WHERE run_id = ?").run(row.run_id);
        this.database.db.prepare("DELETE FROM native_runtime_run WHERE run_id = ?").run(row.run_id);
      }
    });
    prune();
  }
}

export class NativeRuntimeBrokerHost {
  private readonly state: NativeRuntimeBrokerState;
  private readonly runtime: UnifiedSessionService;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  /** Best-effort auto-fork target per source session, reused across retries. */
  private readonly occupiedForkTargets = new Map<string, string>();
  private readonly subscribers = new Map<Socket, BrokerSubscription>();
  private readonly localSubscribers = new Set<LocalBrokerSubscription>();
  private readonly pendingCreations = new Map<string, UnifiedSessionSummary>();
  private readonly queryIndexCache = new SessionQueryIndexCache();
  private server: Server | null = null;
  private ownsSocket = false;

  constructor(
    readonly directory: string,
    runtime: UnifiedSessionService | NativeRuntimeBrokerRuntimeFactory,
    now: () => number = Date.now,
  ) {
    this.state = new NativeRuntimeBrokerState(directory, now);
    this.runtime = typeof runtime === "function"
      ? runtime({
          onApprovalResolved: (questionId) => this.handleApprovalResolved(questionId),
          importedWorkspaceRepository: this.state,
          codexSessionCatalogRepository: this.state,
        })
      : runtime;
    const pendingSessions = this.state.listPendingSessions();
    for (const pending of pendingSessions) this.pendingCreations.set(pending.id, pending);
    this.runtime.restoreDrafts?.(pendingSessions);
  }

  get socketPath(): string {
    return join(this.directory, BROKER_SOCKET_NAME);
  }

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { chmodSync(this.directory, 0o700); } catch { /* Best effort. */ }
    if (existsSync(this.socketPath)) {
      const error = new Error(`Native runtime broker socket is already in use: ${this.socketPath}`) as NodeJS.ErrnoException;
      error.code = "EADDRINUSE";
      throw error;
    }
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    try { chmodSync(this.socketPath, 0o600); } catch { /* Best effort. */ }
    this.server = server;
    this.ownsSocket = true;
    // Do this only after this host owns the socket. A losing startup race must
    // never interrupt a still-live turn owned by another process.
    this.state.recoverInterruptedRuns();
    for (const item of this.state.listResumableQueueItems()) {
      void this.startQueueItem(item, "web");
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.subscribers.keys()) socket.destroy();
    this.subscribers.clear();
    this.localSubscribers.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.ownsSocket && existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    this.ownsSocket = false;
    await this.runtime.dispose();
  }

  async health(): Promise<RuntimeHealth[]> {
    return this.runtime.health();
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.state
      .filterHiddenSessions(this.mergePending(await this.runtime.list(projectId), projectId))
      .map((session) => this.state.applySummary(session));
  }

  listWorkspaces(agentType: NativeAgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>> {
    return this.runtime.listWorkspaces(agentType, query);
  }

  importWorkspace(
    agentType: NativeAgentType,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult> {
    return this.runtime.importWorkspace(agentType, path, name);
  }

  async listWorkspaceSessions(
    agentType: NativeAgentType,
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const limit = workspacePageSize(query?.limit);
    const discovered: UnifiedSessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = query?.cursor ?? null;
    let nextCursor: string | null = cursor;
    let watermark: string | null = null;
    let stale = false;
    let firstPage = true;

    while (firstPage || (nextCursor && this.state.filterHiddenSessions(discovered).length < limit)) {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new RuntimeSessionError("Workspace pagination cursor did not advance", "NATIVE_PROTOCOL_ERROR");
        }
        seenCursors.add(cursor);
      }
      const visibleCount = this.state.filterHiddenSessions(discovered).length;
      const page = await this.runtime.listWorkspaceSessions(agentType, workspaceId, {
        ...query,
        cursor,
        limit: Math.max(1, limit - visibleCount),
        refresh: firstPage && query?.refresh === true,
      });
      if (firstPage) watermark = page.watermark;
      stale ||= page.stale === true;
      for (const session of page.data) {
        if (seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        discovered.push(session);
      }
      nextCursor = page.nextCursor;
      cursor = nextCursor;
      firstPage = false;
    }

    const imported = this.state.findImportedWorkspace(agentType, workspaceId);
    return {
      nextCursor,
      watermark,
      ...(stale ? { stale: true } : {}),
      data: this.state.filterHiddenSessions(this.mergePending(
        discovered,
        undefined,
        (session) => session.agentType === agentType && (
          session.projectId === workspaceId
          || Boolean(imported && session.cwd && normalizeAgentWorkspacePath(session.cwd) === imported.normalizedPath)
        ),
      )).map((session) => this.state.applySummary(session)),
    };
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.state
      .filterHiddenSessions(this.mergePending(await this.runtime.refresh(projectId), projectId))
      .map((session) => this.state.applySummary(session));
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: NativeAgentType }): Promise<UnifiedSessionSummary> {
    const created = await this.runtime.create(options);
    this.pendingCreations.set(created.id, created);
    if (created.agentType === "claude-code") this.state.savePendingSession(created);
    this.state.trackPendingAutoTitle(created.id, options.title);
    return this.state.applySummary(created);
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    this.state.assertSessionVisible(id);
    const forked = await this.runtime.fork(id);
    this.pendingCreations.set(forked.id, forked);
    return this.state.applySummary(forked);
  }

  async delete(sessionId: string): Promise<void> {
    if (this.state.isSessionHidden(sessionId)) return;
    this.state.assertSessionCanHide(sessionId);
    if (decodeUnifiedSessionId(sessionId).agentType === "codex") {
      await this.runtime.archive(sessionId);
    }
    this.state.hideSession(sessionId);
    this.pendingCreations.delete(sessionId);
    this.runtime.invalidate(sessionId);
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    this.state.assertSessionVisible(id);
    try {
      // Reconcile retained run events against the complete transcript before
      // paging, otherwise the run input can be projected once per page.
      const detail = await this.runtime.getUnpaginated(id, shouldReuseSessionDetailCache(query));
      const projected = this.state.applyDetail(detail);
      this.queryIndexCache.getOrCreate(id, projected.messages);
      return query
        ? { ...projected, ...paginateSessionHistory(projected.messages, projected.events, query) }
        : projected;
    } catch (error) {
      const pending = this.pendingCreations.get(id);
      if (!pending) throw error;
      const projected = this.state.applyDetail({ ...pending, messages: [], events: [] });
      return query
        ? { ...projected, ...paginateSessionHistory(projected.messages, projected.events, query) }
        : projected;
    }
  }

  async getQueryIndex(id: string): Promise<SessionQueryIndex> {
    this.state.assertSessionVisible(id);
    try {
      const detail = await this.runtime.getUnpaginated(id, true);
      const projected = this.state.applyDetail(detail);
      return this.queryIndexCache.getOrCreate(id, projected.messages);
    } catch (error) {
      const pending = this.pendingCreations.get(id);
      if (!pending) throw error;
      const projected = this.state.applyDetail({ ...pending, messages: [], events: [] });
      return this.queryIndexCache.getOrCreate(id, projected.messages);
    }
  }

  async getSessionWatchPath(id: string): Promise<string | null> {
    this.state.assertSessionVisible(id);
    return this.runtime.getSessionWatchPath(id);
  }

  async startRun(
    sessionId: string,
    input: string,
    images?: string[],
    controller: NativeRuntimeController = "web",
    goalId?: string,
    agentIds?: string[],
    agentName?: string,
    runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">,
  ): Promise<BrokerRunStart> {
    this.state.assertSessionVisible(sessionId);
    const settlingExecution = this.activeExecutions.get(sessionId);
    if (settlingExecution && !this.state.activeRun(sessionId)) {
      await settlingExecution;
    }
    const decoded = decodeNativeSessionId(sessionId);
    try {
      const detail = await this.runtime.get(sessionId);
      // Codex occupancy is advisory; the attempted takeover either succeeds
      // (clearing the stale marker) or fails authoritatively inside the run,
      // where this broker can fork-and-forward the message. Compatibility and
      // genuinely unresumable sessions are still refused here.
      const occupancyAdvisory = decoded.agentType === "codex";
      if (!occupancyAdvisory && (!detail.canResume || detail.occupancy === "owned-externally")) {
        this.state.recordExplicitExternalOwnership(sessionId);
        throw new RuntimeSessionError("Session is currently owned by another client", "SESSION_OCCUPIED");
      }
    } catch (error) {
      if (error instanceof RuntimeSessionError && error.code === "SESSION_OCCUPIED") {
        this.state.recordExplicitExternalOwnership(sessionId);
      }
      throw error;
    }
    const run = this.state.admit({
      sessionId,
      agentType: decoded.agentType,
      nativeSessionId: decoded.nativeSessionId,
      message: input,
      controller,
      goalId,
    });
    const execution = this.executeRun(run, images, agentIds, agentName, runOverrides);
    this.activeExecutions.set(sessionId, execution);
    const clearExecution = () => {
      if (this.activeExecutions.get(sessionId) === execution) {
        this.activeExecutions.delete(sessionId);
      }
    };
    void execution.then(clearExecution, clearExecution);
    return {
      runId: run.runId,
      snapshotRevision: run.nextSequence,
      permissionMode: run.permissionMode,
    };
  }

  async listModels(agentType: NativeAgentType): Promise<RuntimeModelInfo[]> {
    return this.runtime.listModels(agentType);
  }

  async getGoals(
    sessionId: string,
    controller: NativeRuntimeController = "web",
  ): Promise<SessionGoalState> {
    let state = this.state.getGoalState(sessionId);
    if (!state.active && state.queued.length > 0 && !this.state.activeRun(sessionId)) {
      state = this.state.promoteNextItem(sessionId);
    }
    if (state.active && !this.state.activeRun(sessionId)) {
      await this.startQueueItemAfterSettling(state.active, controller);
    }
    return this.state.getGoalState(sessionId);
  }

  async enqueueGoal(
    sessionId: string,
    objective: string,
    sourceMessageId?: string,
    controller: NativeRuntimeController = "web",
  ): Promise<BrokerGoalEnqueueResult> {
    decodeNativeSessionId(sessionId);
    const hadActive = Boolean(this.state.getGoalState(sessionId).active);
    const state = this.state.enqueueGoal(sessionId, objective, sourceMessageId);
    if (hadActive || !state.active) return { state };
    const started = await this.startQueueItemAfterSettling(state.active, controller);
    return {
      state: this.state.getGoalState(sessionId),
      ...(started ? { started } : {}),
    };
  }

  reorderGoals(sessionId: string, orderedIds: readonly string[]): SessionGoalState {
    decodeNativeSessionId(sessionId);
    return this.state.reorderGoals(sessionId, orderedIds);
  }

  async enqueueMessage(
    sessionId: string,
    input: BrokerQueuedMessageInput,
    controller: NativeRuntimeController = "web",
  ): Promise<BrokerGoalEnqueueResult> {
    decodeNativeSessionId(sessionId);
    const state = this.state.enqueueMessage(sessionId, input);
    if (!state.active || this.state.activeRun(sessionId)) return { state };
    const started = await this.startQueueItemAfterSettling(state.active, controller);
    return {
      state: this.state.getGoalState(sessionId),
      ...(started ? { started } : {}),
    };
  }

  reorderMessages(sessionId: string, orderedIds: readonly string[]): SessionGoalState {
    decodeNativeSessionId(sessionId);
    return this.state.reorderMessages(sessionId, orderedIds);
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    messagePayload?: SessionMessagePayload,
  ): SessionGoalState {
    decodeNativeSessionId(sessionId);
    return this.state.updateMessage(sessionId, messageId, content, messagePayload);
  }

  cancelMessage(sessionId: string, messageId: string): SessionGoalState {
    decodeNativeSessionId(sessionId);
    return this.state.cancelMessage(sessionId, messageId);
  }

  async steerMessage(sessionId: string, messageId: string): Promise<BrokerMessageSteerResult> {
    decodeNativeSessionId(sessionId);
    const item = this.state.queuedMessages(sessionId).find((message) => message.id === messageId);
    if (!item) {
      throw new RuntimeSessionError("Queued message not found", "SESSION_NOT_FOUND");
    }
    const steered = await this.runtime.steer(sessionId, item.objective);
    return {
      steered,
      state: steered
        ? this.state.cancelMessage(sessionId, messageId)
        : this.state.getGoalState(sessionId),
    };
  }

  async cancelGoal(
    sessionId: string,
    goalId: string,
    controller: NativeRuntimeController = "web",
  ): Promise<SessionGoalState> {
    decodeNativeSessionId(sessionId);
    const wasActive = this.state.getGoalState(sessionId).active?.id === goalId;
    const activeRun = this.state.activeRun(sessionId);
    const state = this.state.cancelGoal(sessionId, goalId);
    if (wasActive && activeRun?.goalId === goalId) {
      await this.runtime.abort(sessionId).catch(() => undefined);
      if (!this.state.activeRun(sessionId) && state.active) void this.startQueueItem(state.active, controller);
    } else if (wasActive && !activeRun && state.active) {
      void this.startQueueItem(state.active, controller);
    }
    return state;
  }

  subscribe(sessionId: string, afterSequence: number, listener: (event: BrokerRunEvent) => void): () => void {
    const snapshot = this.state.getSnapshot(sessionId, afterSequence);
    for (const event of snapshot.events) listener(event);
    const subscription: LocalBrokerSubscription = {
      sessionId,
      runId: snapshot.runId,
      afterSequence: snapshot.snapshotRevision,
      listener,
    };
    this.localSubscribers.add(subscription);
    return () => this.localSubscribers.delete(subscription);
  }

  snapshot(sessionId: string, afterSequence = 0): NativeRuntimeBrokerSnapshot {
    return this.state.getSnapshot(sessionId, afterSequence);
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const run = this.state.claimApproval(questionId);
    if (!run) return false;
    try {
      const resolved = await this.runtime.answerQuestion(questionId, answer);
      if (resolved) {
        this.handleApprovalResolved(questionId);
        return true;
      }
    } catch {
      // The app-server request can disappear after a native runtime restart.
      // Treat that as an interrupted turn rather than leaving a claimed card
      // that can no longer be answered after a page refresh.
    }

    const terminal = this.state.appendTerminal(run.runId, {
      type: "error",
      code: "APPROVAL_EXPIRED",
      message: "This approval request is no longer active; the native turn was interrupted. You can send again.",
    });
    if (terminal) this.broadcast(terminal);
    throw new RuntimeSessionError(
      "This approval request is no longer active; the native turn was interrupted.",
      "APPROVAL_EXPIRED",
    );
  }

  async abort(sessionId?: string): Promise<void> {
    if (!sessionId) return;
    const run = this.state.activeRun(sessionId);
    await this.runtime.abort(sessionId);
    if (run) {
      setTimeout(() => {
        const terminal = this.state.appendTerminal(run.runId, {
          type: "error",
          code: "NATIVE_PROTOCOL_ERROR",
          message: "Native turn was interrupted before the runtime confirmed completion.",
        });
        if (terminal) this.broadcast(terminal);
      }, ABORT_FALLBACK_MS).unref?.();
    }
  }

  steer(sessionId: string, input: string): Promise<boolean> {
    return this.runtime.steer(sessionId, input);
  }

  setPermissionMode(sessionId: string, permissionMode: ToolPermissionMode): UnifiedSessionSummary {
    const run = this.state.activeRun(sessionId);
    const mode = this.state.setPermissionMode(sessionId, permissionMode);
    const base: UnifiedSessionSummary = {
      id: sessionId,
      agentType: decodeNativeSessionId(sessionId).agentType,
      nativeSessionId: decodeNativeSessionId(sessionId).nativeSessionId,
      title: "Native session",
      cwd: "",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      status: run ? "running" : "idle",
      occupancy: run ? "owned-by-customer-agent" : "available",
      sourceLabel: "Native runtime broker",
      canResume: true,
      canDelete: false,
      permissionMode: mode,
    };
    return this.state.applySummary(base);
  }

  handoff(sessionId: string, controller: NativeRuntimeController): NativeRuntimeBrokerSnapshot {
    return this.state.changeController(sessionId, controller);
  }

  private async executeRun(
    run: BrokerRunRecord,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
    runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">,
  ): Promise<void> {
    let terminalSeen = false;
    let completed = false;
    let forwardedForkId: string | undefined;
    try {
      const activeItem = run.goalId ? this.state.getGoalState(run.sessionId).active : null;
      const options: RuntimeRunOptions = {
        permissionMode: run.permissionMode,
        brokerRunId: run.runId,
        ...(runOverrides?.model ? { model: runOverrides.model } : {}),
        ...(runOverrides?.reasoningEffort ? { reasoningEffort: runOverrides.reasoningEffort } : {}),
        ...(run.goalId && activeItem?.id === run.goalId && sessionQueueItemKind(activeItem) === "goal" ? {
          goal: {
            id: run.goalId,
            objective: activeItem.objective,
          },
        } : {}),
      };
      for await (const event of this.runtime.run(run.sessionId, run.input, images, agentIds, agentName, options)) {
        const recorded = this.state.appendEvent(run.runId, event);
        if (recorded) this.broadcast(recorded);
        // Adapters surface many startup failures as terminal AgentEvents rather
        // than throwing. Preserve a confirmed external owner after the local
        // run is finalized, otherwise discovery can incorrectly show this
        // session as available until its next debounced scan.
        if (event.type === "error" && event.code === "SESSION_OCCUPIED") {
          this.state.recordExplicitExternalOwnership(run.sessionId);
        }
        terminalSeen ||= isTerminalEvent(event);
        completed ||= event.type === "done";
      }
      if (!terminalSeen) {
        const recorded = this.state.appendTerminal(run.runId, {
          type: "error",
          code: "NATIVE_PROTOCOL_ERROR",
          message: "Native runtime stopped without a terminal event.",
        });
        if (recorded) this.broadcast(recorded);
      } else if (completed) {
        this.pendingCreations.delete(run.sessionId);
        this.state.deletePendingSession(run.sessionId);
      }
    } catch (error) {
      const externallyOwned = error instanceof RuntimeSessionError && error.code === "SESSION_OCCUPIED";
      // The takeover attempt confirmed a genuine external holder. Fall back to
      // the user's own proposal: fork a copy of the locked session and send
      // the just-typed message there, instead of bouncing it back as an error.
      if (externallyOwned && run.agentType === "codex" && !run.goalId) {
        forwardedForkId = await this.forwardOccupiedRunToFork(
          run.sessionId,
          run.input,
          run.controller,
          images,
          agentIds,
          agentName,
          runOverrides,
        );
      }
      const recorded = this.state.appendTerminal(run.runId, {
        type: "error",
        code: error instanceof RuntimeSessionError ? error.code : "NATIVE_PROTOCOL_ERROR",
        ...(forwardedForkId
          ? {
              message: "会话仍被其他客户端占用，已创建副本并转发这条消息",
              forkSessionId: forwardedForkId,
            }
          : { message: error instanceof Error ? error.message : "Native runtime failed" }),
      });
      if (recorded) this.broadcast(recorded);
      // appendTerminal releases this broker-owned run first. Only then can an
      // app-server writer-lock failure become an authoritative external lock.
      if (externallyOwned) this.state.recordExplicitExternalOwnership(run.sessionId);
    } finally {
      if (run.goalId) {
        const events = this.state.getSnapshot(run.sessionId).events;
        const terminal = [...events].reverse().find(({ event }) => isTerminalEvent(event))?.event;
        const outcome = terminal?.type === "done" ? "completed" : "failed";
        const reason = terminal?.type === "error" ? terminal.message : undefined;
        const next = this.state.finishGoal(run.sessionId, run.goalId, outcome, reason).active;
        if (next && !this.state.activeRun(run.sessionId)) void this.startQueueItem(next, run.controller);
      } else if (!forwardedForkId) {
        // Queued items stay on the source session when the turn was forwarded
        // to a fork; promoting them here would hammer the locked session and
        // spawn a fork per queued message.
        let pendingItem = this.state.getGoalState(run.sessionId).active;
        if (!pendingItem && !this.state.activeRun(run.sessionId)) {
          pendingItem = this.state.promoteNextItem(run.sessionId).active;
        }
        if (pendingItem && !this.state.activeRun(run.sessionId)) void this.startQueueItem(pendingItem, run.controller);
      }
    }
  }

  private async forwardOccupiedRunToFork(
    sessionId: string,
    input: string,
    controller: NativeRuntimeController,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
    runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">,
  ): Promise<string | undefined> {
    const reuse = this.occupiedForkTargets.get(sessionId);
    if (reuse && reuse !== sessionId && !this.state.isSessionHidden(reuse) && !this.state.activeRun(reuse)) {
      try {
        await this.startRun(reuse, input, images, controller, undefined, agentIds, agentName, runOverrides);
        return reuse;
      } catch {
        this.occupiedForkTargets.delete(sessionId);
      }
    }
    try {
      const forked = await this.fork(sessionId);
      if (!forked.id || forked.id === sessionId) return undefined;
      this.occupiedForkTargets.set(sessionId, forked.id);
      await this.startRun(forked.id, input, images, controller, undefined, agentIds, agentName, runOverrides);
      return forked.id;
    } catch (error) {
      console.warn("[native-runtime-broker] Auto-fork forwarding failed:", error);
      return undefined;
    }
  }

  private async startQueueItemAfterSettling(
    item: SessionGoal,
    controller: NativeRuntimeController,
  ): Promise<BrokerRunStart | undefined> {
    const settlingExecution = this.activeExecutions.get(item.sessionId);
    if (settlingExecution && !this.state.activeRun(item.sessionId)) {
      // executeRun owns queue admission while its adapter is still cleaning
      // up. Waiting here lets its finally block start the item exactly once.
      await settlingExecution;
      return undefined;
    }
    return this.startQueueItem(item, controller);
  }

  private async startQueueItem(
    item: SessionGoal,
    controller: NativeRuntimeController,
  ): Promise<BrokerRunStart | undefined> {
    if (this.state.activeRun(item.sessionId)) return undefined;
    try {
      return await this.startRun(
        item.sessionId,
        item.objective,
        item.messagePayload?.images,
        controller,
        item.id,
        item.messagePayload?.agentIds,
        item.messagePayload?.agentName,
      );
    } catch (error) {
      const state = this.state.finishGoal(
        item.sessionId,
        item.id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      if (state.active) void this.startQueueItem(state.active, controller);
      return undefined;
    }
  }

  private handleApprovalResolved(questionId: string): void {
    const event = this.state.resolveApproval(questionId);
    if (event) this.broadcast(event);
  }

  private mergePending(
    discovered: UnifiedSessionSummary[],
    projectId?: string,
    pendingFilter: (session: UnifiedSessionSummary) => boolean = () => true,
  ): UnifiedSessionSummary[] {
    const seen = new Set(discovered.map((session) => session.id));
    const reconciled = discovered.map((session) => {
      const pending = this.pendingCreations.get(session.id);
      const materialized = pending && isMaterializedPendingSession(session);
      if (materialized) {
        this.pendingCreations.delete(session.id);
        this.state.deletePendingSession(session.id);
      }
      if (!pending) return session;
      return materialized
        ? mergePendingSessionContext(session, pending)
        : mergePendingSessionContext(pending, session);
    });
    const merged = [
      ...reconciled,
      ...[...this.pendingCreations.values()].filter((session) => (
        !seen.has(session.id) && pendingFilter(session)
      )),
    ].sort((left, right) => right.updated.localeCompare(left.updated));
    return projectId === undefined
      ? merged
      : merged.filter((session) => session.projectId === projectId);
  }

  private handleSocket(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleSocketLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => this.subscribers.delete(socket));
    socket.on("error", () => this.subscribers.delete(socket));
  }

  private handleSocketLine(socket: Socket, line: string): void {
    let request: BrokerRequest;
    try {
      request = JSON.parse(line) as BrokerRequest;
    } catch {
      socket.end();
      return;
    }
    if (!request.id || !request.method || !request.params || typeof request.params !== "object") {
      this.write(socket, { id: request.id || "", ok: false, error: { message: "Invalid broker request" } });
      socket.end();
      return;
    }
    if (request.method === "subscribe") {
      const sessionId = stringParam(request.params, "sessionId");
      const afterSequence = numberParam(request.params, "afterSequence") ?? 0;
      if (!sessionId) {
        this.write(socket, { id: request.id, ok: false, error: { message: "sessionId is required" } });
        socket.end();
        return;
      }
      const snapshot = this.state.getSnapshot(sessionId, afterSequence);
      this.subscribers.set(socket, {
        sessionId,
        runId: snapshot.runId,
        afterSequence: snapshot.snapshotRevision,
      });
      this.write(socket, { id: request.id, ok: true, result: { snapshotRevision: snapshot.snapshotRevision } });
      for (const event of snapshot.events) this.write(socket, { type: "event", event });
      return;
    }
    void this.handleRequest(request).then(
      (result) => {
        this.write(socket, { id: request.id, ok: true, result });
        socket.end();
      },
      (error) => {
        this.write(socket, { id: request.id, ok: false, error: serializeBrokerError(error) });
        socket.end();
      },
    );
  }

  private async handleRequest(request: BrokerRequest): Promise<unknown> {
    const sessionId = stringParam(request.params, "sessionId");
    switch (request.method) {
      case "ping": return { ok: true };
      case "health": return this.health();
      case "listWorkspaces": return this.listWorkspaces(
        nativeAgentTypeParam(request.params, "agentType"),
        workspaceQueryParam(request.params),
      );
      case "importWorkspace": return this.importWorkspace(
        nativeAgentTypeParam(request.params, "agentType"),
        requiredStringParam(request.params, "path"),
        stringParam(request.params, "name") || undefined,
      );
      case "listWorkspaceSessions": return this.listWorkspaceSessions(
        nativeAgentTypeParam(request.params, "agentType"),
        requiredStringParam(request.params, "workspaceId"),
        workspaceSessionQueryParam(request.params),
      );
      case "list": return this.list(stringParam(request.params, "projectId") || undefined);
      case "refresh": return this.refresh(stringParam(request.params, "projectId") || undefined);
      case "create": return this.create({
        agentType: nativeAgentTypeParam(request.params, "agentType"),
        title: stringParam(request.params, "title") || "New session",
        cwd: stringParam(request.params, "cwd") || "",
        ...(stringParam(request.params, "projectId") ? { projectId: stringParam(request.params, "projectId")! } : {}),
      });
      case "fork": return this.fork(requireSessionId(sessionId));
      case "delete": return this.delete(requireSessionId(sessionId));
      case "get": return this.get(requireSessionId(sessionId), queryParam(request.params));
      case "getQueryIndex": return this.getQueryIndex(requireSessionId(sessionId));
      case "watchPath": return this.getSessionWatchPath(requireSessionId(sessionId));
      case "startRun": return this.startRun(
        requireSessionId(sessionId),
        stringParam(request.params, "input") || "",
        arrayOfStrings(request.params.images),
        controllerParam(request.params.controller),
        undefined,
        undefined,
        undefined,
        runOverridesParam(request.params),
      );
      case "listModels": return this.listModels(nativeAgentTypeParam(request.params, "agentType"));
      case "snapshot": return this.snapshot(requireSessionId(sessionId), numberParam(request.params, "afterSequence") ?? 0);
      case "getGoals": return this.getGoals(
        requireSessionId(sessionId),
        controllerParam(request.params.controller),
      );
      case "enqueueGoal": return this.enqueueGoal(
        requireSessionId(sessionId),
        stringParam(request.params, "objective") || "",
        stringParam(request.params, "sourceMessageId") || undefined,
        controllerParam(request.params.controller),
      );
      case "enqueueMessage": return this.enqueueMessage(
        requireSessionId(sessionId),
        {
          sourceMessageId: requiredStringParam(request.params, "sourceMessageId"),
          content: requiredStringParam(request.params, "content"),
          messagePayload: messagePayloadParam(request.params.messagePayload),
        },
        controllerParam(request.params.controller),
      );
      case "reorderGoals": return this.reorderGoals(
        requireSessionId(sessionId),
        arrayOfStrings(request.params.orderedIds) ?? [],
      );
      case "reorderMessages": return this.reorderMessages(
        requireSessionId(sessionId),
        arrayOfStrings(request.params.orderedIds) ?? [],
      );
      case "updateMessage": return this.updateMessage(
        requireSessionId(sessionId),
        requiredStringParam(request.params, "messageId"),
        requiredStringParam(request.params, "content"),
        messagePayloadParam(request.params.messagePayload),
      );
      case "cancelMessage": return this.cancelMessage(
        requireSessionId(sessionId),
        requiredStringParam(request.params, "messageId"),
      );
      case "steerMessage": return this.steerMessage(
        requireSessionId(sessionId),
        requiredStringParam(request.params, "messageId"),
      );
      case "cancelGoal": return this.cancelGoal(
        requireSessionId(sessionId),
        stringParam(request.params, "goalId") || "",
        controllerParam(request.params.controller),
      );
      case "answer": return this.answerQuestion(
        stringParam(request.params, "questionId") || "",
        { answer: stringParam(request.params, "answer") || "", selectedIndices: arrayOfNumbers(request.params.selectedIndices) },
      );
      case "abort": return this.abort(sessionId || undefined);
      case "steer": return this.steer(requireSessionId(sessionId), stringParam(request.params, "input") || "");
      case "setPermissionMode": return this.setPermissionMode(
        requireSessionId(sessionId),
        normalizeToolPermissionMode(request.params.permissionMode),
      );
      case "handoff": return this.handoff(requireSessionId(sessionId), controllerParam(request.params.controller));
      default: throw new RuntimeSessionError(`Unsupported broker method: ${request.method}`, "OPERATION_NOT_SUPPORTED");
    }
  }

  private broadcast(event: BrokerRunEvent): void {
    const sessionId = this.state.sessionIdForRun(event.runId);
    if (!sessionId) return;
    for (const [socket, subscription] of this.subscribers) {
      if (subscription.sessionId !== sessionId) continue;
      // A browser may attach while the retained previous run is terminal and
      // then start a new turn. Sequence numbers are run-local, so reset the
      // cursor when the broker moves this subscription to that new run.
      if (subscription.runId !== event.runId) {
        subscription.runId = event.runId;
        subscription.afterSequence = 0;
      }
      if (event.sequence <= subscription.afterSequence) continue;
      subscription.afterSequence = event.sequence;
      this.write(socket, { type: "event", event });
    }
    for (const subscription of this.localSubscribers) {
      if (subscription.sessionId !== sessionId) continue;
      if (subscription.runId !== event.runId) {
        subscription.runId = event.runId;
        subscription.afterSequence = 0;
      }
      if (event.sequence <= subscription.afterSequence) continue;
      subscription.afterSequence = event.sequence;
      subscription.listener(event);
    }
  }

  private write(socket: Socket, value: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(value)}\n`);
  }
}

/** Broker client used by the Web server and Electron main process. */
export class NativeRuntimeBrokerClient {
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly options: NativeRuntimeBrokerOptions = {}) {}

  get directory(): string {
    return resolveNativeRuntimeDirectory(this.options.directory);
  }

  async health(): Promise<RuntimeHealth[]> {
    return this.request<RuntimeHealth[]>("health", {});
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.request("list", projectId ? { projectId } : {});
  }

  listWorkspaces(agentType: NativeAgentType, query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    return this.request("listWorkspaces", { agentType, ...query });
  }

  importWorkspace(
    agentType: NativeAgentType,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult> {
    return this.request("importWorkspace", { agentType, path, ...(name ? { name } : {}) });
  }

  listWorkspaceSessions(
    agentType: NativeAgentType,
    workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    return this.request("listWorkspaceSessions", { agentType, workspaceId, ...query });
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.request("refresh", projectId ? { projectId } : {});
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: NativeAgentType }): Promise<UnifiedSessionSummary> {
    return this.request("create", { ...options });
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    return this.request("fork", { sessionId: id });
  }

  async delete(id: string): Promise<void> {
    await this.request("delete", { sessionId: id });
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    return this.request("get", { sessionId: id, ...(query ?? {}) });
  }

  async getQueryIndex(id: string): Promise<SessionQueryIndex> {
    return this.request("getQueryIndex", { sessionId: id });
  }

  async getSessionWatchPath(id: string): Promise<string | null> {
    return this.request("watchPath", { sessionId: id });
  }

  async startRun(
    id: string,
    input: string,
    images?: string[],
    controller: NativeRuntimeController = "web",
    runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">,
  ): Promise<BrokerRunStart> {
    return this.request("startRun", {
      sessionId: id,
      input,
      images,
      controller,
      ...(runOverrides ? { runOverrides } : {}),
    });
  }

  async listModels(agentType: NativeAgentType): Promise<RuntimeModelInfo[]> {
    return this.request("listModels", { agentType });
  }

  async *run(
    id: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    controller: NativeRuntimeController = "desktop",
    runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">,
  ): AsyncIterable<AgentEvent> {
    const started = await this.startRun(id, input, images, controller, runOverrides);
    yield {
      type: "run_admitted",
      _nativeRunId: started.runId,
      _nativeSequence: 0,
    } as unknown as AgentEvent;
    const queue = new AsyncEventQueue<AgentEvent>();
    const unsubscribe = await this.subscribe(id, 0, (event) => {
      if (event.runId !== started.runId) return;
      queue.push({
        ...event.event,
        _nativeRunId: event.runId,
        _nativeSequence: event.sequence,
      } as unknown as AgentEvent);
      if (isTerminalEvent(event.event)) queue.close();
    });
    try {
      for await (const event of queue) yield event;
    } finally {
      unsubscribe();
    }
  }

  async subscribe(id: string, afterSequence: number, listener: (event: BrokerRunEvent) => void): Promise<() => void> {
    await this.ensureHost();
    const socket = await openBrokerSocket(join(this.directory, BROKER_SOCKET_NAME));
    const requestId = randomUUID();
    let settled = false;
    let buffer = "";
    const ready = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              const message = JSON.parse(line) as BrokerResponse | { type?: string; event?: BrokerRunEvent };
              if ("id" in message && message.id === requestId) {
                if (!message.ok) finish(toBrokerError(message.error));
                else finish();
              } else if ("type" in message && message.type === "event" && message.event) {
                listener(message.event);
              }
            } catch {
              finish(new RuntimeSessionError("Malformed broker response", "NATIVE_PROTOCOL_ERROR"));
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new RuntimeSessionError("Native runtime broker disconnected", "RUNTIME_UNAVAILABLE"));
      });
    });
    socket.write(`${JSON.stringify({ id: requestId, method: "subscribe", params: { sessionId: id, afterSequence } })}\n`);
    await ready;
    return () => socket.end();
  }

  async snapshot(id: string, afterSequence = 0): Promise<NativeRuntimeBrokerSnapshot> {
    return this.request("snapshot", { sessionId: id, afterSequence });
  }

  async getGoals(id: string, controller: NativeRuntimeController = "web"): Promise<SessionGoalState> {
    return this.request("getGoals", { sessionId: id, controller });
  }

  async enqueueGoal(
    id: string,
    objective: string,
    sourceMessageId?: string,
    controller: NativeRuntimeController = "web",
  ): Promise<BrokerGoalEnqueueResult> {
    return this.request("enqueueGoal", { sessionId: id, objective, sourceMessageId, controller });
  }

  async enqueueMessage(
    id: string,
    input: BrokerQueuedMessageInput,
    controller: NativeRuntimeController = "web",
  ): Promise<BrokerGoalEnqueueResult> {
    return this.request("enqueueMessage", { sessionId: id, ...input, controller });
  }

  async reorderGoals(id: string, orderedIds: readonly string[]): Promise<SessionGoalState> {
    return this.request("reorderGoals", { sessionId: id, orderedIds: [...orderedIds] });
  }

  async reorderMessages(id: string, orderedIds: readonly string[]): Promise<SessionGoalState> {
    return this.request("reorderMessages", { sessionId: id, orderedIds: [...orderedIds] });
  }

  async updateMessage(
    id: string,
    messageId: string,
    content: string,
    messagePayload?: SessionMessagePayload,
  ): Promise<SessionGoalState> {
    return this.request("updateMessage", { sessionId: id, messageId, content, messagePayload });
  }

  async cancelMessage(id: string, messageId: string): Promise<SessionGoalState> {
    return this.request("cancelMessage", { sessionId: id, messageId });
  }

  async steerMessage(id: string, messageId: string): Promise<BrokerMessageSteerResult> {
    return this.request("steerMessage", { sessionId: id, messageId });
  }

  async cancelGoal(
    id: string,
    goalId: string,
    controller: NativeRuntimeController = "web",
  ): Promise<SessionGoalState> {
    return this.request("cancelGoal", { sessionId: id, goalId, controller });
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.request("answer", { questionId, answer: answer.answer, selectedIndices: answer.selectedIndices });
  }

  async abort(id?: string): Promise<void> {
    await this.request("abort", id ? { sessionId: id } : {});
  }

  async steer(id: string, input: string): Promise<boolean> {
    return this.request("steer", { sessionId: id, input });
  }

  async setPermissionMode(id: string, permissionMode: ToolPermissionMode): Promise<UnifiedSessionSummary> {
    return this.request("setPermissionMode", { sessionId: id, permissionMode });
  }

  async handoff(id: string, controller: NativeRuntimeController): Promise<NativeRuntimeBrokerSnapshot> {
    return this.request("handoff", { sessionId: id, controller });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureHost();
    return this.requestRaw<T>(method, params);
  }

  private async ensureHost(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = (async () => {
      try {
        await this.requestRaw("ping", {});
        return;
      } catch {
        const factory = this.options.runtimeFactory;
        if (!factory) throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
        const directory = this.directory;
        const socketPath = join(directory, BROKER_SOCKET_NAME);
        if (existsSync(socketPath)) {
          try {
            await this.requestRaw("ping", {});
            return;
          } catch {
            // The path was not accepting connections twice, so it is a stale
            // Unix socket rather than a live broker owned by another surface.
            rmSync(socketPath, { force: true });
          }
        }
        const hosts = brokerHosts();
        let host = hosts.get(directory);
        if (!host) {
          host = new NativeRuntimeBrokerHost(directory, factory, this.options.now);
          try {
            await host.start();
            hosts.set(directory, host);
          } catch (error) {
            await host.stop().catch(() => undefined);
            if (!isAddressInUse(error)) throw error;
          }
        }
        await this.requestRaw("ping", {});
      }
    })().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  private async requestRaw<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = await openBrokerSocket(join(this.directory, BROKER_SOCKET_NAME));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        if (!line) return;
        try {
          const response = JSON.parse(line) as BrokerResponse;
          if (response.id !== requestId) return;
          if (!response.ok) finish(toBrokerError(response.error));
          else finish(undefined, response.result as T);
        } catch {
          finish(new RuntimeSessionError("Malformed broker response", "NATIVE_PROTOCOL_ERROR"));
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new RuntimeSessionError("Native runtime broker disconnected", "RUNTIME_UNAVAILABLE"));
      });
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  }
}

/** Adapter facade for a UnifiedSessionService that does not own native processes. */
export class BrokerRuntimeAdapter implements AgentRuntimeAdapter {
  constructor(
    readonly agentType: NativeAgentType,
    private readonly client: NativeRuntimeBrokerClient,
  ) {}

  async health(): Promise<RuntimeHealth> {
    const health = await this.client.health();
    return health.find((entry) => entry.agentType === this.agentType)
      ?? { agentType: this.agentType, available: false, label: this.agentType, error: "Native runtime is unavailable" };
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    return (await this.client.list()).filter((session) => session.agentType === this.agentType);
  }

  listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>> {
    return this.client.listWorkspaces(this.agentType, query);
  }

  importWorkspace(path: string, name?: string): Promise<ImportAgentWorkspaceResult> {
    return this.client.importWorkspace(this.agentType, path, name);
  }

  listWorkspaceSessions(
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    return this.client.listWorkspaceSessions(this.agentType, workspaceId, query);
  }

  getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    return this.client.get(encodeUnifiedSessionId(this.agentType, nativeSessionId));
  }

  getSessionWatchPath(nativeSessionId: string): Promise<string | null> {
    return this.client.getSessionWatchPath(encodeUnifiedSessionId(this.agentType, nativeSessionId));
  }

  create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    return this.client.create({ ...options, agentType: this.agentType });
  }

  fork(nativeSessionId: string): Promise<UnifiedSessionSummary> {
    return this.client.fork(encodeUnifiedSessionId(this.agentType, nativeSessionId));
  }

  delete(nativeSessionId: string): Promise<void> {
    return this.client.delete(encodeUnifiedSessionId(this.agentType, nativeSessionId));
  }

  run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    return this.client.run(
      encodeUnifiedSessionId(this.agentType, nativeSessionId),
      input,
      images,
      undefined,
      undefined,
      "desktop",
      options?.model || options?.reasoningEffort
        ? { ...(options.model ? { model: options.model } : {}), ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) }
        : undefined,
    );
  }

  listModels(): Promise<RuntimeModelInfo[]> {
    return this.client.listModels(this.agentType);
  }

  steer(nativeSessionId: string, input: string): Promise<boolean> {
    return this.client.steer(encodeUnifiedSessionId(this.agentType, nativeSessionId), input);
  }

  abort(nativeSessionId: string): Promise<void> {
    return this.client.abort(encodeUnifiedSessionId(this.agentType, nativeSessionId));
  }

  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.client.answerQuestion(questionId, answer);
  }
}

export function createNativeRuntimeBrokerClient(options: NativeRuntimeBrokerOptions = {}): NativeRuntimeBrokerClient {
  return new NativeRuntimeBrokerClient(options);
}

/**
 * Builds the direct runtime only for the process which successfully becomes
 * broker host. Every other process receives the broker adapter facade above.
 */
export function createNativeRuntimeBrokerHostRuntime(
  codexExecutable?: string,
  callbacks?: Partial<NativeRuntimeBrokerCallbacks>,
  opencodeExecutable?: string,
): UnifiedSessionService {
  const codexClient = new CodexAppServerClient({ executable: codexExecutable || "codex" });
  const codexAdapter = new CodexRuntimeAdapter({
    client: codexClient,
    codexExecutable: codexExecutable || "codex",
    onApprovalResolved: callbacks?.onApprovalResolved,
  });
  const codexCompatibility = callbacks?.codexSessionCatalogRepository
    ? new CodexSessionCompatibilityService(
        codexAdapter,
        new CodexSessionDiskCatalog({
          sessionRoot: join(
            process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
            "sessions",
          ),
          readerVersion: "0.153.0",
          repository: callbacks.codexSessionCatalogRepository,
        }),
      )
    : undefined;
  const opencodeServer = new OpenCodeServerClient({
    executable: opencodeExecutable || "opencode",
    unavailableError: process.env.AGENT_OPENCODE_RUNTIME_ERROR,
  });
  const service = new UnifiedSessionService([
    codexAdapter,
    new ClaudeRuntimeAdapter(),
    new OpenCodeRuntimeAdapter({
      server: opencodeServer,
      executable: opencodeExecutable || "opencode",
      unavailableError: process.env.AGENT_OPENCODE_RUNTIME_ERROR,
      onApprovalResolved: callbacks?.onApprovalResolved,
    }),
  ], () => Promise.resolve([]), callbacks?.importedWorkspaceRepository, codexCompatibility);
  codexCompatibility?.setOnCompatibilityChanged(() => service.invalidateCodexCompatibility());
  codexCompatibility?.start();
  return service;
}

export function resolveNativeRuntimeDirectory(explicit?: string): string {
  return explicit
    || process.env.AGENT_NATIVE_RUNTIME_DIR?.trim()
    || join(homedir(), ".agentroam", "native-runtime");
}

function brokerHosts(): Map<string, NativeRuntimeBrokerHost> {
  const globalWithHosts = globalThis as typeof globalThis & {
    __agentroamNativeRuntimeBrokerHosts?: Map<string, NativeRuntimeBrokerHost>;
  };
  if (!globalWithHosts.__agentroamNativeRuntimeBrokerHosts) {
    globalWithHosts.__agentroamNativeRuntimeBrokerHosts = new Map();
  }
  return globalWithHosts.__agentroamNativeRuntimeBrokerHosts;
}

function decodeNativeSessionId(id: string): { agentType: NativeAgentType; nativeSessionId: string } {
  let decoded: { agentType: AgentType; nativeSessionId: string };
  try {
    decoded = decodeUnifiedSessionId(id);
  } catch (error) {
    if (error instanceof RuntimeSessionError) throw error;
    throw new RuntimeSessionError(`Invalid native session id: ${id}`, "INVALID_SESSION_ID");
  }
  if (decoded.agentType === "customer-agent") {
    throw new RuntimeSessionError("Customer Agent sessions are not handled by the native broker", "INVALID_SESSION_ID");
  }
  return decoded as { agentType: NativeAgentType; nativeSessionId: string };
}

function toRunRecord(row: StoredRunRow): BrokerRunRecord {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    agentType: row.agent_type,
    nativeSessionId: row.native_session_id,
    input: row.input,
    permissionMode: normalizeToolPermissionMode(row.permission_mode),
    controller: row.controller,
    status: row.status,
    nextSequence: row.next_sequence,
    createdAt: row.created_at,
    terminalAt: row.terminal_at,
    goalId: row.goal_id ?? null,
  };
}

function toImportedWorkspace(row: StoredImportedWorkspaceRow): ImportedAgentWorkspace {
  return {
    workspaceId: row.workspace_id,
    agentType: row.agent_type,
    normalizedPath: row.normalized_path,
    name: row.name,
    createdAt: row.created_at,
  };
}

function mergeProjectionMessages(
  messages: Message[],
  run: BrokerRunRecord | null,
  events: BrokerRunEvent[],
): Message[] {
  if (!run) return messages;
  const projected = [...messages];
  let runUserIndex = -1;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const message = projected[index];
    if (message.role !== "user" || message.content !== run.input) continue;
    runUserIndex = index;
    break;
  }
  const hasPersistedRunInput = runUserIndex >= 0;
  let nextUserIndex = projected.length;
  for (let index = runUserIndex + 1; hasPersistedRunInput && index < projected.length; index += 1) {
    if (projected[index].role !== "user") continue;
    nextUserIndex = index;
    break;
  }
  const persistedAssistantText = hasPersistedRunInput
    ? projected
      .slice(runUserIndex + 1, nextUserIndex)
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("")
    : null;
  let consumedAssistantText = 0;
  if (!hasPersistedRunInput) {
    projected.push({ role: "user", content: run.input, name: `__native_run:${run.runId}` });
  }
  const eventMessages: Message[] = [];
  let activeAssistantIndex: number | null = null;
  for (const { event } of events) {
    if (event.type === "reasoning_summary_delta") {
      const name = `__native_reasoning:${run.runId}:${event.itemId}`;
      let index = eventMessages.findIndex((message) => message.name === name);
      if (index < 0) {
        index = eventMessages.length;
        eventMessages.push({ role: "assistant", content: "", name, presentation: { reasoning: [] } });
      }
      const message = eventMessages[index];
      eventMessages[index] = {
        ...message,
        presentation: {
          ...message.presentation,
          reasoning: mergeReasoningSummaryDelta(message.presentation?.reasoning, event),
        },
      };
      activeAssistantIndex = null;
      continue;
    }
    if (event.type !== "text_chunk" && event.type !== "tool_call") continue;
    if (activeAssistantIndex === null) {
      activeAssistantIndex = eventMessages.length;
      eventMessages.push({ role: "assistant", content: "", name: `__native_run:${run.runId}` });
    }
    const message = eventMessages[activeAssistantIndex];
    eventMessages[activeAssistantIndex] = event.type === "text_chunk"
      ? { ...message, content: message.content + event.text }
      : { ...message, toolCalls: [...(message.toolCalls ?? []), event.toolCall] };
  }
  for (const message of eventMessages) {
    const reasoning = message.presentation?.reasoning;
    if (reasoning?.length) {
      const historyIndex = projected.findIndex((entry) => entry.presentation?.reasoning?.some(
        (section) => reasoning.some((candidate) => candidate.itemId === section.itemId),
      ));
      if (historyIndex < 0) {
        projected.push(message);
      } else {
        const historyMessage = projected[historyIndex];
        const historyReasoning = historyMessage.presentation?.reasoning ?? [];
        const merged = [...historyReasoning];
        for (const candidate of reasoning) {
          const index = merged.findIndex((section) => (
            section.itemId === candidate.itemId && section.sectionIndex === candidate.sectionIndex
          ));
          if (index < 0) merged.push(candidate);
          else if (candidate.text.startsWith(merged[index].text)) merged[index] = candidate;
        }
        projected[historyIndex] = {
          ...historyMessage,
          presentation: {
            ...historyMessage.presentation,
            reasoning: merged.sort((left, right) => left.sectionIndex - right.sectionIndex),
          },
        };
      }
      continue;
    }
    const missing = missingProjectionMessage(
      projected,
      message,
      persistedAssistantText?.slice(consumedAssistantText) ?? null,
    );
    consumedAssistantText += missing.consumedAssistantText;
    if (missing.message) projected.push(missing.message);
  }
  return projected;
}

interface NativeTurnCandidate {
  turnIndex: number;
  assistantIndex: number;
  input: string;
  finalText: string;
}

function applyTurnCompletions(
  messages: Message[],
  rows: StoredTurnCompletionRow[],
): Message[] {
  const turns: NativeTurnCandidate[] = [];
  let turnIndex = 0;
  for (let userIndex = 0; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex];
    if (userMessage.role !== "user") continue;
    let nextUserIndex = messages.length;
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === "user") {
        nextUserIndex = index;
        break;
      }
    }
    let assistantIndex = -1;
    for (let index = userIndex + 1; index < nextUserIndex; index += 1) {
      const candidate = messages[index];
      if (
        candidate.role === "assistant"
        && candidate.content.trim()
        && !candidate.toolCalls?.length
        && !candidate.presentation?.reasoning?.length
      ) {
        assistantIndex = index;
      }
    }
    if (assistantIndex >= 0) {
      turns.push({
        turnIndex,
        assistantIndex,
        input: userMessage.content,
        finalText: messages[assistantIndex].content,
      });
    }
    turnIndex += 1;
  }

  const matchableRows = rows.flatMap((row) => {
    const candidateIndexes = turns.flatMap((turn, index) => (
      turn.input === row.input && turn.finalText === row.final_text ? [index] : []
    ));
    return candidateIndexes.length > 0 ? [{ row, candidateIndexes }] : [];
  });
  if (matchableRows.length === 0) return messages;

  const earliest: number[] = [];
  let previous = -1;
  for (const entry of matchableRows) {
    const selected = entry.candidateIndexes.find((candidate) => candidate > previous);
    if (selected === undefined) return messages;
    earliest.push(selected);
    previous = selected;
  }

  const latest = new Array<number>(matchableRows.length);
  let next = turns.length;
  for (let index = matchableRows.length - 1; index >= 0; index -= 1) {
    const candidates = matchableRows[index].candidateIndexes;
    const selected = [...candidates].reverse().find((candidate) => candidate < next);
    if (selected === undefined) return messages;
    latest[index] = selected;
    next = selected;
  }

  const completed = [...messages];
  for (let index = 0; index < matchableRows.length; index += 1) {
    if (earliest[index] !== latest[index]) continue;
    const durationMs = matchableRows[index].row.duration_ms;
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    const messageIndex = turns[earliest[index]].assistantIndex;
    const message = completed[messageIndex];
    completed[messageIndex] = {
      ...message,
      presentation: {
        ...message.presentation,
        completionDurationMs: durationMs,
      },
    };
  }
  return completed;
}

function missingProjectionMessage(
  messages: Message[],
  candidate: Message,
  persistedAssistantText: string | null,
): { message: Message | null; consumedAssistantText: number } {
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  let content = candidate.content;
  let consumedAssistantText = 0;
  if (content && persistedAssistantText !== null) {
    if (content.startsWith(persistedAssistantText)) {
      consumedAssistantText = persistedAssistantText.length;
      content = content.slice(consumedAssistantText);
    } else if (persistedAssistantText.startsWith(content)) {
      consumedAssistantText = content.length;
      content = "";
    }
  } else if (content && assistantMessages.some((message) => message.content === content)) {
    content = "";
  }
  const projectedToolIds = new Set(assistantMessages.flatMap(
    (message) => message.toolCalls?.map((toolCall) => toolCall.id) ?? [],
  ));
  const toolCalls = candidate.toolCalls?.filter((toolCall) => !projectedToolIds.has(toolCall.id));
  return {
    consumedAssistantText,
    message: !content && !toolCalls?.length
      ? null
      : {
          ...candidate,
          content,
          toolCalls: toolCalls?.length ? toolCalls : undefined,
        },
  };
}

function mergePendingSessionContext(
  discovered: UnifiedSessionSummary,
  pending: UnifiedSessionSummary,
): UnifiedSessionSummary {
  return {
    ...discovered,
    cwd: discovered.cwd || pending.cwd,
    projectId: discovered.projectId ?? pending.projectId,
  };
}

function isMaterializedPendingSession(session: UnifiedSessionSummary): boolean {
  if (session.compatibility !== undefined) return false;
  return session.agentType !== "claude-code" || session.sourceLabel !== "Claude Code SDK";
}

function parsePendingSession(value: string): UnifiedSessionSummary | null {
  try {
    const parsed = JSON.parse(value) as Partial<UnifiedSessionSummary>;
    if (
      parsed.agentType !== "claude-code"
      || typeof parsed.id !== "string"
      || typeof parsed.nativeSessionId !== "string"
      || typeof parsed.title !== "string"
      || typeof parsed.cwd !== "string"
      || typeof parsed.created !== "string"
      || typeof parsed.updated !== "string"
      || (parsed.status !== "idle" && parsed.status !== "running")
      || !["available", "owned-externally", "owned-by-customer-agent"].includes(parsed.occupancy ?? "")
      || typeof parsed.sourceLabel !== "string"
      || typeof parsed.canResume !== "boolean"
      || typeof parsed.canDelete !== "boolean"
    ) return null;
    return parsed as UnifiedSessionSummary;
  } catch {
    return null;
  }
}

function parseAgentEvent(value: string): AgentEvent | null {
  try {
    const parsed = JSON.parse(value) as AgentEvent;
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isTerminalEvent(event: AgentEvent): event is Extract<AgentEvent, { type: "done" | "error" }> {
  return event.type === "done" || event.type === "error";
}

function serializeBrokerError(error: unknown): { message: string; code?: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof RuntimeSessionError || error instanceof StaleSessionAnchorError
      ? { code: error.code }
      : {}),
  };
}

function toBrokerError(error?: { message: string; code?: string }): RuntimeSessionError {
  const code = error?.code;
  if (code && isRuntimeErrorCode(code)) return new RuntimeSessionError(error?.message || "Native runtime broker failed", code);
  return new RuntimeSessionError(error?.message || "Native runtime broker failed", "NATIVE_PROTOCOL_ERROR");
}

function isRuntimeErrorCode(value: string): value is ConstructorParameters<typeof RuntimeSessionError>[1] {
  return [
    "INVALID_SESSION_ID",
    "SESSION_NOT_FOUND",
    "SESSION_OCCUPIED",
    "SESSION_ALREADY_RUNNING",
    "RUNTIME_UNAVAILABLE",
    "OPERATION_NOT_SUPPORTED",
    "APPROVAL_EXPIRED",
    "CODEX_SESSION_VERSION_INCOMPATIBLE",
    "STALE_SESSION_ANCHOR",
    "NATIVE_PROTOCOL_ERROR",
  ].includes(value);
}

function requireSessionId(value: string | null): string {
  if (!value) throw new RuntimeSessionError("sessionId is required", "INVALID_SESSION_ID");
  return value;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  return typeof params[key] === "string" ? params[key] : null;
}

function requiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = stringParam(params, key);
  if (!value) throw new RuntimeSessionError(`${key} is required`, "INVALID_SESSION_ID");
  return value;
}

function numberParam(params: Record<string, unknown>, key: string): number | null {
  return typeof params[key] === "number" && Number.isSafeInteger(params[key]) ? params[key] : null;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function arrayOfNumbers(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number") ? value : undefined;
}

function messagePayloadParam(value: unknown): SessionMessagePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  const images = arrayOfStrings(payload.images);
  const agentIds = arrayOfStrings(payload.agentIds);
  const agentName = typeof payload.agentName === "string" ? payload.agentName : undefined;
  return {
    ...(images?.length ? { images } : {}),
    ...(agentIds?.length ? { agentIds } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

function nativeAgentTypeParam(params: Record<string, unknown>, key: string): NativeAgentType {
  const value = stringParam(params, key);
  if (value === "codex" || value === "claude-code" || value === "opencode") return value;
  throw new RuntimeSessionError("A native agent type is required", "INVALID_SESSION_ID");
}

function controllerParam(value: unknown): NativeRuntimeController {
  if (value === "desktop" || value === "web") return value;
  return "web";
}

const NATIVE_REASONING_EFFORTS: readonly NativeReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function runOverridesParam(params: Record<string, unknown>): Pick<RuntimeRunOptions, "model" | "reasoningEffort"> | undefined {
  const raw = params.runOverrides;
  if (!raw || typeof raw !== "object") return undefined;
  const overrides = raw as Record<string, unknown>;
  const modelRaw = overrides.model;
  let model: RuntimeModelSelection | undefined;
  if (modelRaw && typeof modelRaw === "object") {
    const candidate = modelRaw as Record<string, unknown>;
    if (typeof candidate.id === "string" && candidate.id !== "") {
      model = {
        id: candidate.id,
        ...(typeof candidate.providerID === "string" && candidate.providerID !== "" ? { providerID: candidate.providerID } : {}),
      };
    }
  }
  const reasoningEffort = NATIVE_REASONING_EFFORTS.find((effort) => effort === overrides.reasoningEffort);
  if (!model && !reasoningEffort) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function queryParam(params: Record<string, unknown>): SessionHistoryQuery | undefined {
  const before = stringParam(params, "before") || undefined;
  const after = stringParam(params, "after") || undefined;
  const anchor = stringParam(params, "anchor") || undefined;
  const limit = numberParam(params, "limit") ?? undefined;
  return before || after || anchor || limit !== undefined
    ? { before, after, anchor, limit }
    : undefined;
}

function workspaceQueryParam(params: Record<string, unknown>): WorkspaceQuery {
  return {
    cursor: stringParam(params, "cursor"),
    limit: numberParam(params, "limit") ?? undefined,
    refresh: params.refresh === true,
    since: stringParam(params, "since"),
  };
}

function workspaceSessionQueryParam(params: Record<string, unknown>): WorkspaceSessionQuery {
  return {
    cursor: stringParam(params, "cursor"),
    limit: numberParam(params, "limit") ?? undefined,
    refresh: params.refresh === true,
  };
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}

function openBrokerSocket(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeSessionError("Timed out connecting to native runtime broker", "RUNTIME_UNAVAILABLE"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
  });
}
