import { type AgentType } from "../agent/agent-type.js";
export interface ParallelSessionIdentity {
    id: string;
    agentType: AgentType;
}
/** An association of independent sessions; transcripts stay in their original runtime. */
export interface ParallelSessionGroup<T extends ParallelSessionIdentity = ParallelSessionIdentity> {
    id: string;
    title: string;
    cwd: string;
    created: string;
    members: T[];
}
export interface CreateParallelSessionsInput {
    title: string;
    cwd: string;
    agentTypes: AgentType[];
}
export declare function parallelAgentTypes(value: unknown): AgentType[];
export declare function createParallelSessions<T extends ParallelSessionIdentity>(input: CreateParallelSessionsInput, ports: {
    create(agentType: AgentType, title: string, cwd: string): Promise<T>;
    remove(id: string): Promise<void>;
    save(group: ParallelSessionGroup<T>): void | Promise<void>;
}): Promise<ParallelSessionGroup<T>>;
//# sourceMappingURL=ParallelSessions.d.ts.map