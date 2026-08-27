// TerminalSession — persistent terminal state for remote/web TUI sessions.
// Pure domain logic: holds a bounded scrollback buffer of PTY output and
// terminal geometry, so a client can detach and later replay what it missed.
export interface TerminalSize {
  cols: number;
  rows: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KiB scrollback cap
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/**
 * Byte-aware ring buffer for PTY output. Keeps the most recent `maxBytes`
 * bytes without holding unbounded memory on long-running sessions.
 * Operates on UTF-8 bytes so multi-byte characters split at the trim point
 * are handled by the consumer decoding with streaming TextDecoder semantics.
 */
export class ScrollbackBuffer {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  append(data: Uint8Array): void {
    this.chunks.push(data);
    this.total += data.byteLength;
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.byteLength;
    }
    if (this.total > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      if (only.byteLength > this.maxBytes) {
        this.chunks[0] = only.subarray(only.byteLength - this.maxBytes);
        this.total = this.maxBytes;
      }
    }
  }

  /** Concatenate retained chunks in order. */
  snapshot(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  get byteLength(): number {
    return this.total;
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}

/** State of one persistent terminal session (no process handle — pure data). */
export class TerminalSession {
  readonly buffer: ScrollbackBuffer;
  size: TerminalSize;

  constructor(
    readonly id: string,
    options?: { maxBufferBytes?: number; size?: TerminalSize },
  ) {
    this.buffer = new ScrollbackBuffer(options?.maxBufferBytes);
    this.size = options?.size ?? { ...DEFAULT_SIZE };
  }

  /** Record PTY output into scrollback. */
  write(data: Uint8Array): void {
    this.buffer.append(data);
  }

  resize(cols: number, rows: number): void {
    if (Number.isFinite(cols)) this.size.cols = Math.min(500, Math.max(2, Math.floor(cols)));
    if (Number.isFinite(rows)) this.size.rows = Math.min(300, Math.max(2, Math.floor(rows)));
  }

  /**
   * Bytes a reconnecting client needs: everything buffered since `cursor`,
   * where `cursor` is the byte offset previously acknowledged by the client
   * (usually total bytes delivered). Returns null when nothing new.
   */
  readSince(cursor: number): Uint8Array | null {
    const full = this.buffer.snapshot();
    if (cursor < 0 || cursor > full.byteLength) cursor = 0; // unknown/stale → full replay
    if (cursor === full.byteLength) return null;
    return full.subarray(cursor);
  }
}
