import type {
  AgentEvent,
  Message,
  SessionGoalState,
  SessionHistoryQuery,
  SessionHistoryWindow,
  SessionQueryIndex,
  SessionToolResultBody,
  SessionToolResultRef,
  ToolPermissionMode,
} from "@agent/core";

export type AgentType = "customer-agent" | "codex" | "claude-code" | "opencode";

export type SessionOccupancy =
  | "available"
  | "owned-by-customer-agent"
  | "owned-externally";

export type SessionCompatibilityStatus =
  | "checking"
  | "direct"
  | "migratable"
  | "incompatible";

export type CodexCompatibilityReasonCode =
  | "CODEX_SESSION_VERSION_UNSUPPORTED"
  | "CODEX_SESSION_SCHEMA_UNKNOWN"
  | "CODEX_SESSION_DIRECT_READ_FAILED"
  | "CODEX_SESSION_IMPORT_UNAVAILABLE"
  | "CODEX_SESSION_MIGRATION_FAILED"
  | "CODEX_SESSION_SOURCE_ACTIVE"
  | "CODEX_SESSION_ASSET_REQUIRED"
  | "CODEX_SESSION_RUNTIME_UNAVAILABLE";

export interface SessionCompatibility {
  status: SessionCompatibilityStatus;
  producerVersion?: string;
  readerVersion: string;
  formatKey?: string;
  reasonCode?: CodexCompatibilityReasonCode;
  reason?: string;
}

export interface RuntimeHealth {
  agentType: AgentType;
  available: boolean;
  label: string;
  version?: string;
  error?: string;
}

export interface UnifiedSessionSummary {
  id: string;
  agentType: AgentType;
  nativeSessionId: string;
  title: string;
  cwd: string;
  projectId?: string;
  parentSessionId?: string;
  created: string;
  updated: string;
  status: "idle" | "running" | "completed" | "failed";
  occupancy: SessionOccupancy;
  sourceLabel: string;
  canResume: boolean;
  canDelete: boolean;
  permissionMode?: ToolPermissionMode;
  /** Monotonic broker-owned lock revision; raw process scans must not override a newer value. */
  occupancyRevision?: number;
  /** Logical AgentRoam client currently allowed to control a live native turn. */
  controller?: "web" | "desktop" | null;
  goalState?: SessionGoalState;
  messageQueueVersion?: 1;
  compatibility?: SessionCompatibility;
  migratedFrom?: string;
}

export interface UnifiedSessionDetail extends UnifiedSessionSummary {
  messages: Message[];
  events: AgentEvent[];
  history?: SessionHistoryWindow;
  /** Last replayable event sequence included in this detail snapshot. */
  snapshotRevision?: number;
  /** Broker run identity paired with snapshotRevision for reconnect safety. */
  snapshotRunId?: string | null;
}

export type { SessionQueryIndex };

export interface AgentWorkspace {
  agentType: AgentType;
  workspaceId: string;
  name: string;
  roots: string[];
  order: number;
  updatedAt?: string;
  source: "native" | "derived" | "imported";
  canCreateSession?: boolean;
}

export interface ImportedAgentWorkspace {
  agentType: Exclude<AgentType, "customer-agent">;
  workspaceId: string;
  normalizedPath: string;
  name: string;
  createdAt: number;
}

export interface ImportAgentWorkspaceResult {
  workspace: AgentWorkspace;
  existing: boolean;
}

export interface ImportedAgentWorkspaceRepository {
  list(agentType: Exclude<AgentType, "customer-agent">): ImportedAgentWorkspace[];
  findByPath(
    agentType: Exclude<AgentType, "customer-agent">,
    normalizedPath: string,
  ): ImportedAgentWorkspace | null;
  save(workspace: ImportedAgentWorkspace): { workspace: ImportedAgentWorkspace; existing: boolean };
}

export interface WorkspacePage<T> {
  data: T[];
  nextCursor: string | null;
  watermark: string | null;
  stale?: boolean;
}

