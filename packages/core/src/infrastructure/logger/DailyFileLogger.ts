import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/** One structured entry serialized as a single JSON line in the daily file. */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  /** Component that produced the entry, e.g. "server", "desktop", "webapp", "agent-run". */
  source: string;
  message: string;
  error?: { name: string; message: string; stack?: string };
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

function levelRank(level: LogLevel): number {
  return LEVEL_RANK[level] ?? 0;
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function serializeError(err: unknown): LogEntry["error"] | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const out: NonNullable<LogEntry["error"]> = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    return out;
  }
  if (typeof err === "object" || typeof err === "function") {
    const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof anyErr.name === "string" ? anyErr.name : "NonError";
    const message = typeof anyErr.message === "string" ? anyErr.message : String(err);
    const out: NonNullable<LogEntry["error"]> = { name, message };
    if (typeof anyErr.stack === "string") out.stack = anyErr.stack;
    return out;
  }
  return { name: "NonError", message: String(err) };
}

/** JSON.stringify that never throws (cyclic refs, bigint, getters that throw). */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }) ?? "null";
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return '"[unserializable]"';
    }
  }
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
export class DailyFileLogger {
  readonly dir: string;
  readonly source: string;
  private readonly minLevel: LogLevel;
  private readonly retentionDays: number;
  private readonly maxLineBytes: number;
  private readonly now: () => Date;
  private activeDay = "";
  private activeFile = "";
  private queue: Promise<void> = Promise.resolve();
  private pendingLines: string[] = [];
  private readonly loggedWriteFailure = new Set<string>();
  /** Number of entries that could not be persisted. */
  writeFailures = 0;
  private consoleIntercepted = false;
  private originalConsoleError: ((...args: unknown[]) => void) | null = null;
  private originalConsoleWarn: ((...args: unknown[]) => void) | null = null;

