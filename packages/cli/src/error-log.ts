import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Self-contained daily error log for the CLI process. The CLI cannot depend
// on @agent/core (it ships as a thin launcher), so this mirrors the exact
// NDJSON entry format of core's DailyFileLogger
// (`{ts, level, source, message, error?, data?}`) into `<dataDir>/logs/`.
// It records uncaughtException / unhandledRejection so launcher failures are
// strictly persisted, matching the server/desktop log series.

const LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function serializeError(err: unknown): Record<string, string> | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const out: Record<string, string> = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    return out;
  }
  if (typeof err === "object") {
    const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
    const out: Record<string, string> = {
      name: typeof anyErr.name === "string" ? anyErr.name : "NonError",
      message: typeof anyErr.message === "string" ? anyErr.message : String(err),
    };
    if (typeof anyErr.stack === "string") out.stack = anyErr.stack;
    return out;
  }
  return { name: "NonError", message: String(err) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

export interface CliErrorLog {
  log: (level: string, message: string, error?: unknown, data?: unknown) => void;
  installGlobalErrorHandlers: (options?: { exitOnUncaughtException?: boolean }) => void;
}

export function createCliErrorLog(logsDir: string): CliErrorLog {
  let reportedWriteFailure = false;
  const write = (line: string): void => {
    try {
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      appendFileSync(join(logsDir, `${localDateString(new Date())}.log`), line, "utf8");
    } catch {
      if (!reportedWriteFailure) {
        reportedWriteFailure = true;
        try {
          process.stderr.write(`[agentroam] failed to write error log to ${logsDir}; further failures are silent\n`);
        } catch { /* stderr gone */ }
      }
    }
  };
  const cleanupOldFiles = (): void => {
    // 30-day retention, aligned with the core logger default. Best effort.
    try {
      if (!existsSync(logsDir)) return;
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(logsDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const full = join(logsDir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
        } catch { /* concurrent removal */ }
      }
    } catch { /* best effort */ }
  };
  const log = (level: string, message: string, error?: unknown, data?: unknown): void => {
    if (!LEVELS.has(level)) level = "error";
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      source: "cli",
      message: typeof message === "string" ? message.slice(0, 4000) : String(message),
    };
    const serialized = serializeError(error);
    if (serialized) entry.error = serialized;
    if (data !== undefined) entry.data = data;
    write(`${safeStringify(entry)}\n`);
  };

  return {
    log,
    installGlobalErrorHandlers: (options: { exitOnUncaughtException?: boolean } = {}) => {
      const exitOnUncaughtException = options.exitOnUncaughtException ?? true;
      process.on("uncaughtException", (err) => {
        log("fatal", "uncaughtException", err);
        if (exitOnUncaughtException) process.exit(1);
      });
      process.on("unhandledRejection", (reason) => {
        log("error", "unhandledRejection", reason);
      });
      cleanupOldFiles();
    },
  };
}
