/**
 * Global browser error collection for the webapp (and the mobile native shell
 * that shares it): window "error" + "unhandledrejection" events are batched
 * and POSTed to the server's /api/client-logs, which appends them to the
 * same per-day log files the server writes.
 *
 * Design constraints:
 * - Must never throw or affect app behavior; all failures are swallowed.
 * - Batch + throttle: at most one in-flight request, at most MAX_BATCH
 *   entries per flush, dropped beyond the queue cap (a broken client must
 *   not flood the server log).
 * - Reporting itself must not recurse: errors thrown by the reporter are
 *   ignored via the inFlight guard.
 */

const MAX_QUEUE = 30;
const MAX_BATCH = 20;
const FLUSH_DEBOUNCE_MS = 2000;

interface ClientLogEntry {
  level: "warn" | "error" | "fatal";
  message: string;
  source: string;
  error?: { name: string; message: string; stack?: string };
  data?: Record<string, unknown>;
}

export interface ClientErrorReporterOptions {
  /** Component identifier stored with each entry (default "webapp"). */
  source?: string;
  /**
   * Endpoint base for non-same-origin deployments (mobile native shell).
   * May be a function so late-bound bases (resolved after boot) are picked
   * up at flush time.
   */
  baseUrl?: string | (() => string);
}

export interface ClientErrorReporter {
  /** Manually report an error (e.g. React error boundaries). */
  reportError: (error: unknown, context?: Record<string, unknown>) => void;
  /** Manually report a warning-level message. */
  reportWarning: (message: string, context?: Record<string, unknown>) => void;
  uninstall: () => void;
}

function describeError(error: unknown): ClientLogEntry["error"] {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack?.slice(0, 8000) };
  }
  if (typeof error === "string") return { name: "Error", message: error };
  try {
    return { name: "NonError", message: JSON.stringify(error)?.slice(0, 2000) ?? String(error) };
  } catch {
    return { name: "NonError", message: String(error) };
  }
}

export function installClientErrorReporter(options: ClientErrorReporterOptions = {}): ClientErrorReporter {
  const source = options.source ?? "webapp";
  const resolveBase = (): string => {
    const value = typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl;
    return (value ?? "").replace(/\/+$/, "");
  };
  const queue: ClientLogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let uninstalled = false;

  const flush = (): void => {
    if (uninstalled || inFlight || queue.length === 0) return;
    const batch = queue.splice(0, MAX_BATCH);
    inFlight = true;
    const body = JSON.stringify({ entries: batch });
    fetch(`${resolveBase()}/api/client-logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (queue.length > 0) schedule();
      });
  };

  const schedule = (): void => {
    if (timer !== null || uninstalled) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  };

  const enqueue = (entry: ClientLogEntry): void => {
    if (uninstalled) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(entry);
    schedule();
  };

  const onError = (event: ErrorEvent): void => {
    enqueue({
      level: "error",
      message: event.message || "window error",
      source,
      error: {
        name: "Error",
        message: event.message || "window error",
        stack: [event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "", event.error?.stack ?? ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 8000) || undefined,
      },
      data: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const error = describeError(event.reason);
    enqueue({ level: "error", message: `unhandledRejection: ${error.message}`, source, error });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return {
    reportError: (error, context) => {
      const described = describeError(error);
      enqueue({ level: "error", message: described.message, source, error: described, data: context });
    },
    reportWarning: (message, context) => {
      enqueue({ level: "warn", message, source, data: context });
    },
    uninstall: () => {
      uninstalled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    },
  };
}