  constructor(options: DailyFileLoggerOptions) {
    this.dir = options.dir;
    this.source = options.source;
    this.minLevel = options.minLevel ?? "debug";
    this.retentionDays = options.retentionDays ?? 30;
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  debug(message: string, errorOrData?: unknown, data?: unknown): void {
    this.log("debug", message, errorOrData, data);
  }

  info(message: string, errorOrData?: unknown, data?: unknown): void {
    this.log("info", message, errorOrData, data);
  }

  warn(message: string, errorOrData?: unknown, data?: unknown): void {
    this.log("warn", message, errorOrData, data);
  }

  error(message: string, errorOrData?: unknown, data?: unknown): void {
    this.log("error", message, errorOrData, data);
  }

  fatal(message: string, errorOrData?: unknown, data?: unknown): void {
    this.log("fatal", message, errorOrData, data);
  }

  /**
   * Accepts either `log(level, message, error, data?)` or
   * `log(level, message, data)`; an Error in the third position is serialized
   * into `entry.error`, plain objects land in `entry.data`.
   */
  log(level: LogLevel, message: string, errorOrData?: unknown, data?: unknown): void {
    try {
      if (levelRank(level) < levelRank(this.minLevel)) return;
      const entry: LogEntry = {
        ts: this.now().toISOString(),
        level,
        source: this.source,
        message: typeof message === "string" ? message : String(message),
      };
      if (errorOrData instanceof Error || (errorOrData !== null && typeof errorOrData === "object" && !Array.isArray(errorOrData) && "message" in (errorOrData as Record<string, unknown>))) {
        entry.error = serializeError(errorOrData);
        if (data !== undefined) entry.data = data;
      } else if (errorOrData !== undefined) {
        entry.data = errorOrData;
      }
      this.enqueue(level, entry);
    } catch {
      this.writeFailures++;
    }
  }

  /** Same-format logger for a sub-component writing into the same daily files. */
  child(source: string): DailyFileLogger {
    return new DailyFileLogger({
      dir: this.dir,
      source,
      minLevel: this.minLevel,
      retentionDays: this.retentionDays,
      maxLineBytes: this.maxLineBytes,
      now: this.now,
    });
  }

  /** Wait until all queued entries reached the file (tests and flush points). */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Mirrors console.error / console.warn into the daily file while keeping
   * their original output. Idempotent; returns an uninstall function.
   */
  interceptConsole(): () => void {
    if (this.consoleIntercepted) return () => {};
    this.consoleIntercepted = true;
    this.originalConsoleError = console.error.bind(console);
    this.originalConsoleWarn = console.warn.bind(console);
    const logger = this;
    console.error = (...args: unknown[]) => {
      logger.log("error", formatConsoleArgs(args));
      logger.originalConsoleError!(...args);
    };
    console.warn = (...args: unknown[]) => {
      logger.log("warn", formatConsoleArgs(args));
      logger.originalConsoleWarn!(...args);
    };
    return () => {
      if (!this.consoleIntercepted) return;
      if (this.originalConsoleError) console.error = this.originalConsoleError;
      if (this.originalConsoleWarn) console.warn = this.originalConsoleWarn;
      this.consoleIntercepted = false;
      this.originalConsoleError = null;
      this.originalConsoleWarn = null;
    };
  }

  /**
   * Records process-level errors into the daily file. Idempotent per process
   * (installing twice is a no-op and returns a shared handle).
   */
  installGlobalErrorHandlers(options: GlobalErrorHandlersOptions = {}): GlobalErrorHandlersHandle {
    const existing = (globalThis as Record<symbol, GlobalErrorHandlersHandle | undefined>)[GLOBAL_HANDLERS_FLAG];
    if (existing) return existing;

    const exitOnUncaughtException = options.exitOnUncaughtException ?? true;
    const uncaughtHandler = (err: unknown): void => {
      this.fatal("uncaughtException", err);
      if (!exitOnUncaughtException) return;
      // Give queued async entries a bounded window to reach the file, then
      // preserve the default crash semantics (exit code 1).
      const timeout = setTimeout(() => process.exit(1), 1000);
      timeout.unref?.();
      void this.queue
        .catch(() => {})
        .then(() => {
          clearTimeout(timeout);
          process.exit(1);
        });
    };
    const rejectionHandler = (reason: unknown): void => {
      this.error("unhandledRejection", reason);
    };
    process.on("uncaughtException", uncaughtHandler);
    process.on("unhandledRejection", rejectionHandler);
    const handle: GlobalErrorHandlersHandle = {
      uninstall: () => {
        process.off("uncaughtException", uncaughtHandler);
        process.off("unhandledRejection", rejectionHandler);
        const record = globalThis as Record<symbol, unknown>;
        if (record[GLOBAL_HANDLERS_FLAG] === handle) delete record[GLOBAL_HANDLERS_FLAG];
      },
    };
    (globalThis as Record<symbol, unknown>)[GLOBAL_HANDLERS_FLAG] = handle;
    return handle;
  }

  /** Synchronous best-effort flush for crash paths (fatal entries). */
  flushSync(): void {
    // Entries already went through enqueue(); sync-render whatever is still
    // pending so a fatal crash cannot lose them.
    const pending = this.pendingLines.splice(0);
    if (pending.length === 0) return;
    try {
      const day = this.resolveDay();
      this.ensureDirSync();
      appendFileSync(this.fileForDay(day), pending.join(""), "utf8");
    } catch {
      this.writeFailures += pending.length;
      this.reportWriteFailureOnce("sync flush failed");
    }
  }

  private enqueue(level: LogLevel, entry: LogEntry): void {
    let line: string;
    try {
      line = this.renderLine(entry);
    } catch {
      this.writeFailures++;
      return;
    }
    if (level === "fatal") {
      // Crash-path entries must not depend on pending async state.
      this.pendingLines.push(line);
      this.flushSync();
      return;
    }
    this.queue = this.queue
      .then(() => this.appendAsync(line))
      .catch(() => {
        this.writeFailures++;
        this.reportWriteFailureOnce(this.activeFile || this.dir);
      });
  }

  private renderLine(entry: LogEntry): string {
    let line = safeJsonStringify(entry);
    if (line.length > this.maxLineBytes) {
      const truncated: LogEntry = {
        ...entry,
        message: entry.message.slice(0, 2000),
        data: "[truncated: line exceeded limit]",
      };
      if (truncated.error?.stack) truncated.error.stack = truncated.error.stack.slice(0, 8000);
      line = safeJsonStringify(truncated);
    }
    return `${line}\n`;
  }

  private async appendAsync(line: string): Promise<void> {
    const day = this.resolveDay();
    if (day !== this.activeDay) {
      this.activeDay = day;
      this.activeFile = this.fileForDay(day);
      await mkdir(this.dir, { recursive: true });
      void this.cleanupOldFiles().catch(() => {});
    }
    try {
      await appendFile(this.activeFile, line, "utf8");
    } catch (err) {
      // Directory may have been removed underneath us — recreate once.
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.activeFile, line, "utf8");
      } catch {
        this.writeFailures++;
        this.reportWriteFailureOnce(err instanceof Error ? err.message : String(err));
      }
    }
  }

  private resolveDay(): string {
    return localDateString(this.now());
  }

  private fileForDay(day: string): string {
    return join(this.dir, `${day}.log`);
  }

  private ensureDirSync(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private cleanupOldFiles(): Promise<void> {
    return (async () => {
      if (this.retentionDays <= 0) return;
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const names = await readdir(this.dir);
      for (const name of names) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const full = join(this.dir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) await unlink(full);
        } catch {
          // File vanished concurrently — nothing to do.
        }
      }
    })();
  }

  private reportWriteFailureOnce(reason: string): void {
    if (this.loggedWriteFailure.has(reason)) return;
    this.loggedWriteFailure.add(reason);
    try {
      process.stderr.write(`[global-logger] failed to write log file (${reason}); further failures are silent\n`);
    } catch {
      // stderr gone — nothing left to do.
    }
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      return safeJsonStringify(arg);
    })
    .join(" ");
}

