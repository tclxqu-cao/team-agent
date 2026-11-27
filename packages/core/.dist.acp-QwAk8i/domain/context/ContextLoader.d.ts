import type { IContextLoader, ProjectFile } from './entities.js';
export declare class ContextLoader implements IContextLoader {
    private readonly homeDirectory;
    constructor(homeDirectory?: string);
    loadProjectContext(rootDir: string): Promise<ProjectFile[]>;
    loadFile(filePath: string): Promise<ProjectFile>;
    private loadRecursiveFile;
    findClaudeMdFiles(rootDir: string): Promise<string[]>;
}
//# sourceMappingURL=ContextLoader.d.ts.map