import type { RemoteVideoQuality, RemoteVideoReceiverTelemetry } from './remote-video-types.js';

const EDGES = [640, 960, 1280, 1600, 1920, 2560, 3200, 4096, 5120, 8192];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Receiver CPU/display pressure is independent of link congestion and source activity. */
export class RemoteVideoReceiverPolicy {
  maxFps = 30;
  maxEdge?: number;
  private sequence = -1;
  private lastSampleAt = -Infinity;
  private sizeAt = -Infinity;
  private pressure = 0;
  private healthy = 0;
  private scale = 1;

  reset(): void {
    this.maxFps = 30; this.maxEdge = undefined; this.sequence = -1;
    this.lastSampleAt = this.sizeAt = -Infinity; this.pressure = this.healthy = 0; this.scale = 1;
  }

  observe(sample: RemoteVideoReceiverTelemetry | undefined, quality: RemoteVideoQuality, fps: number, now: number): boolean {
    if (!sample || !Number.isSafeInteger(sample.sequence) || sample.sequence <= this.sequence || !Number.isFinite(now)) return false;
    this.sequence = sample.sequence;
    if (sample.visible !== true) { this.pressure = this.healthy = 0; return false; }
    if (now - this.lastSampleAt < 750) return false;
    this.lastSampleAt = now;
    const oldFps = this.maxFps, oldEdge = this.maxEdge;
    const evidence = sample.intervalMs !== undefined && sample.intervalMs >= 250 && sample.intervalMs <= 5000
      && (sample.decodedFrames ?? 0) >= 3;
    const frameBudget = 1000 / clamp(fps, 5, 30);
    const overloaded = evidence && ((sample.decodeMs ?? 0) > frameBudget * .8
      || (sample.droppedRatio ?? 0) >= .08 || (sample.presentationDelayMs ?? 0) >= 50);
    const knownHealthy = evidence && [sample.decodeMs, sample.droppedRatio, sample.presentationDelayMs].some(Number.isFinite)
      && (sample.decodeMs ?? 0) < 20 && (sample.droppedRatio ?? 0) < .02 && (sample.presentationDelayMs ?? 0) < 20;
    if (overloaded) {
      this.healthy = 0; this.pressure += 1;
      if (this.pressure >= 2) this.maxFps = this.maxFps > 15 ? 15 : 5;
      if (this.pressure >= 4 && now - this.sizeAt >= 5000) { this.scale = Math.max(.4, this.scale * .75); this.pressure = 0; }
    } else if (knownHealthy) {
      this.pressure = 0; this.healthy += 1;
      if (this.healthy >= 5) {
        this.maxFps = this.maxFps < 15 ? 15 : 30;
        this.scale = Math.min(1, this.scale / .75); this.healthy = 0;
      }
    } else { this.pressure = this.healthy = 0; }

    const viewport = sample.viewport;
    const width = sample.width ?? 0, height = sample.height ?? 0;
    const ceiling = quality === 'smooth' ? 1280 : quality === 'hd' ? 2560 : 8192;
    let demand: number | undefined;
    if (quality !== 'original' && viewport && [viewport.width, viewport.height, viewport.pixelRatio, viewport.zoom].every(Number.isFinite)
      && width > 0 && height > 0 && viewport.width > 0 && viewport.height > 0) {
      const fit = Math.min(viewport.width / width, viewport.height / height);
      demand = Math.max(width, height) * fit * clamp(viewport.pixelRatio, 1, 4) * clamp(viewport.zoom, 1, 4);
    } else if (this.scale < 1 && width > 0 && height > 0) demand = Math.max(width, height);
    // Explicit original quality ignores the viewport; pressure can still bound expensive decoding.
    let next = demand === undefined ? undefined : Math.min(ceiling, EDGES.find(edge => edge >= clamp(demand! * this.scale, 640, ceiling)) ?? ceiling);
    if (next !== this.maxEdge && (this.sizeAt === -Infinity || now - this.sizeAt >= 5000)) {
      // Ignore small geometry jitter, but allow an explicit native-size restore.
      if (next === undefined || this.maxEdge === undefined || Math.abs(next - this.maxEdge) / this.maxEdge >= .2) {
        this.maxEdge = next; this.sizeAt = now;
      }
    }
    return oldFps !== this.maxFps || oldEdge !== this.maxEdge;
  }
}
