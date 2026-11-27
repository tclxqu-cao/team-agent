import Database from "better-sqlite3";
export declare class SQLiteDatabase {
    readonly db: Database;
    constructor(baseDir: string);
    private migrate;
    /** exit_code arrived after the first command_history release; NULL = captured before exit codes existed. */
    private migrateCommandHistoryExitCode;
    private migratePinnedCommands;
    /** Create lsp_servers table if it doesn't exist (for DBs created before this feature). */
    private migrateLSPServers;
    /**
     * Recreate the sessions table so project_id is nullable with an optional FK.
     * Safe to run multiple times — checks if the column is already nullable first.
     */
    private migrateSessionsProjectIdNullable;
    /** Add transport and url columns to mcp_servers if they don't exist yet. */
    private migrateMCPServerTransport;
    /** Recreate mcp_servers so command/args/env allow NULL (needed for SSE remote servers). */
    private migrateMCPServerCommandNullable;
    /** Add headers column to mcp_servers if missing. */
    private migrateMCPServerHeaders;
    /** Add parent_id column to sessions for sub-session support. */
    private migrateSessionsParentId;
    /** Add display-only message metadata without changing semantic history fields. */
    private migrateMessagePresentation;
    /** Preserve failed tool results so a later model turn can diagnose and retry them. */
    private migrateMessageIsError;
    close(): void;
}
export declare function getDatabase(baseDir: string): SQLiteDatabase;
//# sourceMappingURL=SQLiteDatabase.d.ts.map