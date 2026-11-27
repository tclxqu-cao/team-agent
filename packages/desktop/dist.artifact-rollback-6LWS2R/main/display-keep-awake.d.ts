/**
 * Keeps the display awake (and lights it up) while a desktop live session is
 * enabled, so remote viewers keep receiving frames on a locked or dimmed Mac.
 * Pure dependency shell — electron powerSaveBlocker and caffeinate are wired
 * in main/index.ts to keep this module unit-testable without electron.
 */
export declare class DisplayKeepAwake {
    private readonly wake;
    private readonly acquire;
    private readonly release;
    private blockerId;
    constructor({ wake, acquire, release }: {
        /** Lights the display back up (e.g. `caffeinate -u` on macOS). */
        wake?: () => void;
        /** Starts the OS display-sleep assertion; returns null when unsupported. */
        acquire: () => number | null;
        release: (blockerId: number) => void;
    });
    /** Wakes the display and holds a display-sleep assertion until stop(). */
    start(): void;
    /** Releases the assertion; the display returns to the normal idle policy. */
    stop(): void;
}
//# sourceMappingURL=display-keep-awake.d.ts.map