const GLOBAL_HANDLERS_FLAG = Symbol.for("agentroam.globalLogger.errorHandlers");

// ── Per-process singleton ───────────────────────────────────────────────────
// Stored on globalThis so multiple copies of @agent/core in one process
// (bundled + dist) share the same configured logger.

const GLOBAL_LOGGER_FLAG = Symbol.for("agentroam.globalLogger.instance");

export function configureGlobalLogger(options: DailyFileLoggerOptions): DailyFileLogger {
  const record = globalThis as Record<symbol, unknown>;
  const existing = record[GLOBAL_LOGGER_FLAG];
  if (existing instanceof DailyFileLogger) return existing;
  const logger = new DailyFileLogger(options);
  record[GLOBAL_LOGGER_FLAG] = logger;
  return logger;
}

export function getGlobalLogger(): DailyFileLogger | null {
  const record = globalThis as Record<symbol, unknown>;
  const existing = record[GLOBAL_LOGGER_FLAG];
  return existing instanceof DailyFileLogger ? existing : null;
}

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

export function installGlobalLogging(options: InstallGlobalLoggingOptions): DailyFileLogger {
  const logger = configureGlobalLogger(options);
  logger.installGlobalErrorHandlers(options.handlers ?? { exitOnUncaughtException: true });
  if (options.interceptConsole !== false) logger.interceptConsole();
  return logger;
}

// Cached per-source views so hot paths (agent adapters, routes) reuse one
// child logger per component instead of allocating on every entry.
const globalChildCache = new Map<string, DailyFileLogger>();

/**
 * Null-safe one-liner for call sites anywhere in the process. No-ops when the
 * process never installed global logging (e.g. unit tests); otherwise writes
 * through a cached per-`source` view of the global logger.
 */
export function logGlobal(
  level: LogLevel,
  source: string,
  message: string,
  error?: unknown,
  data?: unknown,
): void {
  const logger = getGlobalLogger();
  if (!logger) return;
  let child = globalChildCache.get(source);
  if (!child) {
    child = logger.child(source);
    globalChildCache.set(source, child);
  }
  child.log(level, message, error, data);
}

/** Awaits every queue (global logger + cached per-source views) drained. */
export async function flushGlobal(): Promise<void> {
  const logger = getGlobalLogger();
  if (!logger) return;
  await Promise.all([logger.flush(), ...[...globalChildCache.values()].map((child) => child.flush())]);
}

/** Test helper: drop the singleton so a later configure() rebinds. */
export function resetGlobalLoggerForTests(): void {
  const record = globalThis as Record<symbol, unknown>;
  delete record[GLOBAL_LOGGER_FLAG];
}
