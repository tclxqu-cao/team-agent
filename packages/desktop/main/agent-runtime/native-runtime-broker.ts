import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeReasoningSummaryDelta,
  normalizeToolPermissionMode,
  SQLiteDatabase,
  type AgentEvent,
  type Message,
  type SessionHistoryQuery,
  type ToolPermissionMode,
} from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { ClaudeRuntimeAdapter } from "./claude-runtime-adapter.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { CodexRuntimeAdapter } from "./codex-runtime-adapter.js";
import { decodeUnifiedSessionId, encodeUnifiedSessionId } from "./session-id.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  SessionOccupancy,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";
import { UnifiedSessionService } from "./unified-session-service.js";

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

export interface NativeRuntimeBrokerSnapshot {
  sessionId: string;
  runId: string | null;
  snapshotRevision: number;
  events: BrokerRunEvent[];
  controller: NativeRuntimeController | null;
}

export interface NativeRuntimeBrokerCallbacks {
  onApprovalResolved(questionId: string): void;
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
}

interface StoredEventRow {
  run_id: string;
  sequence: number;
  payload: string;
}

interface StoredLockRow {
  session_id: string;
  occupancy: SessionOccupancy;
  revision: number;
  sample_state: "occupied" | "clean" | null;
  sample_at: number | null;
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
class NativeRuntimeBrokerState {
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
        terminal_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS native_runtime_active_run_per_session
        ON native_runtime_run(session_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS native_runtime_runs_by_session
        ON native_runtime_run(session_id, created_at DESC);
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
    `);
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

  admit(input: {
    sessionId: string;
    agentType: NativeAgentType;
    nativeSessionId: string;
    message: string;
    controller: NativeRuntimeController;
  }): BrokerRunRecord {
    const create = this.database.db.transaction(() => {
      const active = this.database.db.prepare(
        "SELECT run_id FROM native_runtime_run WHERE session_id = ? AND status = 'active'",
      ).get(input.sessionId) as { run_id?: string } | undefined;
      if (active?.run_id) {
        throw new RuntimeSessionError("Session is already running", "SESSION_OCCUPIED");
      }
      const createdAt = this.now();
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
      };
      this.database.db.prepare(`
        INSERT INTO native_runtime_run(
          run_id, session_id, agent_type, native_session_id, input, permission_mode,
          controller, status, next_sequence, created_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const sequence = run.nextSequence + 1;
      this.database.db.prepare(
        "INSERT INTO native_runtime_event(run_id, sequence, payload, created_at) VALUES (?, ?, ?, ?)",
      ).run(runId, sequence, JSON.stringify(event), this.now());
      this.database.db.prepare(
        "UPDATE native_runtime_run SET next_sequence = ? WHERE run_id = ?",
      ).run(sequence, runId);
      if (event.type === "ask_user") {
        this.database.db.prepare(`
          INSERT INTO native_runtime_approval(question_id, run_id, state, created_at, resolved_at)
          VALUES (?, ?, 'pending', ?, NULL)
          ON CONFLICT(question_id) DO NOTHING
        `).run(event.questionId, runId, this.now());
      }
      if (isTerminalEvent(event)) this.finalizeRun(runId, event.type === "error" ? event.message : null);
      return { runId, sequence, event } satisfies BrokerRunEvent;
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
      occupancy,
      status: active ? "running" : summary.status,
      canResume: occupancy !== "owned-externally",
      permissionMode: policy,
      occupancyRevision: lock.revision,
      controller: active?.controller ?? null,
    };
  }

