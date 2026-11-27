import type { ISettingsStore, SettingsData } from '../domain/settings/entities.js';
export declare class SQLiteSettingsStore implements ISettingsStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(key: string): string | null;
    set(key: string, value: string): void;
    getAll(): SettingsData;
    saveAll(settings: SettingsData): void;
    delete(key: string): void;
}
//# sourceMappingURL=SQLiteSettingsStore.d.ts.map