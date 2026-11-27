import type { IMemoryStore, MemoryEntry, MemorySearchResult } from './entities.js';
export declare class FileSystemMemoryStore implements IMemoryStore {
    private readonly memoryDir;
    constructor(baseDir: string);
    private ensureDir;
    get(name: string): Promise<MemoryEntry | null>;
    set(entry: MemoryEntry): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<MemoryEntry[]>;
    search(query: string): Promise<MemorySearchResult[]>;
    generateContext(query: string, maxTokens?: number): Promise<string>;
    getIndex(): Promise<string>;
    private parseMemoryFile;
    private formatMemoryFile;
    private updateIndex;
    private removeFromIndex;
}
//# sourceMappingURL=FileSystemMemoryStore.d.ts.map