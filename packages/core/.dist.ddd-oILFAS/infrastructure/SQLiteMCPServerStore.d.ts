import type { MCPServerConfig } from '../domain/mcp/entities.js';
export declare class SQLiteMCPServerStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(id: string): Promise<MCPServerConfig | null>;
    save(config: MCPServerConfig): Promise<void>;
    delete(id: string): Promise<void>;
    list(): Promise<MCPServerConfig[]>;
    listAll(): Promise<MCPServerConfig[]>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    private rowToConfig;
}
//# sourceMappingURL=SQLiteMCPServerStore.d.ts.map