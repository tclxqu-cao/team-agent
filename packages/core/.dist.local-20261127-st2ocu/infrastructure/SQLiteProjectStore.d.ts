import type { IProjectStore, Project } from '../domain/project/entities.js';
export declare class SQLiteProjectStore implements IProjectStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(id: string): Promise<Project | null>;
    create(project: Project): Promise<Project>;
    update(id: string, update: Partial<Project>): Promise<Project>;
    delete(id: string): Promise<void>;
    list(): Promise<Project[]>;
    private rowToProject;
}
//# sourceMappingURL=SQLiteProjectStore.d.ts.map