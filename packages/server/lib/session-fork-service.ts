import { randomUUID } from "node:crypto";
import { sessionHistoryMessageId, type ISessionStore, type SessionForkPoint } from "@agent/core";
import { completedForkMessageIndex, RuntimeSessionError, type UnifiedSessionSummary } from "@agent/native-runtime";

export async function forkCustomerSession(
  store: ISessionStore,
  id: string,
  point: SessionForkPoint,
  isRunning: boolean,
): Promise<UnifiedSessionSummary> {
  if (!point.messageId) throw new RuntimeSessionError("Customer Agent Fork 需要消息 ID", "INVALID_SESSION_ID");
  const source = await store.get(id);
  if (!source) throw new RuntimeSessionError("会话不存在", "SESSION_NOT_FOUND");
  let ordinal = 0;
  const messages = source.messages.map((message) => ({
    ...message,
    ...((message.role === "user" || message.role === "assistant")
      ? { historyId: sessionHistoryMessageId(ordinal++, message) }
      : {}),
  }));
  const end = completedForkMessageIndex(messages, point.messageId, isRunning || source.status === "failed" || source.status === "aborted");
  const now = new Date().toISOString();
  const forked = await store.create({
    id: randomUUID(),
    projectId: source.projectId,
    title: `${source.title}（副本）`,
    status: "idle",
    messages: [],
    events: [],
    metadata: { permissionMode: source.metadata.permissionMode, forkedFrom: id },
    created: now,
    updated: now,
  });
  try {
    // SQLiteSessionStore.create persists the header only; write the transcript explicitly.
    await store.replaceMessages(forked.id, structuredClone(source.messages.slice(0, end + 1)));
  } catch (error) {
    await store.delete(forked.id).catch(() => undefined);
    throw error;
  }
  return {
    id: forked.id,
    nativeSessionId: forked.id,
    agentType: "customer-agent",
    projectId: forked.projectId,
    title: forked.title,
    cwd: "",
    status: "idle",
    occupancy: "available",
    sourceLabel: "Customer Agent",
    canResume: true,
    canDelete: true,
    created: forked.created,
    updated: forked.updated,
  };
}
