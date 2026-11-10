export interface RemoteInputStamp { stream: string; sequence: number; index?: number; }
export interface RemoteInputContext { controllerId: string; epoch: number; stream: string; version?: number; }
export interface RemoteDirectPointer extends RemoteInputStamp {
  barrier: number; x: number; y: number; mobile?: boolean;
}

export function isDirectHoverInput(input: Record<string, unknown>, pressed: boolean): boolean {
  return input.kind === 'pointer' && input.action === 'move' && input.probe !== true && !pressed
    && [input.x, input.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

/** Lossy hover messages cannot cross a reliable click/key/drag barrier. */
export class RemoteDirectInputPolicy {
  private reliable = 0;
  private hover = 0;
  constructor(readonly stream: string) {}
  acceptReliable(stamp: unknown): boolean {
    const value = stamp as Partial<RemoteInputStamp> | null;
    if (!value || value.stream !== this.stream || !Number.isSafeInteger(value.sequence)
      || value.sequence! <= this.reliable || value.sequence! <= this.hover) return false;
    this.reliable = value.sequence!;
    return true;
  }
  acceptMove(value: RemoteDirectPointer): boolean {
    if (!value || value.stream !== this.stream || !Number.isSafeInteger(value.sequence)
      || !Number.isSafeInteger(value.barrier) || value.barrier !== this.reliable
      || value.sequence <= Math.max(this.reliable, this.hover)
      || ![value.x, value.y].every(number => Number.isFinite(number) && number >= 0 && number <= 1)) return false;
    this.hover = value.sequence;
    return true;
  }
}

/** Monotonic hover admission and spacing; a coordinator retains the latest admitted value. */
export class RemoteHoverDispatchPolicy {
  readonly intervalMs = 4;
  private sequence = -1;
  private dispatchedAt = -Infinity;
  offer(sequence: number, now: number): number | null {
    if (!Number.isSafeInteger(sequence) || sequence <= this.sequence || !Number.isFinite(now)) return null;
    this.sequence = sequence;
    return Math.max(0, this.dispatchedAt + this.intervalMs - now);
  }
  dispatched(now: number): void { this.dispatchedAt = now; }
  reset(): void { this.sequence = -1; this.dispatchedAt = -Infinity; }
}
