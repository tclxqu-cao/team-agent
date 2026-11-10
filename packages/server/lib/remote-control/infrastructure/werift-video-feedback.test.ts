import { describe, expect, it, vi } from 'vitest';
import { RTCRtpSender, RTP_EXTENSION_URI } from 'werift';
// @ts-expect-error gateway ESM
import { WeriftVideoFeedback, twccPacketResults } from './werift-video-feedback.mjs';
vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/remote-video-feedback.js') }));

describe('werift negotiated bandwidth feedback', () => {
  it('expires estimator packet history even when the peer does not return transport feedback', () => {
    const sender: any = new RTCRtpSender('video');
    const adapter = new WeriftVideoFeedback({ sender, clock: { now: () => 0 }, active: () => false,
      sample: vi.fn(), onEstimate: vi.fn() });
    sender.senderBWE.sentInfos = Object.fromEntries(Array.from({ length: 9000 }, (_, sequence) => [sequence, { sentAtMs: Date.now() }]));
    sender.senderBWE.sentInfos[9001] = { sentAtMs: Date.now() - 4000 };
    adapter.noteSent(); expect(Object.keys(sender.senderBWE.sentInfos)).toHaveLength(8192);
    expect(sender.senderBWE.sentInfos[9001]).toBeUndefined(); adapter.dispose();
  });
  it('expands status vectors, successive runs, loss and sequence wrap without reusing the first sequence', () => {
    const feedback = { baseSequenceNumber: 65_534, packetStatusCount: 5, referenceTime: 100,
      packetChunks: [{ packetStatus: 1, runLength: 2 }, { symbolList: [0, 2, 1, 0, 0, 0, 0] }],
      recvDeltas: [{ delta: 1000 }, { delta: 1000 }, { delta: -500 }, { delta: 250 }] };
    const results = twccPacketResults(feedback);
    expect(results.map((result: any) => result.sequenceNumber)).toEqual([65_534, 65_535, 0, 1, 2]);
    expect(results.map((result: any) => result.received)).toEqual([true, true, false, true, true]);
    expect(results[4].receivedAtMs).toBe(6401.75);
    expect(twccPacketResults({ ...feedback, packetStatusCount: 10000 })).toBeNull();
    expect(twccPacketResults({ ...feedback, recvDeltas: [] })).toBeNull();
  });
  it('routes zero-source feedback once, preserves other RTCP and unwraps the reference clock', () => {
    const sender: any = new RTCRtpSender('video');
    sender.codec = { rtcpFeedback: [{ type: 'transport-cc' }] };
    sender.headerExtensions = [{ uri: RTP_EXTENSION_URI.transportWideCC, id: 1 }];
    sender.dtlsTransport = { onRtcp: new sender.onRtcp.constructor() };
    const receive = vi.fn(); sender.senderBWE.receiveTWCC = receive;
    const original = sender.handleRtcpPacket;
    const rtcp = vi.fn(); sender.onRtcp.subscribe(rtcp);
    const adapter = new WeriftVideoFeedback({ sender, clock: { now: () => 0 }, active: () => true,
      sample: () => ({ sentBytes: 0, targetBitRate: 8_000_000, queueDelayMs: 0 }), onEstimate: vi.fn() });
    const packet = { type: 205, feedback: { count: 15, mediaSourceSsrc: 0, fbPktCount: 255,
      baseSequenceNumber: 1, packetStatusCount: 1, referenceTime: 0xff_ffff,
      packetChunks: [{ symbolList: [1] }], recvDeltas: [{ delta: 1000 }] } };
    sender.dtlsTransport.onRtcp.execute(packet); sender.dtlsTransport.onRtcp.execute(packet);
    expect(receive).toHaveBeenCalledTimes(1);
    sender.dtlsTransport.onRtcp.execute({ ...packet, feedback: { ...packet.feedback, fbPktCount: 0, referenceTime: 0 } });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[1][0].packetResults[0].receivedAtMs - receive.mock.calls[0][0].packetResults[0].receivedAtMs).toBe(64);
    sender.handleRtcpPacket({ type: 201, reports: [] });
    expect(rtcp).toHaveBeenCalledTimes(3);
    adapter.dispose(); expect(sender.handleRtcpPacket).toBe(original);
  });
  it('subscribes to the real estimator, qualifies live samples and disposes callbacks', () => {
    const sender: any = new RTCRtpSender('video');
    sender.codec = { rtcpFeedback: [{ type: 'transport-cc' }] };
    sender.headerExtensions = [{ uri: RTP_EXTENSION_URI.transportWideCC, id: 1 }];
    let now = 0, bytes = 0, active = true;
    const onEstimate = vi.fn();
    const adapter = new WeriftVideoFeedback({ sender, clock: { now: () => now }, active: () => active,
      sample: () => ({ sentBytes: bytes, targetBitRate: 8_000_000, queueDelayMs: 0 }), onEstimate });
    sender.senderBWE.availableBitrate = 2_000_000;
    now = 1000; bytes = 1_000_000; sender.senderBWE.congestion = true;
    sender.senderBWE.availableBitrate = 2_000_000;
    expect(onEstimate).toHaveBeenLastCalledWith({ availableOutgoingBitrate: 2_000_000, applicationLimited: false, congested: true });
    now = 2000; bytes += 30_000; sender.senderBWE.availableBitrate = 300_000;
    expect(onEstimate).toHaveBeenLastCalledWith({ availableOutgoingBitrate: 300_000, applicationLimited: true, congested: false });
    active = false; now = 3000; bytes += 1_000_000; sender.senderBWE.availableBitrate = 1_000_000;
    expect(onEstimate).toHaveBeenCalledTimes(2);
    active = true; adapter.dispose(); now = 4000; bytes += 1_000_000; sender.senderBWE.availableBitrate = 1_000_000;
    expect(onEstimate).toHaveBeenCalledTimes(2);
  });
  it('does not present unnegotiated transport feedback as an active estimate', () => {
    const sender: any = new RTCRtpSender('video');
    sender.codec = { rtcpFeedback: [{ type: 'goog-remb' }] }; sender.headerExtensions = [];
    const onEstimate = vi.fn(); let now = 0;
    const adapter = new WeriftVideoFeedback({ sender, clock: { now: () => now }, active: () => true,
      sample: () => ({ sentBytes: now * 1000, targetBitRate: 8_000_000, queueDelayMs: 100 }), onEstimate });
    sender.senderBWE.availableBitrate = 1_000_000; now = 1000; sender.senderBWE.availableBitrate = 1_000_000;
    expect(onEstimate).not.toHaveBeenCalled(); adapter.dispose();
  });
});
