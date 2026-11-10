/** Browser-compatible enhancement protocol. No codec, transport or DOM dependencies. */
export const REMOTE_COMPOUND_VIDEO = Object.freeze({
  version: 1,
  channelLabel: "agentroam.compound.v1",
  tileSize: 64,
  maxDimension: 4096,
  maxFramePixels: 8_388_608,
  maxTileBytes: 32_768,
  maxMessageBytes: 48_000,
  maxTiles: 128,
  maxCacheEntries: 4096,
  maxCachePixels: 10_485_760,
  maxEntropy: 24,
  initialEntropy: 6.3,
  sampleIntervalMs: 250,
  acknowledgementTimeoutMs: 2_000,
});

export interface CompoundFrameIdentity {
  capturedAt?: number;
  epoch: string;
  revision: number;
  timestamp: number;
  width: number;
  height: number;
}

export interface CompoundTileDescriptor {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entropy: number;
  bytes: number;
}

export interface CompoundDirtyRect { x: number; y: number; width: number; height: number; }

export function isCompoundDirtyRect(rect: CompoundDirtyRect, frame: Pick<CompoundFrameIdentity, "width" | "height">): boolean {
  return [rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isSafeInteger)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= frame.width && rect.y + rect.height <= frame.height;
}

export interface CompoundTileUpdate extends CompoundTileDescriptor {
  mode: "put" | "reuse";
  cacheId: number;
}

export interface CompoundEncodingCost {
  headerBytes: number;
  tileBytes: number;
  payloadNumerator: number;
  payloadDenominator: number;
}
const JSON_COST: CompoundEncodingCost = { headerBytes: 256, tileBytes: 192, payloadNumerator: 4, payloadDenominator: 3 };

export interface CompoundUpdatePlan {
  frame: CompoundFrameIdentity;
  tiles: readonly CompoundTileUpdate[];
  estimatedBytes: number;
  resetRequired: boolean;
}

export function isCompoundFrame(value: CompoundFrameIdentity): boolean {
  return typeof value.epoch === "string" && value.epoch.length > 0 && value.epoch.length <= 120
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Number.isFinite(value.timestamp) && value.timestamp >= 0
    && Number.isInteger(value.width) && value.width > 0 && value.width <= REMOTE_COMPOUND_VIDEO.maxDimension
    && Number.isInteger(value.height) && value.height > 0 && value.height <= REMOTE_COMPOUND_VIDEO.maxDimension
    && value.width * value.height <= REMOTE_COMPOUND_VIDEO.maxFramePixels;
}

export function isCompoundTile(tile: CompoundTileDescriptor, frame: CompoundFrameIdentity): boolean {
  return typeof tile.key === "string" && /^[a-f0-9]{64}$/.test(tile.key)
    && [tile.x, tile.y, tile.width, tile.height, tile.bytes].every(Number.isSafeInteger)
    && tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0
    && tile.width <= REMOTE_COMPOUND_VIDEO.tileSize && tile.height <= REMOTE_COMPOUND_VIDEO.tileSize
    && tile.x % REMOTE_COMPOUND_VIDEO.tileSize === 0 && tile.y % REMOTE_COMPOUND_VIDEO.tileSize === 0
    && tile.x + tile.width <= frame.width && tile.y + tile.height <= frame.height
    && tile.bytes > 0 && tile.bytes <= REMOTE_COMPOUND_VIDEO.maxTileBytes
    && Number.isFinite(tile.entropy) && tile.entropy >= 0 && tile.entropy <= REMOTE_COMPOUND_VIDEO.maxEntropy;
}

export function compoundRtpTimestamp(timestamp: number): number {
  return Math.round(timestamp * 90_000) >>> 0;
}

/** Strictly later within the half-range of a wrapping 32-bit RTP clock. */
export function isLaterCompoundRtp(a: number, b: number): boolean {
  const distance = (a - b) >>> 0;
  return distance !== 0 && distance < 0x8000_0000;
}

export function splitCompoundVideoBitRate(bitRate: number, enabled: boolean): { videoBitRate: number; patchBytesPerSecond: number } {
  const patchBits = enabled && bitRate >= 500_000 ? Math.floor(bitRate * 0.08) : 0;
  return { videoBitRate: bitRate - patchBits, patchBytesPerSecond: patchBits / 8 };
}

/** Cache entries become reusable only after the receiver admits the exact plan. */
export class RemoteCompoundVideoPolicy {
  private frame: CompoundFrameIdentity | null = null;
  private assets = new Map<string, { width: number; height: number; cacheId: number }>();
  private placements = new Map<string, string>();
  private cachePixels = 0;
  private reservedIds = 0;

