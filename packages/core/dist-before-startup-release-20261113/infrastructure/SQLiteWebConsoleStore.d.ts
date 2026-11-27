import { type CommandHistoryRecord, type DeviceState, type TerminalTabRecord, type UserPreferences } from "../domain/web-console/index.js";
import type { ComputerSettings } from "../domain/web-console/computer-settings.js";
import { type SavedComputerConnection } from "../domain/web-console/computer-directory.js";
export declare class SQLiteWebConsoleStore {
    private readonly db;
    constructor(baseDir: string);
    listComputerConnections(userId: string): SavedComputerConnection[];
    /** Additive import: another browser's old aliases must not overwrite a database rename. */
    mergeComputerConnections(userId: string, connections: SavedComputerConnection[], restore?: boolean): SavedComputerConnection[];
    renameComputerConnection(userId: string, connection: SavedComputerConnection): boolean;
    removeComputerConnection(userId: string, origin: string): void;
    getComputerSettings(userId: string): ComputerSettings | null;
    saveComputerSettings(value: ComputerSettings, expectedRevision: number | null): boolean;
    markStaleTerminalsExited(at: string): number;
    listTabs(userId: string): TerminalTabRecord[];
    createTab(tab: TerminalTabRecord): void;
    updateTab(id: string, userId: string, update: Partial<Pick<TerminalTabRecord, "title" | "currentCwd" | "status" | "sortOrder" | "lastActiveAt" | "exitedAt" | "closedAt">>): boolean;
    getPreferences(userId: string): UserPreferences | null;
    savePreferences(value: UserPreferences, expectedRevision: number | null): boolean;
    getDeviceState(userId: string, deviceId: string): DeviceState | null;
    saveDeviceState(value: DeviceState): void;
    addHistory(userId: string, terminalId: string, command: string, cwd: string, executedAt: string, exitCode?: number | null): void;
    listHistory(userId: string, query?: string, limit?: number, terminalId?: string): CommandHistoryRecord[];
    deleteHistory(userId: string, id: number): boolean;
    clearHistory(userId: string, terminalId?: string): number;
}
//# sourceMappingURL=SQLiteWebConsoleStore.d.ts.map