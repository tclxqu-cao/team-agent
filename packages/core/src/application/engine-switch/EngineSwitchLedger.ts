import type {
  ContextHandoff,
  EngineSwitchRecord,
  EngineSwitchThread,
} from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";

/**
 * Query/state transitions around the switch ledger and handoff artifacts.
 *
 * Kept separate from the command use case: the run pipeline needs to read the
 * pending handoff before admitting a turn and mark it consumed after
 * admission, without going through the switch decision.
 */
export class EngineSwitchLedger {
  constructor(
    private readonly repository: EngineSwitchRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** All threads, newest activity first. */
  listThreads(): EngineSwitchThread[] {
    return this.repository.threads.list();
  }

  recordsFor(threadKey: string): EngineSwitchRecord[] {
    return this.repository.records.list(threadKey);
  }

  threadFor(sessionId: string): EngineSwitchThread | null {
    const threadKey = this.repository.records.threadOfSession(sessionId);
    return threadKey ? this.repository.threads.get(threadKey) : null;
  }

  ledger(sessionId: string): { thread: EngineSwitchThread | null; records: EngineSwitchRecord[] } {
    const threadKey = this.repository.records.threadOfSession(sessionId);
    if (!threadKey) return { thread: null, records: [] };
    return {
      thread: this.repository.threads.get(threadKey),
      records: this.repository.records.list(threadKey),
    };
  }

  /** The handoff waiting to be injected into this session's next turn. */
  pendingHandoff(sessionId: string): ContextHandoff | null {
    return this.repository.handoffs.pendingForSession(sessionId);
  }

  markHandoffConsumed(handoffId: string): void {
    this.repository.handoffs.markConsumed(handoffId, this.now());
  }

  /** The handoff artifact bound to a switch record (any status). */
  handoffForRecord(recordId: string): ContextHandoff | null {
    return this.repository.handoffs.byRecord(recordId);
  }
}
