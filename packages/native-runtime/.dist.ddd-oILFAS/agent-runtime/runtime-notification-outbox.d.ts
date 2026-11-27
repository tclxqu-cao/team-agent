import type Database from "better-sqlite3";
import type { AgentEvent } from "@agent/core";
import type { RuntimeTodoContext } from "./runtime-tool-injection";
/** This database is the Broker's, not the service's. Delivery is at-least-once,
 * and the destination service persists the stable source event before ACK. */
export declare class RuntimeNotificationOutbox {
    private readonly db;
    private flushing;
    private closed;
    private readonly timer;
    constructor(db: Database.Database);
    get(sessionId: string): RuntimeTodoContext | undefined;
    sessionForExecution(context: RuntimeTodoContext): string | undefined;
    set(sessionId: string, context: RuntimeTodoContext): void;
    append(sessionId: string, runId: string, sequence: number, event: AgentEvent, createdAt: number, resolveDestination: () => RuntimeTodoContext | undefined): void;
    bindRun(context: RuntimeTodoContext, runId: string): Promise<void>;
    flush(): Promise<void>;
    close(): void;
}
//# sourceMappingURL=runtime-notification-outbox.d.ts.map