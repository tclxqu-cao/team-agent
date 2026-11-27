import type Database from "better-sqlite3";
import { type StoredToolExecutionPolicy, type ToolExecutionPolicy, type ToolExecutionPolicyStore } from "../domain/tool/execution-policy.js";
export declare class SQLiteToolExecutionPolicyStore implements ToolExecutionPolicyStore {
    private readonly db;
    constructor(baseDirOrDatabase: string | Database);
    list(): Promise<StoredToolExecutionPolicy[]>;
    get(id: string): Promise<StoredToolExecutionPolicy | null>;
    save(value: ToolExecutionPolicy): Promise<StoredToolExecutionPolicy>;
    delete(id: string): Promise<boolean>;
}
//# sourceMappingURL=SQLiteToolExecutionPolicyStore.d.ts.map