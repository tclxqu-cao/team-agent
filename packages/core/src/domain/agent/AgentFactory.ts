import type { IAgentLoop, IAgentFactory, AgentConfig } from './entities.js';
import { AgentLoop } from './AgentLoop.js';

export class AgentFactory implements IAgentFactory {
  create(config: AgentConfig): IAgentLoop {
    return new AgentLoop(config);
  }
}
