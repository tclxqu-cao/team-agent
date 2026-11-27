import type { ILSPServerStore, LSPServerConfig } from '../domain/lsp/entities.js';
export declare class SQLiteLSPServerStore implements ILSPServerStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(id: string): Promise<LSPServerConfig | null>;
    save(config: LSPServerConfig): Promise<void>;
    delete(id: string): Promise<void>;
    /** Only enabled servers */
    list(): Promise<LSPServerConfig[]>;
    /** All servers including disabled */
    listAll(): Promise<LSPServerConfig[]>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    private rowToConfig;
}
//# sourceMappingURL=SQLiteLSPServerStore.d.ts.map