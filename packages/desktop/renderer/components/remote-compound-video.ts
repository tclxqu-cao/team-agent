import {
  REMOTE_COMPOUND_VIDEO as limits, isCompoundFrame, isCompoundDirtyRect, isLaterCompoundRtp,
  type CompoundDirtyRect,
} from "../../../core/src/domain/live-view/remote-compound-video.js";
import { isCompoundScrollCopy } from "../../../core/src/domain/live-view/remote-compound-quality.js";
import { compoundPngBytes, decodeCompoundTiles } from "../../../core/src/infrastructure/live-view/compound-video-wire.js";

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}
interface Tile {
  key: string; x: number; y: number; width: number; height: number; data?: string | Uint8Array;
}
interface TileMessage {
  epoch: string; revision: number; sequence: number; rtpTimestamp: number; tiles: Tile[]; binary?: boolean; wireBytes?: number;
}
interface Options {
  getVideo(): HTMLVideoElement | null;
  getCanvas(): HTMLCanvasElement | null;
  decodeImage?: (data: string | Uint8Array) => Promise<DecodedImage>;
  createCanvas?: () => HTMLCanvasElement | OffscreenCanvas;
}

function validRtp(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

async function decodePng(data: string | Uint8Array): Promise<DecodedImage> {
  const bytes = compoundPngBytes(data);
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: "image/png" });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("PNG decode failed"));
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ""; } };
  } finally { URL.revokeObjectURL(url); }
}

/** Browser infrastructure adapter. H264 remains visible whenever synchronization is unknown. */
export class BrowserCompoundVideo {
  private readonly decodeImage: (data: string | Uint8Array) => Promise<DecodedImage>;
  private channel: RTCDataChannel | null = null;
  private removePeerListener?: () => void;
  private observedVideo: HTMLVideoElement | null = null;
  private callback?: number;
  private stopped = false;
  private generation = 0;
  private epoch: string | null = null;
  private revision = -1;
  private width = 0;
  private height = 0;
  private assets = new Map<string, DecodedImage>();
  private cachePixels = 0;
  private barriers = new Map<number, number>();
  private presentedRtp?: number;
  private sourceRtp?: number;
  private hasPixels = false;
  private decoding = false;
  private pending: TileMessage | null = null;
  private batches: TileMessage[] = [];
  private decodingBytes = 0;
  private lastReceivedSequence = 0;
  private previousCanvas: { canvas: HTMLCanvasElement | OffscreenCanvas; revision: number } | null = null;
  private presentedAt = 0;
  private reportedRtp?: number;
  private lastSequence = 0;

  constructor(private readonly options: Options) { this.decodeImage = options.decodeImage ?? decodePng; }

  static supported(): boolean {
    return typeof HTMLVideoElement !== "undefined"
      && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";
  }

  attach(peer: RTCPeerConnection): void {
    const onChannel = (event: RTCDataChannelEvent) => {
      if (event.channel.label !== limits.channelLabel || this.stopped) return;
      if (this.channel) { event.channel.close(); return; }
      this.channel = event.channel;
      event.channel.binaryType = "arraybuffer";
      const ready = () => this.feedback({ kind: "ready", version: 1, formats: ["binary-zstd-v1", "binary-v1", "json-v1"], features: ["window-v1", "scroll-v1", "qoe-v1", "cursor-v1"], maxTileBytes: limits.maxTileBytes });
      event.channel.onopen = ready;
      event.channel.onmessage = event => this.receive(event.data);
      event.channel.onclose = () => this.stop();
      if (event.channel.readyState === "open") ready();
      this.observeVideo();
    };
    const onTrack = () => this.observeVideo();
    peer.addEventListener("datachannel", onChannel);
    peer.addEventListener("track", onTrack);
    this.removePeerListener = () => {
      peer.removeEventListener("datachannel", onChannel);
      peer.removeEventListener("track", onTrack);
    };
  }

