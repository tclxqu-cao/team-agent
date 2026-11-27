export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
declare const DAILY_FILE_LOGGER_BRAND: unique symbol;
declare const GLOBAL_CHILD_LOGGERS: unique symbol;
/** One structured entry serialized as a single JSON line in the daily file. */
export interface LogEntry {
    ts: string;
    level: LogLevel;
    /** Component that produced the entry, e.g. "server", "desktop", "webapp", "agent-run". */
    source: string;
    message: string;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
    data?: unknown;
}
export interface DailyFileLoggerOptions {
    /** Directory that receives `YYYY-MM-DD.log` files (created on demand). */
    dir: string;
    /** Component identifier written into every entry produced by this logger. */
    source: string;
    /** Entries below this level are dropped (default "debug" = keep everything). */
    minLevel?: LogLevel;
    /** Daily files older than this are deleted on day rollover (default 30). */
    retentionDays?: number;
    /** Hard cap for a single serialized line (default 256 KiB). */
    maxLineBytes?: number;
    /** Injectable clock for tests. */
    now?: () => Date;
}
export interface GlobalErrorHandlersOptions {
    /**
     * Exit with code 1 after an uncaughtException is recorded, preserving the
     * default Node crash semantics. Long-lived UI hosts (Electron main) pass
     * false to record and keep running instead.
     */
    exitOnUncaughtException?: boolean;
}
export interface GlobalErrorHandlersHandle {
    uninstall: () => void;
}
/**
 * Global log collection with one NDJSON file per local day
 * (`<dir>/YYYY-MM-DD.log`). Every entry is a single JSON line:
 * `{ts, level, source, message, error?, data?}`.
 *
 * Contract:
 * - Logging must never throw or crash the host process. Write failures are
 *   counted (`writeFailures`) and surfaced once via stderr.
 * - Day rollover happens on write; previous days are cleaned up on rollover
 *   according to `retentionDays`.
 * - `interceptConsole()` mirrors existing `console.error`/`console.warn`
 *   call sites into the file so legacy code paths are recorded too.
 * - `installGlobalErrorHandlers()` records uncaughtException /
 *   unhandledRejection process errors. It is idempotent per process.
 */
export declare class DailyFileLogger {
    readonly [DAILY_FILE_LOGGER_BRAND] = true;
    readonly [GLOBAL_CHILD_LOGGERS]: Map<string, DailyFileLogger>;
    readonly dir: string;
    readonly source: string;
    private readonly minLevel;
    private readonly retentionDays;
    private readonly maxLineBytes;
    private readonly now;
    private activeDay;
    private activeFile;
    private queue;
    private pendingLines;
    private readonly loggedWriteFailure;
    /** Number of entries that could not be persisted. */
    writeFailures: number;
    private consoleIntercepted;
    private originalConsoleError;
    private originalConsoleWarn;
    constructor(options: DailyFileLoggerOptions);
    debug(message: string, errorOrData?: unknown, data?: unknown): void;
    info(message: string, errorOrData?: unknown, data?: unknown): void;
    warn(message: string, errorOrData?: unknown, data?: unknown): void;
    error(message: string, errorOrData?: unknown, data?: unknown): void;
    fatal(message: string, errorOrData?: unknown, data?: unknown): void;
    /**
     * Accepts either `log(level, message, error, data?)` or
     * `log(level, message, data)`; an Error in the third position is serialized
     * into `entry.error`, plain objects land in `entry.data`.
     */
    log(level: LogLevel, message: string, errorOrData?: unknown, data?: unknown): void;
    /** Same-format logger for a sub-component writing into the same daily files. */
    child(source: string): DailyFileLogger;
    /** Wait until all queued entries reached the file (tests and flush points). */
    flush(): Promise<void>;
    /**
     * Mirrors console.error / console.warn into the daily file while keeping
     * their original output. Idempotent; returns an uninstall function.
     */
    interceptConsole(): () => void;
    /**
     * Records process-level errors into the daily file. Idempotent per process
     * (installing twice is a no-op and returns a shared handle).
     */
    installGlobalErrorHandlers(options?: GlobalErrorHandlersOptions): GlobalErrorHandlersHandle;
    /** Synchronous best-effort flush for crash paths (fatal entries). */
    flushSync(): void;
    private enqueue;
    private renderLine;
    private appendAsync;
    private resolveDay;
    private fileForDay;
    private ensureDirSync;
    private cleanupOldFiles;
    private reportWriteFailureOnce;
}
export declare function configureGlobalLogger(options: DailyFileLoggerOptions): DailyFileLogger;
export declare function getGlobalLogger(): DailyFileLogger | null;
/**
 * The single composition point for a process: bind the global logger (if not
 * already bound), install process error handlers and optionally mirror
 * console.error/warn into the daily file. Entry points (ws-server, desktop
 * main, tui, cli bootstrap) call this once; everything else only calls
 * `getGlobalLogger()` / `logGlobal()`.
 */
export interface InstallGlobalLoggingOptions extends DailyFileLoggerOptions {
    /** Options for the uncaughtException/unhandledRejection handlers. */
    handlers?: GlobalErrorHandlersOptions;
    /** Mirror console.error/warn into the daily file (default true). */
    interceptConsole?: boolean;
}
export declare function installGlobalLogging(options: InstallGlobalLoggingOptions): DailyFileLogger;
/**
 * Null-safe one-liner for call sites anywhere in the process. No-ops when the
 * process never installed global logging (e.g. unit tests); otherwise writes
 * through a cached per-`source` view of the global logger.
 */
export declare function logGlobal(level: LogLevel, source: string, message: string, error?: unknown, data?: unknown): void;
/** Awaits every queue (global logger + cached per-source views) drained. */
export declare function flushGlobal(): Promise<void>;
/** Test helper: drop the singleton so a later configure() rebinds. */
export declare function resetGlobalLoggerForTests(): void;
export {};
//# sourceMappingURL=DailyFileLogger.d.ts.map