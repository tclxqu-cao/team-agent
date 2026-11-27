import type { IUploadStore, UploadEntry, UploadStatus } from '../domain/upload/entities.js';
export declare class SQLiteUploadStore implements IUploadStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(id: string): Promise<UploadEntry | null>;
    save(entry: UploadEntry): Promise<void>;
    delete(id: string): Promise<void>;
    list(): Promise<UploadEntry[]>;
    updateStatus(id: string, status: UploadStatus, error?: string): Promise<void>;
    private rowToEntry;
}
//# sourceMappingURL=SQLiteUploadStore.d.ts.map