  private observeVideo(): void {
    const video = this.options.getVideo();
    if (this.stopped || !this.channel || !video || this.observedVideo === video) return;
    if (typeof video.requestVideoFrameCallback !== "function") { this.fail(); return; }
    this.observedVideo = video;
    const observe: VideoFrameRequestCallback = (_now, metadata) => {
      if (this.stopped) return;
      this.presentFrame((metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp);
      if (!this.stopped) this.callback = video.requestVideoFrameCallback(observe);
    };
    this.callback = video.requestVideoFrameCallback(observe);
  }

  /** Hide first; only a barrier for this exact presented video frame can reveal patches. */
  presentFrame(rtpTimestamp: number | undefined): void {
    if (this.stopped) return;
    if (!validRtp(rtpTimestamp)) { this.fail(); return; }
    this.presentedRtp = rtpTimestamp;
    this.presentedAt = Date.now();
    this.reportPresentation();
    this.renderVisibility();
  }

  receive(input: unknown): void {
    if (this.stopped) return;
    try {
      if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
        const message = decodeCompoundTiles(input instanceof Uint8Array ? input : new Uint8Array(input));
        this.receiveTiles({ ...message, binary: true, wireBytes: input.byteLength, tiles: message.tiles.map(tile => ({ ...tile, key: `slot:${tile.cacheId}` })) });
        return;
      }
      if (typeof input !== "string" || input.length > limits.maxMessageBytes) throw new Error("Invalid compound envelope");
      const message = JSON.parse(input) as Record<string, unknown>;
      if (!message || message.version !== 1) throw new Error("Unsupported compound version");
      if (message.kind === "ping" && Number.isFinite(message.t0)) {
        const t1 = Date.now(); this.feedback({ kind: "pong", t0: message.t0, t1, t2: Date.now() }); return;
      }
      if (message.kind === "reset") {
        const identity = { epoch: message.epoch, revision: message.revision, timestamp: 0, width: message.width, height: message.height };
        if (!isCompoundFrame(identity as Parameters<typeof isCompoundFrame>[0])) throw new Error("Invalid compound geometry");
        this.clearAssets();
        this.epoch = message.epoch as string;
        this.width = message.width as number;
        this.height = message.height as number;
        this.revision = message.revision as number;
        this.lastSequence = 0;
        this.lastReceivedSequence = 0; this.previousCanvas = null;
        this.barriers.clear();
        const canvas = this.options.getCanvas();
        if (canvas) { canvas.width = this.width; canvas.height = this.height; }
        this.clearPlacements();
        return;
      }
      if (message.epoch !== this.epoch) return;
      if (message.kind === "disabled") { this.stop(); return; }
      if (!validRevision(message.revision)) throw new Error("Invalid compound revision");
      if (message.kind === "invalidate") {
        if (message.revision > this.revision) {
          this.saveScrollBase();
          const rects = message.rects as CompoundDirtyRect[] | undefined;
          if (rects !== undefined && (!Array.isArray(rects) || !rects.length || rects.length > 32
            || !rects.every(rect => isCompoundDirtyRect(rect, { width: this.width, height: this.height })))) throw new Error("Invalid dirty regions");
          this.revision = message.revision;
          this.clearPlacements(rects);
        }
      } else if (message.kind === "frame") {
        if (!validRtp(message.rtpTimestamp)) throw new Error("Invalid presentation barrier");
        if (message.revision > this.revision) { this.revision = message.revision; this.clearPlacements(); }
        this.barriers.set(message.rtpTimestamp, message.revision);
        while (this.barriers.size > 128) this.barriers.delete(this.barriers.keys().next().value!);
        this.renderVisibility();
        this.reportPresentation();
      } else if (message.kind === "scroll") {
        const copy = message.copy as Parameters<typeof isCompoundScrollCopy>[0];
        if (message.revision !== this.revision) return;
        if (!isCompoundScrollCopy(copy, { width: this.width, height: this.height }) || !validRtp(message.rtpTimestamp)
          || !Number.isSafeInteger(message.sequence) || Number(message.sequence) <= this.lastReceivedSequence) throw new Error("Invalid scroll command");
        this.lastReceivedSequence = Number(message.sequence);
        const base = this.previousCanvas, canvas = this.options.getCanvas(), context = canvas?.getContext("2d");
        const ok = !!base && base.revision === copy.sourceRevision && !!context;
        if (ok) {
          context!.clearRect(copy.x, copy.y, copy.width, copy.height);
          context!.drawImage(base!.canvas, copy.sourceX, copy.sourceY, copy.width, copy.height, copy.x, copy.y, copy.width, copy.height);
          this.hasPixels = true; this.sourceRtp = message.rtpTimestamp as number;
          this.renderVisibility();
        }
        this.previousCanvas = null;
        this.feedback({ kind: "ack", epoch: this.epoch, sequence: message.sequence, ok });
      } else if (message.kind === "tiles") {
        // A JSON peer cannot opt into the internal numeric-slot namespace.
        this.receiveTiles({ ...message, binary: false, wireBytes: new TextEncoder().encode(input).length } as unknown as TileMessage);
      }
    } catch { this.fail(); }
  }

