import type { AgentType } from "../agent/agent-type.js";
import type {
  EngineSwitchCreatedSession,
  EngineSwitchHealth,
  EngineSwitchSessionView,
} from "./entities.js";

/**
 * Runtime port: what the switch decision needs from the engine layer.
 *
 * Implemented in the server by a gateway over the native runtime service.
 * Keeping this port in the domain layer is what makes the decision tree
 * testable without spawning engines.
 */
export interface EngineSwitchRuntime {
  health(): Promise<readonly EngineSwitchHealth[]>;
  getSession(sessionId: string): Promise<EngineSwitchSessionView>;
  createSession(options: {
    agentType: AgentType;
    cwd: string;
    projectId?: string;
    title: string;
  }): Promise<EngineSwitchCreatedSession>;
}
