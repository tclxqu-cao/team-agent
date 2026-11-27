import type { ISessionStore, Session } from '../domain/session/entities.js';
export declare class ManageSessionUseCase {
    private readonly sessionStore;
    constructor(sessionStore: ISessionStore);
    create(title: string, projectId?: string): Promise<Session>;
    get(id: string): Promise<Session | null>;
    list(): Promise<Session[]>;
    delete(id: string): Promise<void>;
    complete(id: string): Promise<Session>;
    abort(id: string): Promise<Session>;
}
//# sourceMappingURL=ManageSessionUseCase.d.ts.map