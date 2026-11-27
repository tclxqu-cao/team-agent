import type { AgentEvent } from "../../domain/agent/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
/** Used at the common native execution boundary, including durable queues. */
export declare class EngineSwitchDelivery {
    private readonly repository;
    constructor(repository: EngineSwitchRepository);
    prepare(sessionId: string, input: string, images?: string[]): {
        input: string;
        images: string[] | undefined;
        confirm: (_event: AgentEvent) => void;
    };
}
//# sourceMappingURL=EngineSwitchDelivery.d.ts.map