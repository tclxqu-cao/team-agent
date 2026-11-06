import type { AgentType } from "@agent/core";

export type RoutingMode = "model" | "rules";
export type MessageEvent = "completed" | "failed" | "waiting";
export type ExecutionStatus = "pending" | "dispatching" | "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | "unknown";
export interface ChannelMessage {
  sourceId: string;
  connectionId: string;
  channel: "wecom" | "webhook";
  conversationId: string;
  conversationName: string;
  conversationType?: "direct" | "group" | "unknown";
  peerUserId?: string;
  senderId: string;
  text: string;
  occurredAt: string;
  directMention: boolean;
  ownMessage: boolean;
  raw: Record<string, unknown>;
}
export interface RoutingCandidate {
  projectId: string; projectName: string; description: string;
  agents: AgentType[];
}
export interface RoutingDecision {
  action: "dispatch" | "reply" | "review" | "ignore";
  reason: string;
  projectId?: string;
  agentType?: AgentType;
  model?: string;
  knowledgeQuery?: string;
  knowledge?: MessageKnowledge;
}
export interface RoutingContext { text: string; projectId?: string; role?: "user" | "assistant"; }
export interface MessageRecognition {
  kind: "task" | "reply" | "review" | "ignore";
  reason: string;
  knowledgeQuery?: string;
  model?: string;
}
export interface MessageKnowledge { query: string; status: string; sources: string[]; }
export interface MessageReply {
  text: string;
  model: string;
  knowledge: MessageKnowledge;
}
export interface MessageRecord {
  id: string;
  source: ChannelMessage;
  receivedAt: string;
  updatedAt: string;
  routing: { status: "pending" | "routing" | "routed" | "review" | "ignored"; mode: RoutingMode; error?: string; decision?: RoutingDecision; initialDecision?: RoutingDecision; confirmedByUser?: boolean; candidates?: RoutingCandidate[]; context?: RoutingContext[]; recognition?: MessageRecognition };
  execution: { status: ExecutionStatus; sessionId?: string; queueItemId?: string; runId?: string; projectName?: string; lastSequence: number; result?: string; reply?: Omit<MessageReply, "text">; error?: string; startedAt?: string; finishedAt?: string };
  timeline: Array<{ at: string; stage: string; text: string }>;
  revision: number;
}
export interface DeliveryRecord {
  id: string; messageId: string; eventId: string; event: MessageEvent;
  target: { kind: "origin" | "wecom" | "webhook"; address: string; label: string };
  text: string;
  purpose?: "reply";
  status: "pending" | "sending" | "sent" | "failed" | "unknown" | "blocked";
  attempts: number; nextAttemptAt: number; createdAt: string; updatedAt: string;
  receipt?: string; error?: string;
}
export interface MessagingSettings {
  enabled: boolean;
  routingMode: RoutingMode;
  source: { database: string; accountId: string };
  rules: Array<{ conversationId: string; projectId: string; agentType: AgentType }>;
  subscriptions: Array<{ id: string; enabled: boolean; events: MessageEvent[]; kind: "wecom" | "webhook"; address: string; label: string }>;
}
export const DEFAULT_MESSAGING_SETTINGS: MessagingSettings = {
  enabled: false, routingMode: "model", source: { database: "", accountId: "" }, rules: [], subscriptions: [],
};
export interface MessagingWorkerStatus {
  state: "paused" | "starting" | "listening" | "error";
  updatedAt: string; error?: string; lastCollectedAt?: string;
  stages?: Partial<Record<"collect" | "route" | "execute" | "deliver", { state: "running" | "idle" | "error"; updatedAt: string; error?: string }>>;
}
export type MessagingCommand =
  | { action: "list"; before?: string; query?: string; filter?: string }
  | { action: "detail"; id: string }
  | { action: "settings" }
  | { action: "saveSettings"; settings: MessagingSettings }
  | { action: "discover" }
  | { action: "retryDelivery"; id: string }
  | { action: "resolve"; id: string; projectId: string; agentType: AgentType };
export interface MessagingList {
  messages: Array<Omit<MessageRecord, "source"> & { source: Omit<ChannelMessage, "raw">; deliveryStatus: DeliveryRecord["status"] | "none" }>;
  nextCursor: string | null;
  counts: { total: number; review: number; running: number; completed: number; deliveryFailed: number };
  worker: MessagingWorkerStatus;
}
