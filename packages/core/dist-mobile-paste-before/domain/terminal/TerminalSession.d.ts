export interface TerminalSize {
    cols: number;
    rows: number;
}
/**
 * Byte-aware ring buffer for PTY output. Keeps the most recent `maxBytes`
 * bytes without holding unbounded memory on long-running sessions.
 * Operates on UTF-8 bytes so multi-byte characters split at the trim point
 * are handled by the consumer decoding with streaming TextDecoder semantics.
 */
export declare class ScrollbackBuffer {
    readonly maxBytes: number;
    private chunks;
    private total;
    constructor(maxBytes?: number);
    append(data: Uint8Array): void;
    /** Concatenate retained chunks in order. */
    snapshot(): Uint8Array;
    get byteLength(): number;
    clear(): void;
}
/** State of one persistent terminal session (no process handle — pure data). */
export declare class TerminalSession {
    readonly id: string;
    readonly buffer: ScrollbackBuffer;
    size: TerminalSize;
    constructor(id: string, options?: {
        maxBufferBytes?: number;
        size?: TerminalSize;
    });
    /** Record PTY output into scrollback. */
    write(data: Uint8Array): void;
    resize(cols: number, rows: number): void;
    /**
     * Bytes a reconnecting client needs: everything buffered since `cursor`,
     * where `cursor` is the byte offset previously acknowledged by the client
     * (usually total bytes delivered). Returns null when nothing new.
     */
    readSince(cursor: number): Uint8Array | null;
}
//# sourceMappingURL=TerminalSession.d.ts.map