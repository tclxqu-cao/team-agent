import type Database from "better-sqlite3";
import type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from "../domain/remote-tools/entities.js";
import type { RemoteToolStore } from "../domain/remote-tools/RemoteToolStore.js";
export declare class SQLiteRemoteToolStore implements RemoteToolStore {
    private readonly db;
    constructor(db: Database);
    upsertTools(projectId: string, tools: RemoteToolRegistration[]): RemoteToolDefinition[];
    listEnabledTools(projectId: string): RemoteToolDefinition[];
    getTool(projectId: string, scheme: string): RemoteToolDefinition | null;
    createJob(projectId: string, scheme: string, requestPayload: Record<string, unknown>): RemoteToolJob;
    markJobRunning(id: string): void;
    markJobSucceeded(id: string, responsePayload: Record<string, unknown>): void;
    markJobFailed(id: string, error: string): void;
    getJob(id: string): RemoteToolJob | null;
    private updateStatus;
    private mapTool;
    private mapJob;
}
//# sourceMappingURL=SQLiteRemoteToolStore.d.ts.map