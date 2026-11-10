import { isLaterCompoundRtp } from "../../../core/src/domain/live-view/remote-compound-video.js";
import { compoundPngBytes } from "../../../core/src/infrastructure/live-view/compound-video-wire.js";

interface CursorState { sequence: number; x: number; y: number; visible: boolean; active: boolean; cutoverRtp: number; shape?: string; image?: string; hotX?: number; hotY?: number; drawWidth?: number; drawHeight?: number; pixelScale?: number; }

/** Separate low-latency cursor; the video cutover prevents double cursors on activation. */
export class BrowserRemoteCursor {
  private channel?: RTCDataChannel;
  private state?: CursorState;
  private stopped = false;
  private video?: HTMLVideoElement;
  private frameCallback?: number;
  private rtp?: number;
  private activatedCutover?: number;
  private receivedAt = -Infinity;
  private local?: { x: number; y: number; at: number };
  private image?: HTMLImageElement;
  private imageData?: string;
  private remove?: () => void;
  constructor(private readonly options: { getVideo(): HTMLVideoElement | null; getCanvas(): HTMLCanvasElement | null }) {}

  attach(peer: RTCPeerConnection): void {
    const accept = (event: RTCDataChannelEvent) => {
      if (event.channel.label !== "agentroam.cursor.v1" || this.stopped) return;
      if (this.channel) { event.channel.close(); return; }
      this.channel = event.channel;
      event.channel.onmessage = event => this.receive(event.data);
      event.channel.onclose = () => { this.state = undefined; this.hide(); };
      this.observe();
    };
    const track = () => this.observe();
    peer.addEventListener("datachannel", accept); peer.addEventListener("track", track);
    this.remove = () => { peer.removeEventListener("datachannel", accept); peer.removeEventListener("track", track); };
  }
  private observe(): void {
    const video = this.options.getVideo();
    if (!video || this.video === video || !this.channel || typeof video.requestVideoFrameCallback !== "function") return;
    this.video = video;
    const frame: VideoFrameRequestCallback = (_now, metadata) => {
      if (this.stopped) return;
      this.rtp = (metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp;
      this.render(); this.frameCallback = video.requestVideoFrameCallback(frame);
    };
    this.frameCallback = video.requestVideoFrameCallback(frame);
  }
  receive(input: unknown): void {
    if (this.stopped || typeof input !== "string" || input.length > 12_000) return;
    try {
      const state = JSON.parse(input) as CursorState;
      if (![state.sequence, state.cutoverRtp].every(Number.isSafeInteger) || state.cutoverRtp < 0 || state.cutoverRtp > 0xffff_ffff
        || ![state.x, state.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
        || typeof state.active !== "boolean" || typeof state.visible !== "boolean"
        || this.state && state.sequence <= this.state.sequence) return;
      if (state.shape && state.shape !== this.state?.shape) { this.image = undefined; this.imageData = undefined; }
      this.state = { ...this.state, ...state };
      this.receivedAt = Date.now();
      if (typeof state.image === "string" && state.image !== this.imageData && state.image.length <= 8192 && /^[A-Za-z0-9+/]+={0,2}$/.test(state.image)) {
        compoundPngBytes(state.image);
        this.imageData = state.image;
        const image = new Image();
        image.onload = () => { if (!this.stopped && this.imageData === state.image && image.naturalWidth <= 64 && image.naturalHeight <= 64) { this.image = image; this.render(); } };
        image.src = `data:image/png;base64,${state.image}`;
      }
      this.observe(); this.render();
    } catch { /* Cursor metadata is optional and never interrupts video. */ }
  }
  localPoint(point: { x?: unknown; y?: unknown }): void {
    if (typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.local = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)), at: Date.now() }; this.render();
  }
  private render(): void {
    const state = this.state, video = this.options.getVideo(), canvas = this.options.getCanvas();
    if (!canvas) return;
    if (!state?.active || !state.visible || this.stopped || Date.now() - this.receivedAt > 2000 || !video?.videoWidth || video.videoWidth > 4096 || video.videoHeight > 4096 || video.videoWidth * video.videoHeight > 8_388_608 || this.rtp === undefined
      || this.activatedCutover !== state.cutoverRtp && this.rtp !== state.cutoverRtp && !isLaterCompoundRtp(this.rtp, state.cutoverRtp)) { this.hide(); return; }
    this.activatedCutover = state.cutoverRtp;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const point = this.local && Date.now() - this.local.at < 150 ? this.local : state;
    const x = point.x * canvas.width, y = point.y * canvas.height;
    const bounded = (value: unknown, fallback: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
    if (this.image) ctx.drawImage(this.image, x - bounded(state.hotX, 0, 128), y - bounded(state.hotY, 0, 128),
      bounded(state.drawWidth, this.image.naturalWidth, 128), bounded(state.drawHeight, this.image.naturalHeight, 128));
    else {
      ctx.save(); ctx.translate(x, y); const scale = bounded(state.pixelScale, 1, 4); ctx.scale(scale, scale); ctx.lineWidth = 2; ctx.strokeStyle = "white"; ctx.fillStyle = "black";
      ctx.beginPath();
      if (state.shape === "text") { ctx.moveTo(0, -8); ctx.lineTo(0, 8); ctx.moveTo(-4, -8); ctx.lineTo(4, -8); ctx.moveTo(-4, 8); ctx.lineTo(4, 8); }
      else { ctx.moveTo(0, 0); ctx.lineTo(0, 20); ctx.lineTo(5, 15); ctx.lineTo(9, 23); ctx.lineTo(13, 21); ctx.lineTo(9, 13); ctx.lineTo(17, 13); ctx.closePath(); ctx.fill(); }
      ctx.stroke(); ctx.restore();
    }
    canvas.style.visibility = "visible";
    canvas.parentElement?.classList.add("has-independent-cursor");
  }
  private hide(): void {
    const canvas = this.options.getCanvas();
    if (canvas) { canvas.style.visibility = "hidden"; canvas.parentElement?.classList.remove("has-independent-cursor"); }
  }
  stop(): void {
    this.stopped = true; this.hide(); this.remove?.(); this.channel?.close();
    if (this.frameCallback !== undefined) this.video?.cancelVideoFrameCallback(this.frameCallback);
    if (this.image) this.image.src = "";
  }
}
