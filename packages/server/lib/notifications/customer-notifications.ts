import type Database from "better-sqlite3";
import { SQLiteTodoUnitOfWork, persistNotification, type AgentEvent } from "@agent/core";
import { anonymousPrincipal } from "../web-auth/anonymous";
/** Called inside SQLiteSessionStore.addEvent's transaction, before UI delivery. */
export function commitCustomerNotification(db: Database.Database, sessionId: string, event: AgentEvent, at: number): void {
  if (!["ask_user", "approval_resolved", "done", "error", "turn_aborted"].includes(event.type)) return;
  const ownerId = anonymousPrincipal().userId;
  new SQLiteTodoUnitOfWork(db).run(tx => {
    if (["approval_resolved", "done", "error", "turn_aborted"].includes(event.type)) for (const n of tx.notifications.list(ownerId)) {
      if (n.kind === "approval" && n.sessionId === sessionId && (event.type !== "approval_resolved" || n.questionId === event.questionId)) tx.notifications.put({ ...n, dismissedAt: at });
    }
    if (event.type === "ask_user") persistNotification(tx, { ownerId, sourceEventId: `${sessionId}:${event.questionId}:approval`, kind: "approval", sessionId, questionId: event.questionId, title: "需要你的确认", body: event.question.slice(0, 500), createdAt: at });
    const row = db.prepare("SELECT metadata FROM sessions WHERE id=?").get(sessionId) as { metadata: string } | undefined;
    const source = row ? JSON.parse(row.metadata).customerAgentActiveRun?.source : undefined;
    if (event.type === "done" && event.result?.status === "completed" && source !== "goal") persistNotification(tx, { ownerId, sourceEventId: `${sessionId}:${event.result.runId}:completed`, kind: "completion", sessionId, title: "会话已完成", body: event.finalText.slice(0, 500), createdAt: at });
  });
}
