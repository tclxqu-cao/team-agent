/**
 * Keeps the display awake (and lights it up) while a desktop live session is
 * enabled, so remote viewers keep receiving frames on a locked or dimmed Mac.
 * Pure dependency shell — electron powerSaveBlocker and caffeinate are wired
 * in main/index.ts to keep this module unit-testable without electron.
 */
export class DisplayKeepAwake {
    constructor({ wake = () => undefined, acquire, release }) {
        this.blockerId = null;
        this.wake = wake;
        this.acquire = acquire;
        this.release = release;
    }
    /** Wakes the display and holds a display-sleep assertion until stop(). */
    start() {
        this.wake();
        if (this.blockerId === null)
            this.blockerId = this.acquire();
    }
    /** Releases the assertion; the display returns to the normal idle policy. */
    stop() {
        if (this.blockerId !== null) {
            this.release(this.blockerId);
            this.blockerId = null;
        }
    }
}
//# sourceMappingURL=display-keep-awake.js.map