import type Database from "better-sqlite3";
import type { TodoItem } from "../domain/agent/entities";
import { TodoApplicationService } from "../application/todo";
type CompletionEvidence = {
    kind: "session";
    messageStart: number;
    eventStart: number;
    terminalEventId: number;
} | {
    kind: "native";
    input: string;
    finalText: string;
    plan: TodoItem[];
} | {
    kind: "reported";
    titles: string[];
};
interface CompletionJob {
    ownerId: string;
    sessionId: string;
    runId: string;
    startedAt: number;
    evidence: CompletionEvidence;
}
export declare function enqueueTodoCompletion(db: Database.Database, job: CompletionJob): void;
/** Called on the worker's own WAL connection. Use a read snapshot until the first write.
 * An interrupted transaction leaves the job ready for replay. */
export declare function processNextTodoCompletion(db: Database.Database, todos: TodoApplicationService, now?: number): boolean;
export {};
//# sourceMappingURL=SQLiteTodoCompletionQueue.d.ts.map