  private receiveTiles(batch: TileMessage): void {
    if (batch.epoch !== this.epoch || batch.revision !== this.revision) return;
    if (!validRtp(batch.rtpTimestamp) || !Number.isSafeInteger(batch.sequence) || batch.sequence <= this.lastReceivedSequence
      || !Array.isArray(batch.tiles) || !batch.tiles.length || batch.tiles.length > limits.maxTiles) throw new Error("Invalid tile batch");
    this.lastReceivedSequence = batch.sequence;
    if (this.decoding) {
      if (this.batches.length >= 3 || this.decodingBytes + this.batches.reduce((sum, entry) => sum + (entry.wireBytes ?? 0), 0) + (batch.wireBytes ?? 0) > 64_000) throw new Error("Compound decode window exceeded");
      this.batches.push(batch);
    }
    else void this.applyTiles(batch);
  }

  private validTile(tile: Tile, binary = false): boolean {
    return typeof tile?.key === "string" && (binary ? /^slot:[1-9][0-9]{0,3}$/.test(tile.key) : /^[a-f0-9]{64}$/.test(tile.key))
      && [tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger)
      && tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0
      && tile.width <= limits.tileSize && tile.height <= limits.tileSize
      && tile.x % limits.tileSize === 0 && tile.y % limits.tileSize === 0
      && tile.x + tile.width <= this.width && tile.y + tile.height <= this.height;
  }

  private async applyTiles(batch: TileMessage): Promise<void> {
    this.decoding = true;
    this.decodingBytes = batch.wireBytes ?? 0;
    const generation = this.generation;
    const admitted = new Map<string, DecodedImage>();
    let committed = false;
    try {
      const canvas = this.options.getCanvas();
      const context = canvas?.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      for (const tile of batch.tiles) {
        if (!this.validTile(tile, batch.binary)) throw new Error("Invalid tile bounds");
        let asset = this.assets.get(tile.key);
        if (batch.binary && asset && tile.data !== undefined) throw new Error("Compound cache slot already occupied");
        if (!asset) {
          if (typeof tile.data !== "string" && !(tile.data instanceof Uint8Array)) throw new Error("Missing cached tile");
          compoundPngBytes(tile.data, tile.width, tile.height);
          const decoded = await this.decodeImage(tile.data);
          if (this.stopped || this.generation !== generation) { decoded.close(); return; }
          if (decoded.width !== tile.width || decoded.height !== tile.height
            || this.cachePixels + tile.width * tile.height > limits.maxCachePixels || this.assets.size >= limits.maxCacheEntries) {
            decoded.close(); throw new Error("Compound image cache limit exceeded");
          }
          asset = decoded;
          this.assets.set(tile.key, asset);
          admitted.set(tile.key, asset);
          this.cachePixels += tile.width * tile.height;
        }
        if (asset.width !== tile.width || asset.height !== tile.height) throw new Error("Cached tile dimensions differ");
        if (this.stopped || this.generation !== generation) return;
        context.drawImage(asset.source, tile.x, tile.y, tile.width, tile.height);
      }
      if (this.stopped || this.generation !== generation) return;
      this.sourceRtp = this.sourceRtp === undefined || isLaterCompoundRtp(batch.rtpTimestamp, this.sourceRtp) ? batch.rtpTimestamp : this.sourceRtp;
      this.hasPixels = true;
      this.lastSequence = batch.sequence;
      committed = true;
      this.feedback({ kind: "ack", epoch: this.epoch, sequence: batch.sequence, ok: true });
      this.renderVisibility();
    } catch {
      if (!this.stopped && this.generation === generation) {
        this.clearPlacements();
        this.feedback({ kind: "ack", epoch: this.epoch, sequence: batch.sequence, ok: false });
      }
    } finally {
      if (!committed) for (const [key, image] of admitted) {
        if (this.assets.get(key) === image) {
          this.assets.delete(key); this.cachePixels -= image.width * image.height; image.close();
        }
      }
      this.decoding = false;
      this.decodingBytes = 0;
      const pending = this.batches.shift(); this.pending = null;
      if (!this.stopped && pending && pending.epoch === this.epoch && pending.revision === this.revision) void this.applyTiles(pending);
    }
  }

