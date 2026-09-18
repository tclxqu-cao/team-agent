import { join } from "node:path";
import { getGlobalLogger, installGlobalLogging, type DailyFileLogger } from "@agent/core";
import { resolveServerBaseDir } from "./server-data-dir";

let bootLogged = false;

/**
 * The single logging accessor for the server package — all call sites
 * (agent-host, routes, services) go through here; the implementation and
 * composition live once in core's DailyFileLogger / installGlobalLogging.
 *
 * ws-server.mjs installs the same singleton at boot. This helper only covers
 * process shapes that never went through ws-server (plain `next start`,
 * route-level tests): first call binds the singleton and installs handlers.
 */
export function serverLogger(): DailyFileLogger {
  const existing = getGlobalLogger();
  if (existing) return existing;
  const logger = installGlobalLogging({
    dir: join(resolveServerBaseDir(), ".agent-data", "logs"),
    source: "server",
    minLevel: "info",
    handlers: { exitOnUncaughtException: false },
  });
  if (!bootLogged) {
    bootLogged = true;
    logger.info("server logger attached", { dir: logger.dir, pid: process.pid });
  }
  return logger;
}
