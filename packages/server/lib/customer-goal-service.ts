import { getDatabase } from "@agent/core";
import { agentHost } from "../app/api/agent-host";
import { SharedCustomerQueue } from "./shared-customer-queue";
import { getServerBaseDir } from "./server-data-dir";

const state = globalThis as typeof globalThis & { __sharedCustomerQueue?: SharedCustomerQueue };
const activeQueueRuns = new Set<string>();
export function getCustomerGoalCoordinator(): SharedCustomerQueue {
  return state.__sharedCustomerQueue ??= new SharedCustomerQueue(
    agentHost.getSessionStore(),
    (id) => agentHost.isSessionRunning(id),
    async (id, item) => {
      activeQueueRuns.add(id);
      try {
        await agentHost.startRun(item.objective, id, item.messagePayload?.images, { agentIds: item.messagePayload?.agentIds }).completion;
        return (await agentHost.getSessionStore().get(id))?.status === "completed" ? "completed" : "failed";
      } finally { activeQueueRuns.delete(id); }
    },
    (id) => { if (activeQueueRuns.has(id)) agentHost.abort(id); },
    (id, text) => agentHost.steer(text, id),
    (id, queue) => {
      getDatabase(getServerBaseDir()).db.prepare("UPDATE sessions SET metadata = json_set(metadata, '$.goalState', json(?)), updated = ? WHERE id = ?")
        .run(JSON.stringify(queue), new Date().toISOString(), id);
    },
  );
}
export function resumeCustomerQueues() {
  const rows = getDatabase(getServerBaseDir()).db.prepare("SELECT id FROM sessions WHERE json_extract(metadata, '$.goalState.active') IS NOT NULL OR json_array_length(metadata, '$.goalState.queued') > 0").all() as Array<{ id: string }>;
  for (const row of rows) getCustomerGoalCoordinator().resume(row.id);
}