  private renderVisibility(): void {
    const canvas = this.options.getCanvas();
    const video = this.options.getVideo();
    if (!canvas) return;
    const current = this.presentedRtp;
    const synchronized = current !== undefined && this.sourceRtp !== undefined
      && (current === this.sourceRtp || isLaterCompoundRtp(current, this.sourceRtp))
      && this.barriers.get(current) === this.revision;
    canvas.style.visibility = !this.stopped && this.hasPixels && synchronized
      && video?.videoWidth === this.width && video.videoHeight === this.height ? "visible" : "hidden";
  }

  private feedback(message: Record<string, unknown>): void {
    if (this.channel?.readyState === "open" && this.channel.bufferedAmount < 4096) {
      try { this.channel.send(JSON.stringify(message)); } catch { /* Enhancement receipts are optional for H264. */ }
    }
  }

  private reportPresentation(): void {
    if (this.presentedRtp === undefined || this.reportedRtp === this.presentedRtp || this.barriers.get(this.presentedRtp) !== this.revision) return;
    this.reportedRtp = this.presentedRtp;
    this.feedback({ kind: "presented", epoch: this.epoch, rtpTimestamp: this.presentedRtp, presentedAt: this.presentedAt });
  }

  private saveScrollBase(): void {
    const source = this.options.getCanvas();
    if (!source) return;
    const canvas = this.options.createCanvas?.() ?? (typeof document !== "undefined" ? document.createElement("canvas") : null);
    if (!canvas) return;
    canvas.width = this.width; canvas.height = this.height;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
    this.previousCanvas = { canvas, revision: this.revision };
  }

  private clearPlacements(rects?: readonly CompoundDirtyRect[]): void {
    this.generation += 1;
    this.pending = null;
    this.batches = [];
    if (!rects) { this.hasPixels = false; this.sourceRtp = undefined; }
    const canvas = this.options.getCanvas();
    const context = canvas?.getContext("2d");
    if (rects) for (const rect of rects) context?.clearRect(rect.x, rect.y, rect.width, rect.height);
    else if (canvas) context?.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.style.visibility = "hidden";
  }

  private clearAssets(): void {
    for (const asset of this.assets.values()) asset.close();
    this.assets.clear(); this.cachePixels = 0;
  }

  private fail(): void { this.feedback({ kind: "unsupported", version: 1 }); this.stop(); }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearPlacements(); this.clearAssets(); this.barriers.clear();
    this.previousCanvas = null;
    if (this.callback !== undefined) this.observedVideo?.cancelVideoFrameCallback(this.callback);
    this.removePeerListener?.();
    this.channel?.close(); this.channel = null;
  }
}
