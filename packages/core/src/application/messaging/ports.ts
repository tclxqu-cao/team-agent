import type { ChannelMessage, DeliveryRecord, ExecutionStatus, MessageRecord, MessagingSettings, RoutingCandidate, RoutingDecision, RoutingContext } from "../../domain/messaging/types.js";

export interface MessagingRepository {
  settings(): MessagingSettings;
  saveSettings(settings: MessagingSettings): void;
  insert(source: ChannelMessage): MessageRecord;
  get(id: string): MessageRecord | null;
  save(record: MessageRecord): void;
  commit(record: MessageRecord, deliveries: DeliveryRecord[]): void;
  pending(): MessageRecord[];
  context(source: ChannelMessage): RoutingContext[];
  active(): MessageRecord[];
  binding(key: string): string | null;
  bind(key: string, sessionId: string): void;
  addDelivery(delivery: DeliveryRecord): void;
  deliveries(messageId?: string): DeliveryRecord[];
  delivery(id: string): DeliveryRecord | null;
  saveDelivery(delivery: DeliveryRecord): void;
}
export interface ExecutionObservation {
  status: ExecutionStatus;
  sequence?: number;
  runId?: string; queueItemId?: string;
  events: Array<{ id: string; sequence: number; kind: "completed" | "failed" | "waiting"; text: string }>;
  error?: string;
}
export interface MessagingRuntime {
  candidates(): Promise<RoutingCandidate[]>;
  route(message: ChannelMessage, candidates: RoutingCandidate[], context?: RoutingContext[]): Promise<RoutingDecision>;
  createSession(record: MessageRecord): Promise<string>;
  dispatch(record: MessageRecord): Promise<{ queueItemId: string; runId?: string }>;
  observe(record: MessageRecord): Promise<ExecutionObservation>;
  send(delivery: DeliveryRecord, source: ChannelMessage): Promise<{ status: "sent" | "failed" | "unknown" | "blocked"; receipt?: string; error?: string }>;
}
