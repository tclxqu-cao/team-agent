import type { ContextHandoff, EngineSwitchRecord, EngineSwitchThread } from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
/**
 * Query/state transitions around the switch ledger and handoff artifacts.
 *
 * Kept separate from the command use case: the run pipeline needs to read the
 * pending handoff and record native acceptance, without going through the
 * switch decision. Broker admission alone never confirms delivery.
 */
export declare class EngineSwitchLedger {
    private readonly repository;
    private readonly now;
    constructor(repository: EngineSwitchRepository, now?: () => string);
    /** All threads, newest activity first. */
    listThreads(): EngineSwitchThread[];
    recordsFor(threadKey: string): EngineSwitchRecord[];
    threadFor(sessionId: string): EngineSwitchThread | null;
    ledger(sessionId: string, includeHistory?: boolean): {
        thread: EngineSwitchThread | null;
        records: EngineSwitchRecord[];
    };
    /** The handoff waiting to be injected into this session's next turn. */
    pendingHandoff(sessionId: string): ContextHandoff | null;
    markHandoffConsumed(handoffId: string): void;
    /** The handoff artifact bound to a switch record (any status). */
    handoffForRecord(recordId: string): ContextHandoff | null;
}
//# sourceMappingURL=EngineSwitchLedger.d.ts.map