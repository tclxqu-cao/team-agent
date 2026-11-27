import type { Database } from "better-sqlite3";
import type { AgentType } from "../domain/agent/agent-type.js";
import type { ContextHandoff, EngineSwitchRecord, EngineSwitchThread } from "../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../domain/engine-switch/EngineSwitchRepository.js";
export declare class SQLiteEngineSwitchRepository implements EngineSwitchRepository {
    private readonly db;
    constructor(db: Database);
    /** Copy legacy server-owned ledgers once, without overwriting broker state. */
    importLegacy(legacy: SQLiteEngineSwitchRepository): void;
    acquire(threadKey: string, owner: string, expiresAt: number): boolean;
    release(threadKey: string, owner: string): void;
    isLocked(threadKey: string): boolean;
    commit(input: Parameters<EngineSwitchRepository["commit"]>[0]): void;
    readonly threads: {
        ensure: (thread: EngineSwitchThread) => void;
        get: (threadKey: string) => EngineSwitchThread | null;
        setSession: (threadKey: string, currentSessionId: string, currentAgentType: AgentType) => void;
        list: () => EngineSwitchThread[];
    };
    readonly records: {
        append: (record: EngineSwitchRecord) => void;
        list: (threadKey: string, includeHistory?: boolean) => EngineSwitchRecord[];
        latestInvolving: (threadKey: string, agentType: AgentType) => EngineSwitchRecord | null;
        latestFromTo: (fromSessionId: string, toAgentType: AgentType) => EngineSwitchRecord | null;
        threadOfSession: (sessionId: string) => string | null;
    };
    readonly handoffs: {
        summariesForThread: (threadKey: string) => Array<{
            summaryText: string;
        }>;
        insert: (handoff: ContextHandoff) => void;
        pendingForSession: (toSessionId: string) => ContextHandoff | null;
        markConsumed: (id: string, consumedAt: string) => void;
        supersedePendingForThread: (threadKey: string, at: string) => void;
        byRecord: (recordId: string) => ContextHandoff | null;
    };
}
//# sourceMappingURL=SQLiteEngineSwitchRepository.d.ts.map