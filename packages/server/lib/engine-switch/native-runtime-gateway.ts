import type {
  AgentType,
  EngineSwitchCreatedSession,
  EngineSwitchHealth,
  EngineSwitchRuntime,
  EngineSwitchSessionView,
} from "@agent/core";
import { getNativeRuntimeService } from "../native-runtime-service";

/**
 * Infrastructure adapter: the domain's EngineSwitchRuntime port on top of the
 * existing native runtime service. Mapping stays here; the domain never sees
 * protocol payloads or unified-session ids as anything but opaque refs.
 */
export function createNativeRuntimeEngineSwitchGateway(): EngineSwitchRuntime {
  const service = () => getNativeRuntimeService();
  return {
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
      return {
        id: detail.id,
        agentType: detail.agentType,
        title: detail.title,
        cwd: detail.cwd,
        ...(detail.projectId ? { projectId: detail.projectId } : {}),
        status: detail.status,
        occupancy: String(detail.occupancy),
        canResume: detail.canResume,
        messages: detail.messages,
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
        ...(summary.projectId ? { projectId: summary.projectId } : {}),
      };
    },
  };
}
