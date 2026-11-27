import type { SupervisionRepository } from "../application/supervision/ports.js";
import type { SupervisionMessage, SupervisionMessagePage, SupervisionMessageQuery, SupervisionState } from "../domain/supervision/types.js";
/** Durable scopes and cross-group intervention leases share the host database. */
export declare class SQLiteSupervisionRepository implements SupervisionRepository {
    private readonly db;
    constructor(baseDir: string);
    get(groupId: string): SupervisionState | null;
    initialize(state: SupervisionState): SupervisionState;
    save(state: SupervisionState, expectedGeneration?: number, messages?: SupervisionMessage[]): boolean;
    appendMessage(message: SupervisionMessage): void;
    private backfillHistory;
    listMessages(groupId: string, query?: SupervisionMessageQuery): SupervisionMessagePage;
    claim(groupId: string, owner: string, now: number, ttl: number): boolean;
    claimTarget(sessionId: string, owner: string, now: number, ttl: number): boolean;
    internalSessionIds(): Set<string>;
}
//# sourceMappingURL=SQLiteSupervisionRepository.d.ts.map