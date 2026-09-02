import type {
  AgentEvent,
  Message,
  SessionHistoryWindow,
  ToolPermissionMode,
} from "@agent/core";

export type AgentType = "customer-agent" | "codex" | "claude-code";

export type SessionOccupancy =
  | "available"
  | "owned-by-customer-agent"
  | "owned-externally";

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

export interface CreateRuntimeSessionOptions {
  title: string;
  cwd: string;
  projectId?: string;
}

export interface RuntimeQuestionAnswer {
  answer: string;
  selectedIndices?: number[];
}

/**
 * Per-turn values supplied by the shared native runtime broker. They are kept
 * separate from the session policy because a policy update must not alter an
 * already admitted turn.
 */
export interface RuntimeRunOptions {
  permissionMode?: ToolPermissionMode;
  brokerRunId?: string;
}

export interface AgentRuntimeAdapter {
  readonly agentType: AgentType;
  health(): Promise<RuntimeHealth>;
  discoverSessions(): Promise<UnifiedSessionSummary[]>;
  getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
  getSessionWatchPath?(nativeSessionId: string): Promise<string | null>;
  create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
  fork?(nativeSessionId: string): Promise<UnifiedSessionSummary>;
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
  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
  delete?(nativeSessionId: string): Promise<void>;
  dispose?(): Promise<void>;
}

export class RuntimeSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_SESSION_ID"
      | "SESSION_NOT_FOUND"
      | "SESSION_OCCUPIED"
      | "RUNTIME_UNAVAILABLE"
      | "OPERATION_NOT_SUPPORTED"
      | "APPROVAL_EXPIRED"
      | "NATIVE_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "RuntimeSessionError";
  }
}
