import type { ISessionStore, Session } from '../domain/session/entities.js';
import type { Message } from '../domain/model/entities.js';
import type { AgentEvent } from '../domain/agent/entities.js';
import type Database from "better-sqlite3";
export declare class SQLiteSessionStore implements ISessionStore {
    private readonly eventCommit?;
    private readonly baseDir;
    constructor(baseDir: string, eventCommit?: ((db: Database.Database, sessionId: string, event: AgentEvent, at: number) => void) | undefined);
    create(session: Session): Promise<Session>;
    /** Returns projectId if the referenced project exists, otherwise null (FK-safe). */
    private resolveProjectId;
    /** Returns parentSessionId if the referenced session exists, otherwise null (FK-safe). */
    private resolveParentId;
    get(id: string): Promise<Session | null>;
    update(id: string, update: Partial<Session>): Promise<Session>;
    consumePendingAutoTitle(id: string, input: string): Promise<Session | null>;
    delete(id: string): Promise<void>;
    list(projectId?: string): Promise<Session[]>;
    listSummaries(projectId?: string): Promise<{
        id: string;
        projectId: string;
        parentSessionId: string | undefined;
        title: string;
        status: Session["status"];
        created: string;
        updated: string;
        metadata: Record<string, unknown>;
    }[]>;
    listChildren(parentId: string): Promise<Session[]>;
    addMessage(sessionId: string, message: Message): Promise<void>;
    addEvent(sessionId: string, event: AgentEvent): Promise<void>;
    replaceMessages(sessionId: string, messages: Message[]): Promise<void>;
    private rowToSession;
}
//# sourceMappingURL=SQLiteSessionStore.d.ts.map