import type { AgentType } from "../agent/agent-type.js";
import type { CollaborationGroup, CollaborationStatus, MonitoredSession } from "../collaboration/types.js";
export type { MonitoredSession } from "../collaboration/types.js";
export interface CatalogSession extends MonitoredSession {
  updated: string;
  status: "idle" | "running" | "completed" | "failed";
  canResume: boolean;
  readOnly?: boolean;
  occupancy?: "available" | "owned-by-customer-agent" | "owned-externally";
}
export interface SessionCatalogPage { data: CatalogSession[]; nextCursor: string | null; total: number }
export interface SupervisionQuestion {
  id: string;
  text: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  /** Secret/multiple-field questions are answered in the source UI. */
  requiresSource?: boolean;
}
export interface SessionObservation {
  session: CatalogSession;
  revision: string;
  runId?: string;
  manuallyStopped: boolean;
  questions: SupervisionQuestion[];
  /** Bounded current-turn context. Observed text is data, not policy. */
  context: string;
  terminal?: "done" | "error" | "interrupted";
  hasProgress?: boolean;
  /** Older shared brokers cannot distinguish a user stop from a failure. */
  autoControlAvailable?: boolean;
}
export type SupervisionDecision =
  | { action: "observe"; reason: string }
  | { action: "complete"; reason: string }
  | { action: "continue"; reason: string; message: string }
  | { action: "handoff"; reason: string; message: string; targetSessionId: string }
  | { action: "decision"; reason: string; options?: Array<{ label: string; description: string }>; recommendation?: string };
export interface InterventionReceipt { id: string; runId?: string; accepted: boolean }
export interface SupervisionIncident {
  id: string;
  groupId: string;
  sessionId: string;
  sessionTitle: string;
  fingerprint: string;
  kind: "question" | "recovery" | "handoff" | "delivery" | "blocker" | "observation";
  status: "evaluating" | "executing" | "verifying" | "resolved" | "waiting" | "dismissed";
  message: string;
  createdAt: string;
  updatedAt: string;
  question?: SupervisionQuestion;
  recommendation?: string;
  options?: Array<{ label: string; description: string }>;
  targetSessionId?: string;
  actionId?: string;
  receipt?: InterventionReceipt;
  beforeRevision?: string;
  beforeRunId?: string;
  attempts: number;
  notifiedAt?: string;
}
export interface SupervisionCursor {
  revision: string;
  status: CatalogSession["status"];
  terminal?: SessionObservation["terminal"];
  recoveryAttempts: number;
  lastRecoveryAt?: number;
  lastEvaluatedAt?: number;
}
export interface SupervisionState {
  groupId: string;
  group: CollaborationGroup;
  paused: boolean;
  generation: number;
  updatedAt: string;
  cursors: Record<string, SupervisionCursor>;
  incidents: SupervisionIncident[];
  /** Internal diagnostic sessions, excluded from ordinary session discovery. */
  sessions: Record<string, string>;
}
export interface SupervisionAlert {
  groupName: string;
  incident: SupervisionIncident;
  target?: MonitoredSession;
}
export interface DashboardGroup {
  group: CollaborationGroup;
  status: CollaborationStatus;
  updated: string;
  progress: string;
  runningCount: number;
  decisionCount: number;
  discussionId?: string;
  questions: Array<{ discussionId: string; questionId: string; text: string; decisionRevision?: number; options?: Array<{ label: string; description: string }> }>;
  sessions: Array<MonitoredSession & { status?: string }>;
  supervision?: SupervisionState;
  configurationChanged?: boolean;
}
export interface SessionDashboardSnapshot {
  groups: DashboardGroup[];
  groupTotal: number;
  decisionTotal?: number;
  agents: Array<{ agentType: AgentType; sessions: CatalogSession[] }>;
  updatedAt: string;
  discoveryError?: string;
}
