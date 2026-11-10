import { REMOTE_COMPOUND_VIDEO as limits, isCompoundDirtyRect, type CompoundFrameIdentity, type CompoundDirtyRect } from "./remote-compound-video.js";

export interface CompoundScrollCopy {
  sourceRevision: number; sourceX: number; sourceY: number; x: number; y: number; width: number; height: number;
}

export function isCompoundScrollCopy(copy: CompoundScrollCopy, frame: Pick<CompoundFrameIdentity, "width" | "height">): boolean {
  return Number.isSafeInteger(copy?.sourceRevision) && copy.sourceRevision >= 0
    && isCompoundDirtyRect(copy, frame)
    && isCompoundDirtyRect({ x: copy.sourceX, y: copy.sourceY, width: copy.width, height: copy.height }, frame)
    && (copy.sourceX !== copy.x || copy.sourceY !== copy.y);
}

/** Tracks repair debt independently of compressed-image/cache identities. */
export class RemoteCompoundQualityPolicy {
  private frame: CompoundFrameIdentity | null = null;
  private debt = new Map<number, { dirtyAt: number; attemptedAt: number; sharp: boolean }>();
  private priorSharp = new Set<number>();
  private priorRevision = -1;
  private point?: { x: number; y: number };
  private interactionAt = -Infinity;
  private activity = "motion";

  invalidate(frame: CompoundFrameIdentity, rects: readonly CompoundDirtyRect[] | undefined, now: number): void {
    const reset = this.frame?.epoch !== frame.epoch || this.frame?.width !== frame.width || this.frame?.height !== frame.height;
    if (reset) { this.debt.clear(); this.priorSharp.clear(); this.priorRevision = -1; }
    else if (this.frame?.revision === frame.revision) { this.frame = frame; return; }
    else {
      this.priorRevision = this.frame!.revision;
      this.priorSharp = new Set([...this.debt].filter(([, entry]) => entry.sharp).map(([index]) => index));
    }
    this.frame = { ...frame };
    const columns = Math.ceil(frame.width / limits.tileSize), rows = Math.ceil(frame.height / limits.tileSize);
    for (let index = 0; index < columns * rows; index++) {
      const x = index % columns * 64, y = Math.floor(index / columns) * 64;
      if (reset || !rects?.length || rects.some(rect => x < rect.x + rect.width && x + 64 > rect.x && y < rect.y + rect.height && y + 64 > rect.y)) {
        this.debt.set(index, { dirtyAt: now, attemptedAt: -Infinity, sharp: false });
      }
    }
  }

  noteInteraction(point: { x: number; y: number } | undefined, now: number): void {
    this.interactionAt = now;
    if (point && [point.x, point.y].every(Number.isFinite)) this.point = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  }
  observe(activity: string | undefined): void { if (activity) this.activity = activity; }
  entropyLimit(now: number): number { return this.activity === "idle" && now - this.interactionAt >= 1000 ? limits.maxEntropy : limits.initialEntropy; }

  priorities(now: number, count = 128, inFlight: readonly { x: number; y: number }[] = []): number[] {
    if (!this.frame) return [];
    const columns = Math.ceil(this.frame.width / 64), frame = this.frame;
    const occupied = new Set(inFlight.map(tile => Math.floor(tile.y / 64) * columns + Math.floor(tile.x / 64)));
    return [...this.debt].filter(([index, entry]) => !entry.sharp && !occupied.has(index)).sort(([a, aa], [b, bb]) => {
      const score = (index: number, entry: typeof aa) => {
        const age = Math.min(5000, Math.max(0, now - entry.dirtyAt));
        const distance = this.point ? Math.hypot((index % columns * 64 + 32) / frame.width - this.point.x,
          (Math.floor(index / columns) * 64 + 32) / frame.height - this.point.y) : 0;
        return age - Math.max(0, 750 - (now - entry.attemptedAt)) * 8 - (now - this.interactionAt < 1500 ? distance * 1500 : 0);
      };
      return score(b, bb) - score(a, aa) || a - b;
    }).slice(0, count).map(([index]) => index);
  }
  attempted(indices: readonly number[], now: number): void { for (const index of indices) { const entry = this.debt.get(index); if (entry) entry.attemptedAt = now; } }
  acknowledge(tiles: readonly { x: number; y: number }[]): void {
    if (!this.frame) return;
    const columns = Math.ceil(this.frame.width / 64);
    for (const tile of tiles) { const entry = this.debt.get(Math.floor(tile.y / 64) * columns + Math.floor(tile.x / 64)); if (entry) entry.sharp = true; }
  }
  acknowledgeScroll(copy: CompoundScrollCopy): { x: number; y: number }[] {
    if (!this.frame || this.priorRevision !== copy.sourceRevision || !isCompoundScrollCopy(copy, this.frame)) return [];
    const columns = Math.ceil(this.frame.width / 64), covered: { x: number; y: number }[] = [];
    for (const [index, entry] of this.debt) {
      const x = index % columns * 64, y = Math.floor(index / columns) * 64;
      const width = Math.min(64, this.frame.width - x), height = Math.min(64, this.frame.height - y);
      if (x < copy.x || y < copy.y || x + width > copy.x + copy.width || y + height > copy.y + copy.height) continue;
      const sx = x + copy.sourceX - copy.x, sy = y + copy.sourceY - copy.y;
      let sharp = true;
      for (let row = Math.floor(sy / 64); row <= Math.floor((sy + height - 1) / 64); row++)
        for (let column = Math.floor(sx / 64); column <= Math.floor((sx + width - 1) / 64); column++) if (!this.priorSharp.has(row * columns + column)) sharp = false;
      if (sharp) { entry.sharp = true; covered.push({ x, y }); }
    }
    return covered;
  }
  isSharp(tile: { x: number; y: number }): boolean {
    return !!this.frame && this.debt.get(Math.floor(tile.y / 64) * Math.ceil(this.frame.width / 64) + Math.floor(tile.x / 64))?.sharp === true;
  }
  snapshot(): { repairBlocks: number; sharpBlocks: number } {
    const sharpBlocks = [...this.debt.values()].filter(entry => entry.sharp).length;
    return { repairBlocks: this.debt.size - sharpBlocks, sharpBlocks };
  }
}

export function compoundWindowLimits(enabled: boolean, rttMs = 0): { batches: number; bytes: number } {
  return { batches: enabled ? Math.max(2, Math.min(4, Math.ceil(Math.max(0, rttMs) / 250) + 1)) : 1, bytes: 64_000 };
}
