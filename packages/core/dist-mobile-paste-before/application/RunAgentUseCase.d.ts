import type { AgentEvent } from '../domain/agent/entities.js';
import type { IAgentFactory, AgentConfig } from '../domain/agent/entities.js';
export declare class RunAgentUseCase {
    private readonly agentFactory;
    constructor(agentFactory: IAgentFactory);
    execute(config: AgentConfig, input: string, sessionId: string): AsyncIterable<AgentEvent>;
}
//# sourceMappingURL=RunAgentUseCase.d.ts.map