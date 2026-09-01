import type { AgentEvent, Message } from "@agent/core";

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
}

export interface UnifiedSessionDetail extends UnifiedSessionSummary {
  messages: Message[];
  events: AgentEvent[];
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

export interface AgentRuntimeAdapter {
  readonly agentType: AgentType;
  health(): Promise<RuntimeHealth>;
  discoverSessions(): Promise<UnifiedSessionSummary[]>;
  getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
  create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
  run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
  ): AsyncIterable<AgentEvent>;
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
      | "NATIVE_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "RuntimeSessionError";
  }
}
