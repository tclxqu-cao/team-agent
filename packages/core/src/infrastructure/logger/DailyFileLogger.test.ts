import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DailyFileLogger,
  configureGlobalLogger,
  getGlobalLogger,
  flushGlobal,
  installGlobalLogging,
  logGlobal,
  resetGlobalLoggerForTests,
} from "./DailyFileLogger.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readLines(dir: string, day: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dir, `${day}.log`), "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  resetGlobalLoggerForTests();
  vi.restoreAllMocks();
});

describe("DailyFileLogger", () => {
  it("writes NDJSON entries into a per-day file", async () => {
    const dir = makeTempDir("ca-logger-basic-");
    try {
      const logger = new DailyFileLogger({ dir, source: "server", now: () => new Date("2026-09-17T10:00:00+08:00") });
      logger.info("service started", { port: 3000 });
      await logger.flush();

      const entries = readLines(dir, "2026-09-17");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "info",
        source: "server",
        message: "service started",
        data: { port: 3000 },
      });
      expect(typeof entries[0].ts).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes errors with name/message/stack and rolls over across days", async () => {
    const dir = makeTempDir("ca-logger-rollover-");
    let current = new Date("2026-09-16T23:59:00+08:00");
    try {
      const logger = new DailyFileLogger({ dir, source: "desktop", now: () => current });
      logger.error("model call failed", new Error("boom"));
      await logger.flush();

      current = new Date("2026-09-17T00:01:00+08:00");
      logger.error("next day failure", new Error("day2"), { attempt: 2 });
      await logger.flush();

      expect(existsSync(join(dir, "2026-09-16.log"))).toBe(true);
      const day2 = readLines(dir, "2026-09-17");
      expect(day2).toHaveLength(1);
      expect(day2[0].message).toBe("next day failure");
      const err = day2[0].error as { name: string; message: string; stack?: string };
      expect(err.name).toBe("Error");
      expect(err.message).toBe("day2");
      expect(typeof err.stack).toBe("string");
      expect(day2[0].data).toEqual({ attempt: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws even when the log dir is unwritable and counts failures", async () => {
    const dir = makeTempDir("ca-logger-readonly-");
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    try {
      const logger = new DailyFileLogger({ dir: blocker, source: "server" });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(() => {
        logger.error("must not throw", new Error("x"));
      }).not.toThrow();
      logger.warn("also must not throw");
      logger.error("repeat one");
      logger.warn("repeat two");
      logger.error("repeat three");
      await logger.flush();
      expect(logger.writeFailures).toBeGreaterThan(0);
      // Each distinct failure reason is reported at most once; recurring
      // failures stay silent instead of spamming stderr.
      expect(stderrSpy.mock.calls.length).toBeLessThan(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops entries below minLevel", async () => {
    const dir = makeTempDir("ca-logger-minlevel-");
    try {
      const logger = new DailyFileLogger({ dir, source: "server", minLevel: "warn" });
      logger.debug("noise");
      logger.info("fine");
      logger.warn("keep me");
      await logger.flush();
      const entries = readLines(dir, new Date().toLocaleDateString("sv-SE"));
      expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up files older than retentionDays on rollover", async () => {
    const dir = makeTempDir("ca-logger-retention-");
    try {
      const oldDay = "2026-08-01.log";
      writeFileSync(join(dir, oldDay), "{}\n", "utf8");
      const stale = new Date("2026-08-01T00:00:00Z").getTime();
      utimesSync(join(dir, oldDay), new Date(stale), new Date(stale));
      mkdirSync(join(dir, "subdir"), { recursive: true });

      const logger = new DailyFileLogger({
        dir,
        source: "server",
        retentionDays: 7,
        now: () => new Date("2026-09-17T10:00:00+08:00"),
      });
      logger.info("today");
      await logger.flush();
      // Give the fire-and-forget cleanup a tick.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(existsSync(join(dir, oldDay))).toBe(false);
      expect(existsSync(join(dir, "subdir"))).toBe(true);
      expect(readdirSync(dir).filter((name) => name.endsWith(".log"))).toEqual(["2026-09-17.log"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("intercepts console.error/warn into the file without breaking them", async () => {
    const dir = makeTempDir("ca-logger-console-");
    try {
      const logger = new DailyFileLogger({ dir, source: "agent-run", now: () => new Date("2026-09-17T10:00:00+08:00") });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const uninstall = logger.interceptConsole();
      console.error("Agent run error:", new Error("tool exploded"));
      console.warn("degraded", { retry: 1 });
      uninstall();

      await logger.flush();
      const entries = readLines(dir, "2026-09-17");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ level: "error", source: "agent-run" });
      expect(String(entries[0].message)).toContain("Agent run error:");
      expect(String(entries[0].message)).toContain("tool exploded");
      expect(entries[1]).toMatchObject({ level: "warn", message: "degraded {\"retry\":1}" });
      // Original behavior restored after uninstall.
      console.error("after");
      expect(errorSpy).toHaveBeenCalledWith("after");
      expect(warnSpy).toHaveBeenCalledWith("degraded", { retry: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installGlobalErrorHandlers records uncaughtException and unhandledRejection and is idempotent", async () => {
    const dir = makeTempDir("ca-logger-handlers-");
    try {
      const logger = new DailyFileLogger({
        dir,
        source: "server",
        now: () => new Date("2026-09-17T10:00:00+08:00"),
      });
      const uncaughtBaseline = process.listenerCount("uncaughtException");
      const rejectionBaseline = process.listenerCount("unhandledRejection");
      const first = logger.installGlobalErrorHandlers({ exitOnUncaughtException: false });
      const second = logger.installGlobalErrorHandlers();
      expect(second).toBe(first);

      process.emit("uncaughtException", new Error("fatal probe"));
      process.emit("unhandledRejection", new Error("rejection probe"), Promise.resolve());
      await logger.flush();

      const entries = readLines(dir, "2026-09-17");
      expect(entries.map((entry) => entry.level)).toEqual(["fatal", "error"]);
      expect(entries[0].message).toBe("uncaughtException");
      expect(entries[1].message).toBe("unhandledRejection");

      first.uninstall();
      expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBaseline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fatal entries are written synchronously without awaiting flush", () => {
    const dir = makeTempDir("ca-logger-fatal-sync-");
    try {
      const logger = new DailyFileLogger({ dir, source: "tui", now: () => new Date("2026-09-17T10:00:00+08:00") });
      logger.fatal("crashing now", new Error("segv"));
      // No await logger.flush() — the line must already be on disk.
      const entries = readLines(dir, "2026-09-17");
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("fatal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives circular data payloads", async () => {
    const dir = makeTempDir("ca-logger-circular-");
    try {
      const logger = new DailyFileLogger({ dir, source: "server", now: () => new Date("2026-09-17T10:00:00+08:00") });
      const payload: Record<string, unknown> = { ok: true };
      payload.self = payload;
      expect(() => logger.info("cyclic", payload)).not.toThrow();
      await logger.flush();
      const entries = readLines(dir, "2026-09-17");
      expect(entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("global logger singleton", () => {
  it("configures once and returns the same instance", () => {
    const dir = makeTempDir("ca-logger-singleton-");
    try {
      const first = configureGlobalLogger({ dir, source: "server" });
      const second = configureGlobalLogger({ dir: "/elsewhere", source: "other" });
      expect(second).toBe(first);
      expect(getGlobalLogger()).toBe(first);
      expect(getGlobalLogger()!.source).toBe("server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installGlobalLogging / logGlobal", () => {
  it("installs once and routes logGlobal entries through per-source views", async () => {
    const dir = makeTempDir("ca-logger-install-");
    try {
      const logger = installGlobalLogging({
        dir,
        source: "server",
        now: () => new Date("2026-09-18T10:00:00+08:00"),
        handlers: { exitOnUncaughtException: false },
        interceptConsole: false,
      });
      // Second install must be a no-op returning the same singleton.
      const again = installGlobalLogging({ dir: "/elsewhere", source: "other" });
      expect(again).toBe(logger);

      logGlobal("error", "codex-adapter", "adapter boom", new Error("x"), { sessionId: "s1" });
      logGlobal("warn", "codex-adapter", "adapter warn");
      await flushGlobal();

      const entries = readLines(dir, "2026-09-18");
      expect(entries.map((entry) => [entry.source, entry.level])).toEqual([
        ["codex-adapter", "error"],
        ["codex-adapter", "warn"],
      ]);
      expect((entries[0].data as { sessionId?: string }).sessionId).toBe("s1");

      // logGlobal is a no-op before install / after reset.
      resetGlobalLoggerForTests();
      expect(() => logGlobal("error", "codex-adapter", "dropped")).not.toThrow();

      // Remove the installed process handlers so later tests are unaffected.
      const handle = (globalThis as Record<symbol, { uninstall?: () => void } | undefined>)[
        Symbol.for("agentroam.globalLogger.errorHandlers")
      ];
      handle?.uninstall?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
