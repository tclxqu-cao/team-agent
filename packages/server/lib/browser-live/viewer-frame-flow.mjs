/** At most one unacknowledged image per viewer; queued images replace stale ones. */
export class ViewerFrameFlow {
  constructor(send, canSend = () => true) {
    this.send = send;
    this.canSend = canSend;
    this.reset(false);
  }

  reset(requireAck) {
    this.requireAck = requireAck;
    this.inFlight = null;
    this.latest = null;
  }

  offer(frame) {
    this.latest = frame;
    this.flush();
  }

  ack(channelId, sequence) {
    if (!this.inFlight || this.inFlight.channelId !== channelId || this.inFlight.sequence !== sequence) return;
    this.inFlight = null;
    this.flush();
  }

  flush() {
    if (this.inFlight || !this.latest || !this.canSend()) return;
    const frame = this.latest;
    this.latest = null;
    if (this.requireAck) this.inFlight = { channelId: frame.channelId, sequence: frame.sequence };
    this.send(frame);
  }
}
