import {
  ChannelDelivery, ConversationalReply, KnowledgeMessageRouter, MessageIntake, MessagingService, MessagingWorker,
  ModelMessageRecognizer, SQLiteMessagingRepository, WecomSource, WikiKnowledge, sendWecomNative,
} from "@agent/messaging";
import { ServerMessagingExecution } from "./execution";
import { messagingModel } from "./model";
import { getServerBaseDir } from "../server-data-dir";

interface ServerMessagingModule {
  repository: SQLiteMessagingRepository;
  service: MessagingService;
  worker: MessagingWorker;
  execution: ServerMessagingExecution;
  intake: MessageIntake;
}
const global = globalThis as typeof globalThis & { __messaging?: ServerMessagingModule };

/** Host composition only: messaging owns its pipeline; the host owns model settings and Agent execution. */
export function messagingService(): ServerMessagingModule {
  if (!global.__messaging) {
    const baseDir = getServerBaseDir();
    const repository = new SQLiteMessagingRepository(baseDir);
    const intake = new MessageIntake(repository, new WecomSource(repository, { baseDir }));
    const execution = new ServerMessagingExecution();
    const knowledge = new WikiKnowledge();
    const sender = new ChannelDelivery(undefined, (delivery, source, text) => sendWecomNative(delivery, source, text,
      { baseDir, settings: () => repository.settings().source, refresh: () => intake.collect() }));
    const service = new MessagingService(repository, {
      recognizer: new ModelMessageRecognizer(messagingModel),
      router: new KnowledgeMessageRouter(messagingModel, knowledge),
      replies: new ConversationalReply(messagingModel, knowledge), execution, sender,
    });
    global.__messaging = { repository, intake, execution, service, worker: new MessagingWorker(repository, service, intake) };
  }
  return global.__messaging;
}
