/**
 * Keeps the display awake (and lights it up) while a desktop live session is
 * enabled, so remote viewers keep receiving frames on a locked or dimmed Mac.
 * Pure dependency shell — electron powerSaveBlocker and caffeinate are wired
 * in main/index.ts to keep this module unit-testable without electron.
 */
export class DisplayKeepAwake {
  private readonly wake: () => void;
  private readonly acquire: () => number | null;
  private readonly release: (blockerId: number) => void;
  private blockerId: number | null = null;

  constructor({ wake = () => undefined, acquire, release }: {
    /** Lights the display back up (e.g. `caffeinate -u` on macOS). */
    wake?: () => void;
    /** Starts the OS display-sleep assertion; returns null when unsupported. */
    acquire: () => number | null;
    release: (blockerId: number) => void;
  }) {
    this.wake = wake;
    this.acquire = acquire;
    this.release = release;
  }

  /** Wakes the display and holds a display-sleep assertion until stop(). */
  start(): void {
    this.wake();
    if (this.blockerId === null) this.blockerId = this.acquire();
  }

  /** Releases the assertion; the display returns to the normal idle policy. */
  stop(): void {
    if (this.blockerId !== null) {
      this.release(this.blockerId);
      this.blockerId = null;
    }
  }
}
