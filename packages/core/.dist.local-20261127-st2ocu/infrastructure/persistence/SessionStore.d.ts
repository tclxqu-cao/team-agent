import type { ISessionStore, Session } from '../../domain/session/entities.js';
import type { Message } from '../../domain/model/entities.js';
import type { AgentEvent } from '../../domain/agent/entities.js';
export declare class InMemorySessionStore implements ISessionStore {
    private readonly sessions;
    create(session: Session): Promise<Session>;
    get(id: string): Promise<Session | null>;
    update(id: string, update: Partial<Session>): Promise<Session>;
    delete(id: string): Promise<void>;
    list(projectId?: string): Promise<Session[]>;
    listChildren(parentId: string): Promise<Session[]>;
    addMessage(sessionId: string, message: Message): Promise<void>;
    addEvent(sessionId: string, event: AgentEvent): Promise<void>;
    replaceMessages(sessionId: string, messages: Message[]): Promise<void>;
}
export declare class FileSystemSessionStore implements ISessionStore {
    private readonly sessionsDir;
    private readonly memory;
    constructor(baseDir: string);
    private ensureDir;
    create(session: Session): Promise<Session>;
    get(id: string): Promise<Session | null>;
    update(id: string, update: Partial<Session>): Promise<Session>;
    delete(id: string): Promise<void>;
    list(projectId?: string): Promise<Session[]>;
    listChildren(parentId: string): Promise<Session[]>;
    addMessage(sessionId: string, message: Message): Promise<void>;
    addEvent(sessionId: string, event: AgentEvent): Promise<void>;
    replaceMessages(sessionId: string, messages: Message[]): Promise<void>;
    private persistSession;
}
//# sourceMappingURL=SessionStore.d.ts.map