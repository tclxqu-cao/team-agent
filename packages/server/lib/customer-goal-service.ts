import { SessionGoalCoordinator } from "@agent/core";
import { agentHost } from "../app/api/agent-host";

const globalWithGoals = globalThis as typeof globalThis & {
  __customerGoalCoordinator?: SessionGoalCoordinator;
};
const activeGoalRuns = new Set<string>();

export function getCustomerGoalCoordinator(): SessionGoalCoordinator {
  if (!globalWithGoals.__customerGoalCoordinator) {
    globalWithGoals.__customerGoalCoordinator = new SessionGoalCoordinator(
      agentHost.getSessionStore(),
      async (sessionId, objective) => {
        while (agentHost.hasActiveRun()) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        activeGoalRuns.add(sessionId);
        try {
          await agentHost.run(objective, sessionId);
        } finally {
          activeGoalRuns.delete(sessionId);
        }
        const session = await agentHost.getSessionStore().get(sessionId);
        return session?.status === "failed"
          ? { outcome: "failed", reason: "Customer Agent goal run failed" }
          : { outcome: "completed" };
      },
      (sessionId) => {
        if (activeGoalRuns.has(sessionId)) agentHost.abort(sessionId);
      },
    );
  }
  return globalWithGoals.__customerGoalCoordinator;
}