export interface WorkspaceQuery {
  cursor?: string | null;
  limit?: number;
  refresh?: boolean;
  since?: string | null;
}

export interface WorkspaceSessionQuery {
  cursor?: string | null;
  limit?: number;
  refresh?: boolean;
}

export interface CreateRuntimeSessionOptions {
  title: string;
  cwd: string;
  projectId?: string;
}

export interface RuntimeQuestionAnswer {
  answer: string;
  selectedIndices?: number[];
}

/** Reasoning effort levels accepted by native runtimes (no "off" — that is customer-agent only). */
export type NativeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Model a turn should run on. `providerID` is required by runtimes that namespace models per provider (opencode). */
export interface RuntimeModelSelection {
  id: string;
  providerID?: string;
}

/** A model offered by a runtime's own connection, as surfaced in the composer model picker. */
export interface RuntimeModelInfo {
  id: string;
  providerID?: string;
  displayName?: string;
  description?: string;
  reasoningEfforts?: NativeReasoningEffort[];
}

/**
 * Per-turn values supplied by the shared native runtime broker. They are kept
 * separate from the session policy because a policy update must not alter an
 * already admitted turn.
 */
export interface RuntimeRunOptions {
  permissionMode?: ToolPermissionMode;
  brokerRunId?: string;
  model?: RuntimeModelSelection;
  reasoningEffort?: NativeReasoningEffort;
  goal?: {
    id: string;
    objective: string;
  };
}

export interface AgentRuntimeAdapter {
  readonly agentType: AgentType;
  health(): Promise<RuntimeHealth>;
  discoverSessions(): Promise<UnifiedSessionSummary[]>;
  listWorkspaces?(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
  listWorkspaceSessions?(
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>>;
  listWorkspaceSessionsByPath?(
    cwd: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>>;
  importWorkspace?(
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult>;
  getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
  /**
   * Source-paginated history window over the runtime's own protocol. When
   * implemented, it must serve ALL windowed query kinds (limit/before/after/
   * anchor) with one self-consistent ordinal space, because the renderer
   * treats cursors, historyIds and anchors as opaque but cross-referencing.
   * Must throw OPERATION_NOT_SUPPORTED when the runtime cannot serve it, so
   * callers fall back to getSession + in-memory pagination.
   */
  getSessionPaged?(nativeSessionId: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
  getSessionToolResult?(
    nativeSessionId: string,
    ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">,
  ): Promise<SessionToolResultBody>;
  /** Query index over the same ordinal space as getSessionPaged; null when paging is unavailable. */
  getQueryIndex?(nativeSessionId: string): Promise<SessionQueryIndex | null>;
  getSessionWatchPath?(nativeSessionId: string): Promise<string | null>;
  create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
  restoreDraft?(summary: UnifiedSessionSummary): void;
  fork?(nativeSessionId: string): Promise<UnifiedSessionSummary>;
  renameSession?(nativeSessionId: string, title: string): Promise<void>;
  run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent>;
  steer?(nativeSessionId: string, input: string): Promise<boolean>;
  abort(nativeSessionId: string): Promise<void>;
  release?(nativeSessionId: string): Promise<void>;
  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
  archiveSession?(nativeSessionId: string): Promise<void>;
  delete?(nativeSessionId: string): Promise<void>;
  /** Models the runtime's own connection offers; undefined when the runtime cannot enumerate them. */
  listModels?(): Promise<RuntimeModelInfo[]>;
  dispose?(): Promise<void>;
}

export class RuntimeSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_SESSION_ID"
      | "SESSION_NOT_FOUND"
      | "SESSION_OCCUPIED"
      | "SESSION_ALREADY_RUNNING"
      | "RUNTIME_UNAVAILABLE"
      | "OPERATION_NOT_SUPPORTED"
      | "APPROVAL_EXPIRED"
      | "CODEX_SESSION_VERSION_INCOMPATIBLE"
      | "STALE_SESSION_ANCHOR"
      | "NATIVE_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "RuntimeSessionError";
  }
}
