import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

// Append complete lines to stderr so stdout (URLs, QR codes, JSON) stays usable.
class ProgressReporter {
  constructor(options) {
    const environment = options.environment ?? process.env;
    this.enabled = options.enabled ?? (environment.AGENTROAM_SERVICE !== '1' && environment.AGENTROAM_NO_PROGRESS !== '1');
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.delayMs = options.delayMs ?? 800;
    this.intervalMs = options.intervalMs ?? 5000;
    this.steps = [];
    this.pauses = 0;
  }

  begin(label) {
    const step = { label, started: Date.now() };
    this.steps.push(step);
    this.schedule(this.delayMs);
    return () => {
      const wasActive = this.steps.at(-1) === step;
      this.steps.splice(this.steps.indexOf(step), 1);
      if (wasActive) this.schedule(this.delayMs);
    };
  }

  schedule(milliseconds) {
    clearTimeout(this.timer);
    if (!this.enabled || this.pauses || !this.steps.length) return;
    this.timer = setTimeout(() => {
      const step = this.steps.at(-1);
      const seconds = Math.floor((Date.now() - step.started) / 1000);
      this.log(`… ${step.label}（已等待 ${seconds} 秒）`);
      this.schedule(this.intervalMs);
    }, milliseconds);
    this.timer.unref?.();
  }

  pause() {
    this.pauses++;
    clearTimeout(this.timer);
    return () => {
      this.pauses--;
      this.schedule(this.delayMs);
    };
  }
}

/** Nested stages share one heartbeat. Timers always stop, including on failure. */
export async function withCliProgress(label, operation, options = {}) {
  const reporter = context.getStore() ?? new ProgressReporter(options);
  return context.run(reporter, async () => {
    const finish = reporter.begin(label);
    try { return await operation(); }
    finally { finish(); }
  });
}

/** Suspend every nested heartbeat while a terminal prompt owns the cursor. */
export async function withoutCliProgress(operation) {
  const resume = context.getStore()?.pause();
  try { return await operation(); }
  finally { resume?.(); }
}
