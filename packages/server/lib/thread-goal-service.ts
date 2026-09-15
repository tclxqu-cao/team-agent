// ── Thread Goal Service 单例（server 组合根）──
// 依赖倒置接线：SQLiteThreadGoalStore + AgentHost 驱动 + SSE 通知。
// agentHost.onRunSettled 是目标模式的空闲钩子；threadGoalToolsProvider 注册模型工具。
import {
  SQLiteThreadGoalStore,
  ThreadGoalService,
  createThreadGoalTools,
  type ThreadGoal,
} from "@agent/core";
import { agentHost, CustomerAgentRunConflictError } from "../app/api/agent-host";
import { getServerBaseDir } from "./server-data-dir";

const state = globalThis as typeof globalThis & { __threadGoalService?: ThreadGoalService };

export function getThreadGoalService(): ThreadGoalService {
  if (state.__threadGoalService) return state.__threadGoalService;

  const service = new ThreadGoalService(
    new SQLiteThreadGoalStore(getServerBaseDir()),
    {
      isSessionRunning: (sessionId) => agentHost.isSessionRunning(sessionId),
      startTurn: async (sessionId, input) => {
        if (agentHost.isSessionRunning(sessionId)) return false;
        try {
          // 不 await completion：本轮 run 自己的 settle 会再次触发钩子，形成续跑链。
          void agentHost.startRun(input, sessionId, undefined, { source: "goal" }).completion.catch(() => {});
          return true;
        } catch (error) {
          if (error instanceof CustomerAgentRunConflictError) return false;
          throw error;
        }
      },
      steerHidden: (sessionId, content) => agentHost.steer(content, sessionId, "__goal__"),
      sessionExists: async (sessionId) => Boolean(await agentHost.getSessionStore().get(sessionId)),
    },
    {
      onUpdated: (sessionId, goal: ThreadGoal) => agentHost.publishExternal(sessionId, { type: "goal_updated", goal }),
      onCleared: (sessionId) => agentHost.publishExternal(sessionId, { type: "goal_cleared", sessionId }),
    },
  );

  agentHost.onRunSettled = (info) => {
    void service.onRunSettled({
      sessionId: info.sessionId,
      failed: info.failed,
      usageLimited: info.usageLimited,
      tokens: info.newTokens,
      seconds: info.durationMs / 1000,
    }).catch(() => {});
  };
  agentHost.threadGoalToolsProvider = (sessionId) => createThreadGoalTools(service, sessionId);
  state.__threadGoalService = service;
  return service;
}

/** 进程重启后恢复续跑：所有 active 目标若会话空闲则继续推进。 */
export function resumeThreadGoals(): void {
  void getThreadGoalService().resumeInterrupted().catch(() => {});
}
