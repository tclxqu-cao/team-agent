import { RtpPacket, wrapRtx, RTP_EXTENSION_URI, serializeTransportWideCC, serializeAbsSendTime } from 'werift';

/** Isolates werift 0.24.x's per-sender NACK handler and negotiated wire RTP from recovery policy. */
export class WeriftVideoRecovery {
  constructor({ sender, history, pacer, clock, active }) {
    this.sender = sender;
    this.history = history;
    this.pacer = pacer;
    this.clock = clock;
    this.active = active;
    this.repairedPackets = 0;
    this.repairedBytes = 0;
    this.recoveryRequests = 0;
    this.originalHandler = sender.handleRtcpPacket;
    if (typeof this.originalHandler !== 'function' || !sender.onGenericNack?.execute || !sender.onRtcp?.execute) {
      throw new Error('Unsupported werift video recovery interface');
    }
    // The router resolves this method on the sender instance. Delegating after NACK processing
    // would also execute werift's fixed 128-packet, unpaced retransmission path.
    this.handler = packet => {
      if (packet.type !== 205 || packet.feedback?.count !== 1) return this.originalHandler.call(sender, packet);
      const feedback = packet.feedback;
      if (feedback.mediaSourceSsrc !== sender.ssrc) return;
      sender.nackCount += 1;
      if (this.active() && Array.isArray(feedback.lost)) {
        if (feedback.lost.length > this.pacer.policy.maxQueuedRepairs) this.recover();
        else for (const sequence of new Set(feedback.lost)) {
          const request = history.request(sequence, clock.now());
          if (request.action === 'recover') { this.recover(); break; }
          if (request.action === 'repair' && !pacer.enqueueRepair({
            value: request.entry, bytes: request.entry.bytes, expiresAt: request.entry.expiresAt,
          })) { this.recover(); break; }
        }
      }
      sender.onGenericNack.execute(feedback);
      sender.onRtcp.execute(packet);
    };
    sender.handleRtcpPacket = this.handler;
  }

  record(packet, frame) {
    if (!this.active()) return;
    if (frame.keyFrameStart) this.pacer.clearRepairs();
    // Serialize after werift assigned SSRC, sequence/timestamp offsets and negotiated extensions.
    // The retained buffer owns its bytes; repairs never mutate the original packet or its payload.
    const value = RtpPacket.deSerialize(packet.serialize());
    this.history.record({ ...frame, value, sequence: value.header.sequenceNumber,
      bytes: value.serializeSize + 66 }, this.clock.now());
  }

  recover() {
    this.history.reset();
    this.recoveryRequests += 1;
    this.pacer.recover(this.clock.now(), true);
  }

  expired(entry) {
    if (this.history.beginRepair(entry, this.clock.now()) === 'recover') this.recover();
  }

  async write(entry) {
    if (!this.active()) return false;
    const action = this.history.beginRepair(entry, this.clock.now());
    if (action === 'recover') this.recover();
    if (action !== 'send') return false;
    const sender = this.sender;
    let packet = RtpPacket.deSerialize(entry.value.serialize());
    // RTX fields and counters are confined to this version-specific adapter. The current offer
    // uses H264 without RTX; retain correctness if a compatible RTX codec is negotiated later.
    if (sender.rtxPayloadType !== undefined) {
      packet = wrapRtx(packet, sender.rtxPayloadType, sender.rtxSequenceNumber, sender.rtxSsrc);
      sender.rtxSequenceNumber = (sender.rtxSequenceNumber + 1) & 65_535;
    }
    for (const extension of sender.headerExtensions ?? []) {
      const field = packet.header.extensions.find(field => field.id === extension.id);
      if (!field) continue;
      if (extension.uri === RTP_EXTENSION_URI.transportWideCC) {
        sender.dtlsTransport.transportSequenceNumber = (sender.dtlsTransport.transportSequenceNumber + 1) & 65_535;
        field.payload = serializeTransportWideCC(sender.dtlsTransport.transportSequenceNumber);
      } else if (extension.uri === RTP_EXTENSION_URI.absSendTime) {
        const ms = BigInt(Date.now());
        field.payload = serializeAbsSendTime(((ms / 1_000n + 2_208_988_800n) << 32n) + ((ms % 1_000n) << 32n) / 1_000n);
      }
    }
    const size = await sender.dtlsTransport.sendRtp(packet.payload, packet.header);
    const sentAtMs = Date.now();
    sender.senderBWE.rtpPacketSent({ wideSeq: sender.dtlsTransport.transportSequenceNumber,
      size, sendingAtMs: sentAtMs, sentAtMs });
    sender.retransmittedPacketsSent += 1;
    sender.retransmittedBytesSent += packet.payload.length;
    sender.headerBytesSent += packet.header.serializeSize;
    this.repairedPackets += 1;
    this.repairedBytes += entry.bytes;
    return true;
  }

  snapshot() {
    return { ...this.history.snapshot(this.clock.now()), repairedPackets: this.repairedPackets,
      repairedBytes: this.repairedBytes, recoveryRequests: this.recoveryRequests };
  }

  reset() { this.history.reset(); }

  dispose() {
    if (this.sender.handleRtcpPacket === this.handler) this.sender.handleRtcpPacket = this.originalHandler;
    this.reset();
  }
}
