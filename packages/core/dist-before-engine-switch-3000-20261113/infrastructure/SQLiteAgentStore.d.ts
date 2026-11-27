import type { IAgentDefinitionStore, AgentDefinition } from '../domain/agent/entities.js';
export declare class SQLiteAgentStore implements IAgentDefinitionStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(id: string): Promise<AgentDefinition | null>;
    list(): Promise<AgentDefinition[]>;
    create(agent: AgentDefinition): Promise<AgentDefinition>;
    update(id: string, update: Partial<Omit<AgentDefinition, 'id' | 'created'>>): Promise<AgentDefinition>;
    delete(id: string): Promise<void>;
}
//# sourceMappingURL=SQLiteAgentStore.d.ts.map