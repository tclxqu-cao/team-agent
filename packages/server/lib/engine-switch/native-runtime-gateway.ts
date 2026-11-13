import type {
  AgentType,
  EngineSwitchCreatedSession,
  EngineSwitchHealth,
  EngineSwitchRuntime,
  EngineSwitchSessionView,
} from "@agent/core";
import { getNativeRuntimeService } from "../native-runtime-service";
import { materializeEngineHistory } from "./history-artifact";

/**
 * Infrastructure adapter: the domain's EngineSwitchRuntime port on top of the
 * existing native runtime service. Mapping stays here; the domain never sees
 * protocol payloads or unified-session ids as anything but opaque refs.
 */
export function createNativeRuntimeEngineSwitchGateway(): EngineSwitchRuntime {
  const service = () => getNativeRuntimeService();
  return {
    materializeHistory: materializeEngineHistory,
    async health(): Promise<readonly EngineSwitchHealth[]> {
      const entries = await service().health();
      return entries.map((entry) => ({
        agentType: entry.agentType,
        available: entry.available,
        label: entry.label,
        ...(entry.error ? { error: entry.error } : {}),
      }));
    },

    async getSession(sessionId: string): Promise<EngineSwitchSessionView> {
      const detail = await service().get(sessionId);
      // Capture the native paging space once at the switch boundary. Codex's
      // full transcript includes tool carriers that its core ordinal omits.
      const boundary = await service().get(sessionId, {
        limit: 1, ...(detail.agentType === "codex" ? { view: "core" as const } : {}),
      });
      const queue = detail.goalState;
      const jobs = await service().listBackgroundJobs(sessionId).catch((error) => {
        if (error?.code === "OPERATION_NOT_SUPPORTED") return [];
        throw error;
      });
      const nativeGoal = await service().getNativeGoal(sessionId).catch((error) => {
        if (error?.code === "OPERATION_NOT_SUPPORTED") return null;
        throw error;
      });
      const busy = jobs.some((job) => job.status === "running" || job.status === "stopping");
      const switchBlockReason = queue?.active || queue?.queued.length
        ? "会话还有未结束的目标或排队消息，请完成或取消后切换"
        : busy ? "会话仍有后台任务运行，请结束后切换"
          : nativeGoal?.activation === "armed" && nativeGoal.phase !== "complete"
            ? "原生目标仍在执行，请暂停后切换" : undefined;
      const todos = [...detail.events].reverse().find((event) => event.type === "todo_update");
      return {
        id: detail.id,
        agentType: detail.agentType,
        title: detail.title,
        cwd: detail.cwd,
        ...(detail.projectId ? { projectId: detail.projectId } : {}),
        status: detail.status,
        occupancy: String(detail.occupancy),
        canResume: detail.canResume,
        readOnly: detail.readOnly,
        canDelete: detail.canDelete,
        switchBlockReason,
        workStateText: JSON.stringify({ cwd: detail.cwd,
          todos: todos?.type === "todo_update" ? todos.todos : [],
          nativeGoal, backgroundJobs: jobs.map(({ id, label, status }) => ({ id, label, status })),
        }),
        messages: detail.messages,
        historyItemCount: boundary.history?.totalItems,
        historyLastId: boundary.messages.filter((message) => message.role === "user" || message.role === "assistant").at(-1)?.historyId,
      };
    },

    async createSession(options: {
      agentType: AgentType;
      cwd: string;
      projectId?: string;
      title: string;
    }): Promise<EngineSwitchCreatedSession> {
      const summary = await service().create({
        agentType: options.agentType,
        cwd: options.cwd,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        title: options.title,
      });
      return {
        id: summary.id,
        agentType: summary.agentType,
        title: summary.title,
        cwd: summary.cwd,
        status: summary.status,
        occupancy: summary.occupancy,
        canResume: summary.canResume,
        readOnly: summary.readOnly,
        canDelete: summary.canDelete,
        ...(summary.projectId ? { projectId: summary.projectId } : {}),
      };
    },
  };
}