  applyDetail(detail: UnifiedSessionDetail): UnifiedSessionDetail {
    const summary = this.applySummary(detail);
    const projection = this.projection(detail.id);
    const messages = mergeProjectionMessages(detail.messages, projection.run, projection.events);
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

  private finalizeRun(runId: string, _reason: string | null): void {
    const run = this.getRunById(runId);
    if (!run || run.status !== "active") return;
    const terminalAt = this.now();
    this.database.db.prepare(`
      UPDATE native_runtime_run SET status = 'terminal', terminal_at = ? WHERE run_id = ?
    `).run(terminalAt, runId);
    this.database.db.prepare(`
      UPDATE native_runtime_approval SET state = 'resolved', resolved_at = ?
      WHERE run_id = ? AND state IN ('pending', 'claimed')
    `).run(terminalAt, runId);
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
  private readonly subscribers = new Map<Socket, BrokerSubscription>();
  private readonly localSubscribers = new Set<LocalBrokerSubscription>();
  private readonly pendingCreations = new Map<string, UnifiedSessionSummary>();
  private server: Server | null = null;
  private ownsSocket = false;

  constructor(
    readonly directory: string,
    runtime: UnifiedSessionService | NativeRuntimeBrokerRuntimeFactory,
    now: () => number = Date.now,
  ) {
    this.state = new NativeRuntimeBrokerState(directory, now);
    this.runtime = typeof runtime === "function"
      ? runtime({ onApprovalResolved: (questionId) => this.handleApprovalResolved(questionId) })
      : runtime;
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
    return this.mergePending(await this.runtime.list(projectId), projectId).map((session) => this.state.applySummary(session));
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.mergePending(await this.runtime.refresh(projectId), projectId).map((session) => this.state.applySummary(session));
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: NativeAgentType }): Promise<UnifiedSessionSummary> {
    const created = await this.runtime.create(options);
    this.pendingCreations.set(created.id, created);
    return this.state.applySummary(created);
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    const forked = await this.runtime.fork(id);
    this.pendingCreations.set(forked.id, forked);
    return this.state.applySummary(forked);
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    try {
      return this.state.applyDetail(await this.runtime.get(id, query));
    } catch (error) {
      const pending = this.pendingCreations.get(id);
      if (!pending) throw error;
      return this.state.applyDetail({ ...pending, messages: [], events: [] });
    }
  }

  getSessionWatchPath(id: string): Promise<string | null> {
    return this.runtime.getSessionWatchPath(id);
  }

  async startRun(
    sessionId: string,
    input: string,
    images?: string[],
    controller: NativeRuntimeController = "web",
  ): Promise<BrokerRunStart> {
    const decoded = decodeNativeSessionId(sessionId);
    try {
      const detail = await this.runtime.get(sessionId);
      if (!detail.canResume || detail.occupancy === "owned-externally") {
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
    });
    void this.executeRun(run, images);
    return {
      runId: run.runId,
      snapshotRevision: run.nextSequence,
      permissionMode: run.permissionMode,
    };
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

  private async executeRun(run: BrokerRunRecord, images?: string[]): Promise<void> {
    let terminalSeen = false;
    try {
      const options: RuntimeRunOptions = {
        permissionMode: run.permissionMode,
        brokerRunId: run.runId,
      };
      for await (const event of this.runtime.run(run.sessionId, run.input, images, undefined, undefined, options)) {
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
      }
      if (!terminalSeen) {
        const recorded = this.state.appendTerminal(run.runId, {
          type: "error",
          code: "NATIVE_PROTOCOL_ERROR",
          message: "Native runtime stopped without a terminal event.",
        });
        if (recorded) this.broadcast(recorded);
      }
    } catch (error) {
      const externallyOwned = error instanceof RuntimeSessionError && error.code === "SESSION_OCCUPIED";
      const recorded = this.state.appendTerminal(run.runId, {
        type: "error",
        code: error instanceof RuntimeSessionError ? error.code : "NATIVE_PROTOCOL_ERROR",
        message: error instanceof Error ? error.message : "Native runtime failed",
      });
      if (recorded) this.broadcast(recorded);
      // appendTerminal releases this broker-owned run first. Only then can an
      // app-server writer-lock failure become an authoritative external lock.
      if (externallyOwned) this.state.recordExplicitExternalOwnership(run.sessionId);
    }
  }

  private handleApprovalResolved(questionId: string): void {
    const event = this.state.resolveApproval(questionId);
    if (event) this.broadcast(event);
  }

  private mergePending(discovered: UnifiedSessionSummary[], projectId?: string): UnifiedSessionSummary[] {
    if (projectId !== undefined) return discovered;
    const seen = new Set(discovered.map((session) => session.id));
    for (const session of discovered) this.pendingCreations.delete(session.id);
    return [...discovered, ...[...this.pendingCreations.values()].filter((session) => !seen.has(session.id))]
      .sort((left, right) => right.updated.localeCompare(left.updated));
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
      case "list": return this.list(stringParam(request.params, "projectId") || undefined);
      case "refresh": return this.refresh(stringParam(request.params, "projectId") || undefined);
      case "create": return this.create({
        agentType: nativeAgentTypeParam(request.params, "agentType"),
        title: stringParam(request.params, "title") || "New session",
        cwd: stringParam(request.params, "cwd") || "",
        ...(stringParam(request.params, "projectId") ? { projectId: stringParam(request.params, "projectId")! } : {}),
      });
      case "fork": return this.fork(requireSessionId(sessionId));
      case "get": return this.get(requireSessionId(sessionId), queryParam(request.params));
      case "watchPath": return this.getSessionWatchPath(requireSessionId(sessionId));
      case "startRun": return this.startRun(
        requireSessionId(sessionId),
        stringParam(request.params, "input") || "",
        arrayOfStrings(request.params.images),
        controllerParam(request.params.controller),
      );
      case "snapshot": return this.snapshot(requireSessionId(sessionId), numberParam(request.params, "afterSequence") ?? 0);
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

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.request("refresh", projectId ? { projectId } : {});
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: NativeAgentType }): Promise<UnifiedSessionSummary> {
    return this.request("create", { ...options });
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    return this.request("fork", { sessionId: id });
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    return this.request("get", { sessionId: id, ...(query ?? {}) });
  }

  async getSessionWatchPath(id: string): Promise<string | null> {
    return this.request("watchPath", { sessionId: id });
  }

  async startRun(id: string, input: string, images?: string[], controller: NativeRuntimeController = "web"): Promise<BrokerRunStart> {
    return this.request("startRun", { sessionId: id, input, images, controller });
  }

  async *run(
    id: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    controller: NativeRuntimeController = "desktop",
  ): AsyncIterable<AgentEvent> {
    const started = await this.startRun(id, input, images, controller);
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

  run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
  ): AsyncIterable<AgentEvent> {
    return this.client.run(
      encodeUnifiedSessionId(this.agentType, nativeSessionId),
      input,
      images,
      undefined,
      undefined,
      "desktop",
    );
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
): UnifiedSessionService {
  const codexClient = new CodexAppServerClient({ executable: codexExecutable || "codex" });
  return new UnifiedSessionService([
    new CodexRuntimeAdapter({
      client: codexClient,
      onApprovalResolved: callbacks?.onApprovalResolved,
    }),
    new ClaudeRuntimeAdapter(),
  ], () => Promise.resolve([]));
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
  };
}

function mergeProjectionMessages(
  messages: Message[],
  run: BrokerRunRecord | null,
  events: BrokerRunEvent[],
): Message[] {
  if (!run) return messages;
  const projected = [...messages];
  const lastUser = [...projected].reverse().find((message) => message.role === "user");
  if (!lastUser || lastUser.content !== run.input) {
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
    const missing = missingProjectionMessage(projected, message);
    if (missing) projected.push(missing);
  }
  return projected;
}

function missingProjectionMessage(messages: Message[], candidate: Message): Message | null {
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const content = candidate.content && assistantMessages.some((message) => message.content === candidate.content)
    ? ""
    : candidate.content;
  const projectedToolIds = new Set(assistantMessages.flatMap(
    (message) => message.toolCalls?.map((toolCall) => toolCall.id) ?? [],
  ));
  const toolCalls = candidate.toolCalls?.filter((toolCall) => !projectedToolIds.has(toolCall.id));
  if (!content && !toolCalls?.length) return null;
  return {
    ...candidate,
    content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
  };
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
    ...(error instanceof RuntimeSessionError ? { code: error.code } : {}),
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
    "RUNTIME_UNAVAILABLE",
    "OPERATION_NOT_SUPPORTED",
    "APPROVAL_EXPIRED",
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

function numberParam(params: Record<string, unknown>, key: string): number | null {
  return typeof params[key] === "number" && Number.isSafeInteger(params[key]) ? params[key] : null;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function arrayOfNumbers(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number") ? value : undefined;
}

function nativeAgentTypeParam(params: Record<string, unknown>, key: string): NativeAgentType {
  const value = stringParam(params, key);
  if (value === "codex" || value === "claude-code") return value;
  throw new RuntimeSessionError("A native agent type is required", "INVALID_SESSION_ID");
}

function controllerParam(value: unknown): NativeRuntimeController {
  if (value === "desktop" || value === "web") return value;
  return "web";
}

function queryParam(params: Record<string, unknown>): SessionHistoryQuery | undefined {
  const before = stringParam(params, "before") || undefined;
  const limit = numberParam(params, "limit") ?? undefined;
  return before || limit !== undefined ? { before, limit } : undefined;
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
