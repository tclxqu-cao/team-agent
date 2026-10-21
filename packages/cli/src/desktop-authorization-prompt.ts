import { createInterface, type Interface } from "node:readline";
import { Readable } from "node:stream";

export class DesktopAuthorizationInterrupted extends Error {
  constructor(readonly kind: "skip" | "timeout") {
    super(kind === "skip" ? "Remote desktop authorization skipped." : "Remote desktop authorization timed out and was skipped.");
  }
}

/** One terminal owns confirmation and cancellation, including curl | sh installs. */
export class DesktopAuthorizationPrompt {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly reader?: Interface;
  private answer?: (approved: boolean) => void;

  constructor(private readonly options: {
    input?: NodeJS.ReadableStream;
    ownsInput?: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    log: (line: string) => void;
  }) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new DesktopAuthorizationInterrupted("timeout")), options.timeoutMs);
    process.on("SIGINT", this.skip);
    if (options.input) {
      // The controlling tty echoes canonical input; readline must not echo it again.
      this.reader = createInterface({ input: options.input, terminal: false });
      this.reader.on("line", this.onLine);
      this.reader.on("close", this.skip);
      this.reader.on("SIGINT", this.skip);
      this.reader.on("error", this.skip);
    }
  }

  private skip = (): void => { this.controller.abort(new DesktopAuthorizationInterrupted("skip")); };
  private onLine = (line: string): void => {
    if (this.answer) {
      const answer = this.answer;
      this.answer = undefined;
      answer(/^(y|yes)$/i.test(line.trim()));
    } else if (/^(s|skip|n|no|跳过)$/i.test(line.trim())) this.skip();
  };

  confirm(): Promise<boolean> {
    if (!this.reader) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.answer = resolve;
      this.options.log("Authorize remote desktop now, allowing paired devices to view and control this computer? [y/N] (Enter to skip): ");
    });
  }

  close(): void {
    clearTimeout(this.timer);
    process.off("SIGINT", this.skip);
    this.reader?.off("line", this.onLine);
    this.reader?.off("close", this.skip);
    this.reader?.off("SIGINT", this.skip);
    this.reader?.off("error", this.skip);
    this.reader?.close();
    this.answer?.(false);
    this.answer = undefined;
    if (this.options.ownsInput && this.options.input instanceof Readable) this.options.input.destroy();
  }
}

/** A deadline must also cover a request or injected operation that never settles. */
export function withAuthorizationSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      operation().then((value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    } catch (error) { signal.removeEventListener("abort", abort); reject(error); }
  });
}
