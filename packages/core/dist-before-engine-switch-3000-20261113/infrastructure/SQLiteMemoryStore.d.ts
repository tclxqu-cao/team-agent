import type { IMemoryStore, MemoryEntry, MemorySearchResult } from '../domain/memory/entities.js';
export declare class SQLiteMemoryStore implements IMemoryStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(name: string): Promise<MemoryEntry | null>;
    set(entry: MemoryEntry): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<MemoryEntry[]>;
    search(query: string): Promise<MemorySearchResult[]>;
    generateContext(query: string, maxTokens?: number): Promise<string>;
    getIndex(): Promise<string>;
    private rowToEntry;
}
//# sourceMappingURL=SQLiteMemoryStore.d.ts.map