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
  private latencyPressure = 0;
  private sourceEdge = 0;
  private fpsCeiling = 30;
  private displayedEdge = 0;

  reset(fpsCeiling = 30): void {
    this.fpsCeiling = this.maxFps = fpsCeiling; this.maxEdge = undefined; this.sequence = -1;
    this.lastSampleAt = this.sizeAt = -Infinity; this.pressure = this.healthy = this.latencyPressure = 0;
    this.scale = 1; this.sourceEdge = this.displayedEdge = 0;
  }

  reduceSizeForMotion(now: number): boolean {
    const edge = Math.min(this.displayedEdge, this.maxEdge ?? Infinity);
    if (edge <= 640) return false;
    if (now - this.sizeAt < 5000) return true;
    const next = EDGES.filter(value => value <= edge * .8).at(-1) ?? 640;
    this.scale = Math.max(.1, this.scale * next / edge);
    this.maxEdge = next;
    this.sizeAt = now;
    this.healthy = 0;
    return true;
  }

  observe(sample: RemoteVideoReceiverTelemetry | undefined, quality: RemoteVideoQuality, fps: number, now: number, preferFrameRate = false): boolean {
    if (!sample || !Number.isSafeInteger(sample.sequence) || sample.sequence <= this.sequence || !Number.isFinite(now)) return false;
    this.sequence = sample.sequence;
    if (sample.visible !== true) { this.pressure = this.healthy = this.latencyPressure = 0; return false; }
    if (now - this.lastSampleAt < 750) return false;
    this.lastSampleAt = now;
    const oldFps = this.maxFps, oldEdge = this.maxEdge;
    if (sample.width && sample.height) this.displayedEdge = Math.max(sample.width, sample.height);
    const validInterval = sample.intervalMs !== undefined && sample.intervalMs >= 250 && sample.intervalMs <= 5000;
    const evidence = validInterval && (sample.decodedFrames ?? 0) >= 3;
    const minimumBufferMs = Math.max(0, sample.jitterBufferMinimumMs ?? 0);
    // A backed-up IDR stream may deliver only one frame per second. Requiring
    // three decoded frames here prevents it from ever escaping that state.
    const delayed = validInterval && (sample.decodedFrames ?? 0) >= 1
      && (sample.jitterBufferMs ?? 0) >= Math.max(200, minimumBufferMs + 100);
    this.latencyPressure = delayed ? this.latencyPressure + 1 : 0;
    const frameBudget = 1000 / clamp(fps, 5, this.fpsCeiling);
    const overloaded = evidence && ((sample.decodeMs ?? 0) > frameBudget * .8
      || (sample.droppedRatio ?? 0) >= .08
      || (sample.presentationDelayMs ?? 0) >= Math.max(50, frameBudget * .8));
    // Browser-required buffering is not excess delivery delay. Ignoring its
    // minimum can keep shrinking healthy playback and prevent size recovery.
    const knownHealthy = evidence && (sample.jitterBufferMs ?? 0) < Math.max(120, minimumBufferMs + 100)
      && [sample.decodeMs, sample.droppedRatio, sample.presentationDelayMs].some(Number.isFinite)
      && (sample.decodeMs ?? 0) < 20 && (sample.droppedRatio ?? 0) < .02
      && (sample.presentationDelayMs ?? 0) < Math.max(20, frameBudget * .6);
    if (overloaded) {
      this.healthy = 0; this.pressure += 1;
      if (this.pressure >= 2 && !(preferFrameRate && this.reduceSizeForMotion(now))) {
        this.maxFps = this.maxFps > 30 ? 30 : this.maxFps > 15 ? 15 : 5;
      }
      if (!preferFrameRate && this.pressure >= 4 && now - this.sizeAt >= 5000) { this.scale = Math.max(.4, this.scale * .75); this.pressure = 0; }
    } else if (knownHealthy) {
      this.pressure = 0; this.healthy += 1;
      if (this.healthy >= 5) {
        this.maxFps = this.maxFps < 15 ? 15 : this.maxFps < 30 ? 30 : this.fpsCeiling;
        this.scale = Math.min(1, this.scale / .75); this.healthy = 0;
      }
    } else { this.pressure = this.healthy = 0; }

    // Relieve sustained delivery delay through frame size rather than further
    // reducing motion cadence. Leave decoder overload's FPS protection intact.
    if (this.latencyPressure >= 2 && now - this.sizeAt >= 5000) {
      this.scale = Math.max(.2, this.scale * .75); this.latencyPressure = 0; this.healthy = 0;
    }

    const viewport = sample.viewport;
    const width = sample.width ?? 0, height = sample.height ?? 0;
    this.sourceEdge = Math.max(this.sourceEdge, width, height);
    const ceiling = quality === 'smooth' ? 1280 : quality === 'hd' ? 2560 : 8192;
    let demand: number | undefined;
    if (quality !== 'original' && viewport && [viewport.width, viewport.height, viewport.pixelRatio, viewport.zoom].every(Number.isFinite)
      && width > 0 && height > 0 && viewport.width > 0 && viewport.height > 0) {
      const fit = Math.min(viewport.width / width, viewport.height / height);
      demand = Math.max(width, height) * fit * clamp(viewport.pixelRatio, 1, 4) * clamp(viewport.zoom, 1, 4);
    } else if (this.scale < 1 && width > 0 && height > 0) demand = this.sourceEdge;
    // Explicit original quality ignores the viewport; pressure can still bound expensive decoding.
    const edge = demand === undefined ? undefined : clamp(demand * this.scale, 640, ceiling);
    const next = edge === undefined ? undefined : this.scale < 1
      ? EDGES.filter(value => value <= edge).at(-1) ?? 640
      : Math.min(ceiling, EDGES.find(value => value >= edge) ?? ceiling);
    if (next !== this.maxEdge && (this.sizeAt === -Infinity || now - this.sizeAt >= 5000)) {
      // Ignore small geometry jitter, but allow an explicit native-size restore.
      if (next === undefined || this.maxEdge === undefined || Math.abs(next - this.maxEdge) / this.maxEdge >= .2) {
        this.maxEdge = next; this.sizeAt = now;
      }
    }
    return oldFps !== this.maxFps || oldEdge !== this.maxEdge;
  }
}
