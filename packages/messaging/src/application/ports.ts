import type { ChannelMessage, DeliveryRecord, ExecutionStatus, MessageRecord, MessageReply, MessagingSettings, RoutingCandidate, RoutingDecision, RoutingContext, MessageRecognition, MessagingWorkerStatus } from "../domain/types.js";

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
export interface MessageRecognizer {
  recognize(message: ChannelMessage, context: RoutingContext[]): Promise<MessageRecognition>;
}
export interface MessageRouter {
  route(message: ChannelMessage, candidates: RoutingCandidate[], context: RoutingContext[], recognition: MessageRecognition): Promise<RoutingDecision>;
}
export interface MessageReplies { reply(record: MessageRecord): Promise<MessageReply>; }
export interface MessagingExecution {
  candidates(): Promise<RoutingCandidate[]>;
  createSession(record: MessageRecord): Promise<string>;
  dispatch(record: MessageRecord): Promise<{ queueItemId: string; runId?: string }>;
  observe(record: MessageRecord): Promise<ExecutionObservation>;
}
export interface DeliveryResult { status: "sent" | "failed" | "unknown" | "blocked"; receipt?: string; error?: string; }
export interface MessageSender { send(delivery: DeliveryRecord, source: ChannelMessage): Promise<DeliveryResult>; }
export interface MessagingDependencies {
  recognizer: MessageRecognizer;
  router: MessageRouter;
  execution: MessagingExecution;
  replies: MessageReplies;
  sender: MessageSender;
}
export interface MessageDiscovery { sources: Array<{ database: string; accountId: string }>; error?: string; }
export interface MessageSource {
  collect(): Promise<void>;
  discover(): Promise<MessageDiscovery>;
}
export interface MessagingSourceStore {
  settings(): MessagingSettings;
  saveSettings(settings: MessagingSettings): void;
  state<T>(key: string, fallback: T): T;
  setState(key: string, value: unknown): void;
  ingestBatch(messages: ChannelMessage[], cursorKey: string, cursor: unknown): void;
  status(value: MessagingWorkerStatus): void;
}
export interface MessagingWorkerStore {
  settings(): MessagingSettings;
  active(): MessageRecord[];
  deliveries(): DeliveryRecord[];
  worker(): MessagingWorkerStatus;
  status(value: MessagingWorkerStatus): void;
  lease(owner: string, duration?: number): boolean;
  release(owner: string): void;
}