  invalidate(frame: CompoundFrameIdentity, rects?: readonly CompoundDirtyRect[]): boolean {
    if (!isCompoundFrame(frame)) return false;
    const changedEpoch = !this.frame || this.frame.epoch !== frame.epoch
      || this.frame.width !== frame.width || this.frame.height !== frame.height;
    if (!changedEpoch && frame.revision < this.frame!.revision) return false;
    if (changedEpoch) this.resetCache();
    else if (frame.revision !== this.frame!.revision) {
      if (!rects?.length || rects.length > 32 || !rects.every(rect => isCompoundDirtyRect(rect, frame))) this.placements.clear();
      else for (const [position, key] of this.placements) {
        const [x, y] = position.split(",").map(Number);
        const size = this.assets.get(key)!;
        if (rects.some(rect => x < rect.x + rect.width && x + size.width > rect.x
          && y < rect.y + rect.height && y + size.height > rect.y)) this.placements.delete(position);
      }
    }
    this.frame = { ...frame };
    return true;
  }

  plan(frame: CompoundFrameIdentity, tiles: readonly CompoundTileDescriptor[], byteBudget: number, cost: CompoundEncodingCost = JSON_COST): CompoundUpdatePlan | null {
    if (!this.matches(frame) || !Number.isFinite(byteBudget)
      || ![cost.headerBytes, cost.tileBytes, cost.payloadNumerator, cost.payloadDenominator].every(Number.isSafeInteger)
      || cost.headerBytes < 0 || cost.tileBytes <= 0 || cost.payloadNumerator <= 0 || cost.payloadDenominator <= 0
      || byteBudget < cost.headerBytes) return null;
    const updates: CompoundTileUpdate[] = [];
    const admitted = new Map<string, { width: number; height: number; cacheId: number }>();
    const positions = new Set<string>();
    let bytes = cost.headerBytes;
    let pixels = this.cachePixels;
    for (const tile of tiles.slice(0, REMOTE_COMPOUND_VIDEO.maxTiles)) {
      if (!isCompoundTile(tile, frame)) continue;
      const position = `${tile.x},${tile.y}`;
      if (positions.has(position) || this.placements.get(position) === tile.key) continue;
      const asset = this.assets.get(tile.key) ?? admitted.get(tile.key);
      if (asset && (asset.width !== tile.width || asset.height !== tile.height)) continue;
      const mode = asset ? "reuse" : "put";
      const tileCost = cost.tileBytes + (mode === "put" ? Math.ceil(tile.bytes / cost.payloadDenominator) * cost.payloadNumerator : 0);
      if (bytes + tileCost > Math.min(byteBudget, REMOTE_COMPOUND_VIDEO.maxMessageBytes)) continue;
      const cacheId = asset?.cacheId ?? this.reservedIds + admitted.size + 1;
      if (!asset) {
        pixels += tile.width * tile.height;
        if (pixels > REMOTE_COMPOUND_VIDEO.maxCachePixels
          || cacheId > REMOTE_COMPOUND_VIDEO.maxCacheEntries
          || this.assets.size + admitted.size >= REMOTE_COMPOUND_VIDEO.maxCacheEntries) {
          return { frame: { ...frame }, tiles: [], estimatedBytes: 0, resetRequired: true };
        }
        admitted.set(tile.key, { width: tile.width, height: tile.height, cacheId });
      }
      positions.add(position);
      updates.push({ ...tile, mode, cacheId });
      bytes += tileCost;
    }
    return updates.length ? { frame: { ...frame }, tiles: updates, estimatedBytes: bytes, resetRequired: false } : null;
  }

  acknowledge(plan: CompoundUpdatePlan): boolean {
    if (!this.markSent(plan)) return false;
    for (const tile of plan.tiles) {
      if (!this.assets.has(tile.key)) {
        this.assets.set(tile.key, { width: tile.width, height: tile.height, cacheId: tile.cacheId });
        this.cachePixels += tile.width * tile.height;
      }
      this.placements.set(`${tile.x},${tile.y}`, tile.key);
    }
    return true;
  }

  /** Sent but unacknowledged slots may exist at the receiver, even after invalidation. */
  markSent(plan: CompoundUpdatePlan): boolean {
    if (plan.resetRequired || !this.matches(plan.frame)) return false;
    for (const tile of plan.tiles) this.reservedIds = Math.max(this.reservedIds, tile.cacheId);
    return true;
  }

  resetCache(): void {
    this.assets.clear();
    this.placements.clear();
    this.cachePixels = 0;
    this.reservedIds = 0;
  }

  reset(): void { this.frame = null; this.resetCache(); }

  private matches(frame: CompoundFrameIdentity): boolean {
    return isCompoundFrame(frame) && this.frame?.epoch === frame.epoch && this.frame.revision === frame.revision
      && this.frame.width === frame.width && this.frame.height === frame.height;
  }
}
