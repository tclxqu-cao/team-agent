import { type CollaborationGroup } from "../../domain/collaboration/types.js";
import type { SupervisionState } from "../../domain/supervision/types.js";
import type { SupervisionRepository, SupervisionRuntime } from "./ports.js";
export declare function monitoringConfiguration(group: CollaborationGroup): string;
/** Background use cases. No viewers, database implementation or agent SDK required. */
export declare class SupervisionService {
    readonly repository: SupervisionRepository;
    private readonly groups;
    private readonly runtime;
    private readonly now;
    private readonly id;
    private readonly reportError;
    private readonly owner;
    private readonly jobs;
    private readonly nextCheck;
    private readonly answers;
    constructor(repository: SupervisionRepository, groups: () => CollaborationGroup[], runtime: SupervisionRuntime, now?: () => number, id?: () => string, reportError?: (error: unknown) => void);
    private group;
    private initial;
    private at;
    private supervisor;
    private supervisorType;
    private message;
    private incidentChanges;
    private receiveReceipt;
    apply(groupId: string): SupervisionState;
    pause(groupId: string, paused: boolean): SupervisionState;
    /** Deletion cleanup also works for a previously deleted group and is safe to retry. */
    stop(groupId: string): void;
    private persist;
    private assertActive;
    tick(): Promise<void>;
    /** Tests and graceful shutdown may await currently admitted checks. */
    get runningChecks(): number;
    private incident;
    private notify;
    private check;
    private process;
    answer(groupId: string, incidentId: string, answer: string, indices?: number[]): Promise<SupervisionState>;
    private answerDecision;
}
//# sourceMappingURL=SupervisionService.d.ts.map