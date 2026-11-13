import type { AgentType } from "../agent/agent-type.js";
import type {
  ContextHandoff,
  EngineSwitchRecord,
  EngineSwitchThread,
} from "./entities.js";

/**
 * Persistence port for engine-switch state.
 *
 * Infrastructure adapters (SQLite today) own the schema; the domain only sees
 * these operations. All queries are scoped to a thread or a concrete session —
 * native session ids are never matched globally.
 */
export interface EngineSwitchRepository {
  /** Cross-process switch lease. Run admission checks the same lease. */
  acquire(threadKey: string, owner: string, expiresAt: number): boolean;
  release(threadKey: string, owner: string): void;
  isLocked(threadKey: string): boolean;
  commit(input: {
    thread: EngineSwitchThread;
    expectedSessionId: string | null;
    owner: string;
    record: EngineSwitchRecord;
    handoff: ContextHandoff | null;
  }): void;
  threads: {
    ensure(thread: EngineSwitchThread): void;
    get(threadKey: string): EngineSwitchThread | null;
    setSession(threadKey: string, currentSessionId: string, currentAgentType: AgentType): void;
    list(): EngineSwitchThread[];
  };
  records: {
    append(record: EngineSwitchRecord): void;
    list(threadKey: string, includeHistory?: boolean): EngineSwitchRecord[];
    /** Most recent record that involved `agentType` (as source or target), or null. */
    latestInvolving(threadKey: string, agentType: AgentType): EngineSwitchRecord | null;
    /** Most recent record bridging this exact source session to `toAgentType`. */
    latestFromTo(fromSessionId: string, toAgentType: AgentType): EngineSwitchRecord | null;
    /** The thread a session belongs to (as source or target), or null. */
    threadOfSession(sessionId: string): string | null;
  };
  handoffs: {
    insert(handoff: ContextHandoff): void;
    pendingForSession(toSessionId: string): ContextHandoff | null;
    markConsumed(id: string, consumedAt: string): void;
    /** Retire every pending handoff in a thread before a newer one lands. */
    supersedePendingForThread(threadKey: string, at: string): void;
    byRecord(recordId: string): ContextHandoff | null;
  };
}
