const JSON_FRAME = 0x01;
const PCM_FRAME = 0x02;
const HEADER_BYTES = 5;
const MAX_FRAME_BYTES = 1024 * 1024;

export interface DecodedFrame {
  kind: "json" | "pcm";
  payload: Buffer;
}

export function encodeFrame(kind: 1 | 2, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) throw new Error("frame payload exceeds 1 MiB");
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header[0] = kind;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    if (chunk.length === 0) return [];
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.buffered.length >= HEADER_BYTES) {
      const kind = this.buffered[0];
      if (kind !== JSON_FRAME && kind !== PCM_FRAME) {
        throw new Error(`unknown frame kind ${kind}`);
      }
      const length = this.buffered.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error("frame payload exceeds 1 MiB");
      const frameBytes = HEADER_BYTES + length;
      if (this.buffered.length < frameBytes) break;
      frames.push({
        kind: kind === JSON_FRAME ? "json" : "pcm",
        payload: Buffer.from(this.buffered.subarray(HEADER_BYTES, frameBytes)),
      });
      this.buffered = this.buffered.subarray(frameBytes);
    }
    if (this.buffered.length > MAX_FRAME_BYTES + HEADER_BYTES) {
      throw new Error("framed process buffer exceeds limit");
    }
    return frames;
  }
}
interface QueueWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: Error): void;
}

export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private closeError: Error | null = null;
  private pressureActive = false;

  constructor(
    private readonly capacity: number,
    private readonly onFull: () => void = () => undefined,
    private readonly onSpace: () => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("queue capacity must be a positive integer");
    }
  }

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    if (this.values.length === this.capacity && !this.pressureActive) {
      this.pressureActive = true;
      this.onFull();
    }
    return true;
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error ?? null;
    if (this.pressureActive) {
      this.pressureActive = false;
      this.onSpace();
    }
    for (const waiter of this.waiters.splice(0)) {
      if (this.closeError) waiter.reject(this.closeError);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  private async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      if (this.pressureActive && this.values.length < this.capacity) {
        this.pressureActive = false;
        this.onSpace();
      }
      return { value, done: false };
    }
    if (this.closed) {
      if (this.closeError) throw this.closeError;
      return { value: undefined, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
