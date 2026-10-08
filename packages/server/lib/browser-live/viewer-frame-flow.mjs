/** Byte-bounded acknowledgement window; unsent images replace stale ones. */
export class ViewerFrameFlow {
  constructor(send, canSend = () => true, { maxFrames = 1, maxBytes = 256 * 1024 } = {}) {
    this.send = send;
    this.canSend = canSend;
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.reset(false);
  }

  reset(requireAck) {
    this.requireAck = requireAck;
    this.inFlight = [];
    this.latest = null;
  }

  /** Returns "sent" | "queued" | "dropped"; "dropped" = replaced before it ever went out. */
  offer(frame) {
    const replaced = this.latest !== null;
    this.latest = frame;
    const sent = this.flush();
    return sent ? "sent" : (replaced ? "dropped" : "queued");
  }

  ack(channelId, sequence) {
    const index = this.inFlight.findIndex(frame => frame.channelId === channelId && frame.sequence === sequence);
    if (index < 0) return;
    this.inFlight.splice(index, 1);
    this.flush();
  }

  flush() {
    if (!this.latest || !this.canSend() || this.inFlight.length >= this.maxFrames) return false;
    const bytes = this.latest.bytes.byteLength;
    const outstanding = this.inFlight.reduce((sum, frame) => sum + frame.bytes, 0);
    // A single oversized legacy frame may pass, but cannot build a backlog.
    if (this.inFlight.length && outstanding + bytes > this.maxBytes) return false;
    const frame = this.latest;
    this.latest = null;
    if (this.requireAck) this.inFlight.push({ channelId: frame.channelId, sequence: frame.sequence, bytes });
    this.send(frame);
    return true;
  }
}
