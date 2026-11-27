import type { PluginManifest } from '../domain/plugin/entities.js';
export declare class SQLitePluginStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(name: string): Promise<PluginManifest | null>;
    save(manifest: PluginManifest): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<{
        name: string;
        version: string;
        manifest: PluginManifest;
    }[]>;
    listAll(): Promise<{
        name: string;
        version: string;
        manifest: PluginManifest;
    }[]>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    private rowToManifest;
}
//# sourceMappingURL=SQLitePluginStore.d.ts.map