import type { IAgentLoop, AgentEvent } from '../domain/agent/entities.js';
import type { IAgentFactory, AgentConfig } from '../domain/agent/entities.js';

export class RunAgentUseCase {
  constructor(private readonly agentFactory: IAgentFactory) {}

  async *execute(
    config: AgentConfig,
    input: string,
    sessionId: string,
  ): AsyncIterable<AgentEvent> {
    const agent = this.agentFactory.create(config);
    yield* agent.run(input, sessionId);
  }
}
