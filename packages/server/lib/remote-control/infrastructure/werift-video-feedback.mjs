import { RemoteVideoFeedbackPolicy } from '@agent/core';
import { RTP_EXTENSION_URI } from 'werift';

/** Expand both standard status-vector and run-length chunks, with a bounded packet window. */
export function twccPacketResults(feedback, referenceTime = feedback?.referenceTime) {
  if (!feedback || !Number.isInteger(feedback.baseSequenceNumber) || feedback.baseSequenceNumber < 0 || feedback.baseSequenceNumber > 65_535
    || !Number.isInteger(feedback.packetStatusCount) || feedback.packetStatusCount < 1 || feedback.packetStatusCount > 8_192
    || !Number.isSafeInteger(referenceTime) || !Array.isArray(feedback.packetChunks) || !Array.isArray(feedback.recvDeltas)) return null;
  const statuses = [];
  for (const chunk of feedback.packetChunks.slice(0, 8_192)) {
    const remaining = feedback.packetStatusCount - statuses.length;
    if (remaining === 0) break;
    if (Array.isArray(chunk.symbolList)) statuses.push(...chunk.symbolList.slice(0, remaining));
    else if (Number.isInteger(chunk.runLength) && chunk.runLength > 0) {
      for (let index = 0; index < Math.min(chunk.runLength, remaining); index++) statuses.push(chunk.packetStatus);
    } else return null;
  }
  if (statuses.length !== feedback.packetStatusCount || statuses.some(status => ![0, 1, 2].includes(status))) return null;
  let timeUs = referenceTime * 64_000, deltaIndex = 0;
  const results = [];
  for (let index = 0; index < statuses.length; index++) {
    const result = { sequenceNumber: (feedback.baseSequenceNumber + index) & 65_535, received: statuses[index] !== 0 };
    if (result.received) {
      const delta = feedback.recvDeltas[deltaIndex++]?.delta;
      if (!Number.isFinite(delta) || delta < -8_192_000 || delta > 8_192_000) return null;
      timeUs += delta;
      result.receivedAtMs = timeUs / 1000;
    }
    results.push(result);
  }
  return results;
}

/** Negotiated werift feedback becomes a fresh, source-labelled domain sample. */
export class WeriftVideoFeedback {
  constructor({ sender, clock, active, sample, onEstimate }) {
    this.sender = sender;
    this.clock = clock; this.prunedAt = -Infinity;
    this.policy = new RemoteVideoFeedbackPolicy();
    const observe = () => {
      if (!active() || !sender.headerExtensions?.some(extension => extension.uri === RTP_EXTENSION_URI.transportWideCC)
        || !sender.codec?.rtcpFeedback?.some(feedback => feedback.type === 'transport-cc')) return;
      const result = this.policy.observe({ ...sample(), availableBitrate: Number(sender.senderBWE.availableBitrate),
        congested: sender.senderBWE.congestion === true }, clock.now());
      if (result) onEstimate(result);
    };
    this.subscriptions = [sender.senderBWE.onAvailableBitrate.subscribe(observe), sender.senderBWE.onCongestion.subscribe(observe)];
    this.originalHandler = sender.handleRtcpPacket;
    const negotiated = () => active() && sender.headerExtensions?.some(extension => extension.uri === RTP_EXTENSION_URI.transportWideCC)
      && sender.codec?.rtcpFeedback?.some(feedback => feedback.type === 'transport-cc');
    const consume = packet => {
      if (!negotiated()) return;
      const feedback = packet.feedback;
      if (!Number.isInteger(feedback.fbPktCount) || feedback.fbPktCount < 0 || feedback.fbPktCount > 255
        || !Number.isInteger(feedback.referenceTime) || feedback.referenceTime < 0 || feedback.referenceTime > 0xff_ffff) return;
      const distance = this.lastCount === undefined ? 1 : (feedback.fbPktCount - this.lastCount + 256) & 255;
      if (distance === 0 || distance >= 128) return;
      const previousReference = this.reference ?? feedback.referenceTime;
      const reference = previousReference + ((feedback.referenceTime - (previousReference % 0x100_0000) + 0x180_0000) % 0x100_0000 - 0x80_0000);
      const packetResults = twccPacketResults(feedback, reference);
      if (!packetResults) return;
      this.lastCount = feedback.fbPktCount; this.reference = reference;
      sender.senderBWE.receiveTWCC({ packetResults });
      sender.onRtcp.execute(packet);
    };
    // The installed estimator only expands run-length chunks correctly. Normalize once at
    // this instance boundary, preserving all other feedback and avoiding a second BWE update.
    this.handler = packet => {
      if (packet.type === 205 && packet.feedback?.count === 15) { consume(packet); return; }
      return this.originalHandler.call(sender, packet);
    };
    sender.handleRtcpPacket = this.handler;
    // Transport-wide feedback may legally identify the media source as zero. The library's
    // SSRC router drops that case, so route it through the negotiated sender explicitly.
    if (sender.dtlsTransport?.onRtcp) this.subscriptions.push(sender.dtlsTransport.onRtcp.subscribe(packet => {
      if (packet.type === 205 && packet.feedback?.count === 15 && packet.feedback.mediaSourceSsrc === 0) consume(packet);
    }));
  }
  noteSent() {
    const now = this.clock.now();
    if (now - this.prunedAt < 250) return;
    this.prunedAt = now;
    const infos = this.sender.senderBWE.sentInfos;
    const wallNow = Date.now();
    for (const [sequence, info] of Object.entries(infos)) if (wallNow - info.sentAtMs > 3000) delete infos[sequence];
    const retained = Object.entries(infos);
    if (retained.length > 8192) {
      retained.sort((a, b) => b[1].sentAtMs - a[1].sentAtMs);
      for (const [sequence] of retained.slice(8192)) delete infos[sequence];
    }
  }
  reset() { this.policy.reset(); this.lastCount = undefined; this.reference = undefined; }
  dispose() {
    for (const subscription of this.subscriptions) subscription.unSubscribe();
    if (this.sender.handleRtcpPacket === this.handler) this.sender.handleRtcpPacket = this.originalHandler;
    this.reset();
  }
}
