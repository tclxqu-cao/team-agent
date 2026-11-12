// ── Engine switch domain ────────────────────────────────────────────────────
//
// One logical conversation thread can span several engine sessions: a run of
// Codex, then Claude Code, then back to Codex. The thread is the app-visible
// identity; engine native session ids are refs. Every switch writes an
// auditable record + a materialized context handoff.

import type { AgentType } from "../agent/agent-type.js";
import type { Message } from "../model/entities.js";

/** How the target engine session was obtained. */
export type EngineSwitchStrategy = "resume" | "create";

/** What the handoff bridges. */
export type HandoffStrategy = "delta" | "full";

export type HandoffStatus = "pending" | "consumed" | "failed" | "superseded";

export interface EngineSwitchThread {
  threadKey: string;
  /** The unified session id currently owning the thread. */
  currentSessionId: string;
  currentAgentType: AgentType;
  created: string;
  updated: string;
}

export interface EngineSwitchRecord {
  id: string;
  threadKey: string;
  fromSessionId: string;
  fromAgentType: AgentType;
  toSessionId: string;
  toAgentType: AgentType;
  strategy: EngineSwitchStrategy;
  handoffId: string | null;
  /** Cursor in the source session's own history space (last bridged historyId). */
  coveredThroughHistoryId: string | null;
  at: string;
}

export interface ContextHandoff {
  id: string;
  threadKey: string;
  fromSessionId: string;
  fromAgentType: AgentType;
  toSessionId: string;
  toAgentType: AgentType;
  strategy: HandoffStrategy;
  /** Deterministic, budget-bounded historical context (never an instruction). */
  summaryText: string;
  /**
   * historyIds of source items that did not fit the budget. Kept in full for
   * audit and on-demand re-read; wire responses trim the list.
   */
  omittedHistoryIds: string[];
  status: HandoffStatus;
  createdBy: "user" | "agent" | "system";
  created: string;
  consumedAt: string | null;
}

/**
 * The domain's minimal view of an engine session. Infrastructure adapters map
 * their runtime-specific detail onto this shape; the domain never sees
 * protocol payloads.
 */
export interface EngineSwitchSessionView {
  id: string;
  agentType: AgentType;
  title: string;
  cwd: string;
  projectId?: string;
  status: "idle" | "running" | "completed" | "failed";
  occupancy: string;
  canResume?: boolean;
  messages: Message[];
}

export interface EngineSwitchHealth {
  agentType: AgentType;
  available: boolean;
  label: string;
  error?: string;
}

/** Resolved session returned after a create (summary shape). */
export interface EngineSwitchCreatedSession {
  id: string;
  agentType: AgentType;
  title: string;
  cwd: string;
  projectId?: string;
}
