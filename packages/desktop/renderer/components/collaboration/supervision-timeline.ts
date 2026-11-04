import type { CollaborationMessage } from "../../../../core/src/domain/collaboration/types";
import type { SupervisionMessage } from "../../../../core/src/domain/supervision/types";

export function mergeSupervisionMessages(existing: SupervisionMessage[], incoming: SupervisionMessage[]): SupervisionMessage[] {
  return [...new Map([...existing, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
}

export type GroupTimelineEntry = { kind: "discussion"; message: CollaborationMessage } | { kind: "supervision"; message: SupervisionMessage };
export function groupTimeline(messages: CollaborationMessage[], supervision: SupervisionMessage[]): GroupTimelineEntry[] {
  return [
    ...messages.filter(message => message.kind !== "progress").map(message => ({ kind: "discussion" as const, message })),
    ...supervision.map(message => ({ kind: "supervision" as const, message })),
  ].sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt)
    || (a.kind === "supervision" && b.kind === "supervision" ? (a.message.sequence ?? 0) - (b.message.sequence ?? 0) : 0)
    || a.message.id.localeCompare(b.message.id));
}
