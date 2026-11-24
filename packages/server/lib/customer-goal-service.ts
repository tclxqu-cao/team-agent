import { agentHost } from "../app/api/agent-host";
import { SharedCustomerQueue } from "@agent/core";

const state = globalThis as typeof globalThis & { __sharedCustomerQueue?: SharedCustomerQueue };
const activeQueueRuns = new Set<string>();
export function getCustomerGoalCoordinator(): SharedCustomerQueue {
  return state.__sharedCustomerQueue ??= new SharedCustomerQueue(
    agentHost.getSessionStore(),
    (id) => agentHost.isSessionRunning(id),
    async (id, item) => {
      activeQueueRuns.add(id);
      try {
        await agentHost.startRun(item.objective, id, item.messagePayload?.images, {
          agentIds: item.messagePayload?.agentIds,
          ...(item.messagePayload?.runOptions?.profileId ? { profileId: item.messagePayload.runOptions.profileId } : {}),
        }).completion;
        return (await agentHost.getSessionStore().get(id))?.status === "completed" ? "completed" : "failed";
      } finally { activeQueueRuns.delete(id); }
    },
    (id) => { if (activeQueueRuns.has(id)) agentHost.abort(id); },
    (id, text) => agentHost.steer(text, id),
    (id, queue) => agentHost.getSessionStore().saveGoalQueue(id, queue, new Date().toISOString()),
  );
}
export function resumeCustomerQueues() {
  for (const id of agentHost.getSessionStore().listSessionsWithGoalQueue()) getCustomerGoalCoordinator().resume(id);
}
