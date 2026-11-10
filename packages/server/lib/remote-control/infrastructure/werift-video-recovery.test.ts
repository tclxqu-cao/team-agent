import { afterEach, describe, expect, it, vi } from 'vitest';
import { RTCRtpSender, RtpPacket, RtpHeader, GenericNack, RtcpTransportLayerFeedback,
  RTP_EXTENSION_URI, serializeTransportWideCC } from 'werift';
import { RemoteVideoRecoveryHistory } from '../../../../core/src/domain/live-view/remote-video-recovery.js';
import { RemoteVideoPacingPolicy } from '../../../../core/src/domain/live-view/remote-video-pacing.js';
// @ts-expect-error gateway ESM
import { PacedVideoSender } from '../application/paced-video-sender.mjs';
// @ts-expect-error gateway ESM
import { WeriftVideoRecovery } from './werift-video-recovery.mjs';

function fixture(bitRate = 8_000_000) {
  const sender: any = new RTCRtpSender('video');
  sender.codec = { mimeType: 'video/H264', clockRate: 90_000, payloadType: 96 };
  const writes: any[] = [];
  sender.dtlsTransport = { state: 'connected', transportSequenceNumber: 0, sendRtp: vi.fn(async (payload: Buffer, header: RtpHeader) => {
    writes.push({ payload: Buffer.from(payload), header: new RtpHeader({ ...header }), at: Date.now() });
    return payload.length + header.serializeSize;
  }) };
  sender.runRtcp = vi.fn(); sender.senderBWE.rtpPacketSent = vi.fn();
  const original = sender.handleRtcpPacket;
  const clock = { now: () => Date.now(), schedule: setTimeout, cancel: clearTimeout };
  const history = new RemoteVideoRecoveryHistory<RtpPacket>();
  const onKeyframe = vi.fn(), onError = vi.fn();
  let recovery: any;
  const pacer = new PacedVideoSender({ policy: new RemoteVideoPacingPolicy({ bitRate }), clock,
    write: async (packet: RtpPacket, frame: any) => { await sender.sendRtp(packet); recovery.record(packet, frame); },
    writeRepair: (entry: any) => recovery.write(entry), onRepairExpired: (entry: any) => recovery.expired(entry),
    onRecovery: () => history.reset(), onKeyframe, onError });
  recovery = new WeriftVideoRecovery({ sender, history, pacer, clock, active: () => pacer.running });
  const primary = async (sequence: number, keyFrameStart = sequence === 0, frameDeadline = Date.now() + 1_000) => {
    const packet = new RtpPacket(new RtpHeader({ sequenceNumber: sequence, timestamp: 90_000, marker: sequence === 255,
      ssrc: sender.ssrc, payloadType: 96 }), Buffer.alloc(1_200, sequence & 255));
    await sender.sendRtp(packet);
    recovery.record(packet, { keyFrameStart, frameDeadline });
    return packet;
  };
  const nack = (lost: number[], mediaSourceSsrc = sender.ssrc) => sender.handleRtcpPacket(new RtcpTransportLayerFeedback({
    feedback: new GenericNack({ senderSsrc: 2, mediaSourceSsrc, lost }),
  }));
  return { sender, history, pacer, recovery, writes, primary, nack, onKeyframe, onError, original };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('WeriftVideoRecovery with a real werift sender', () => {
  it('recovers both ends of the original 256-packet replay without the built-in 128-packet limitation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let sequence = 0; sequence < 256; sequence++) await f.primary(sequence);
    f.writes.length = 0;
    const nackEvent = vi.fn(), rtcpEvent = vi.fn();
    f.sender.onGenericNack.subscribe(nackEvent); f.sender.onRtcp.subscribe(rtcpEvent);
    f.nack([0, 255]);
    expect(f.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(f.writes.map(write => write.header.sequenceNumber)).toEqual([0, 255]);
    expect(f.writes[0].payload).toEqual(Buffer.alloc(1_200));
    expect(f.writes[1].header).toMatchObject({ timestamp: 90_000, marker: true, ssrc: f.sender.ssrc });
    expect(f.recovery.snapshot()).toMatchObject({ historyPackets: 256, repairedPackets: 2 });
    expect(f.sender.retransmittedPacketsSent).toBe(2);
    expect(f.sender.senderBWE.rtpPacketSent).toHaveBeenCalledTimes(258);
    expect(nackEvent).toHaveBeenCalledTimes(1); expect(rtcpEvent).toHaveBeenCalledTimes(1);
    f.pacer.stop(); f.recovery.dispose();
    expect(f.sender.handleRtcpPacket).toBe(f.original);
  });

  it('serializes a 32-packet burst with primary traffic and deduplicates repeated NACKs', async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let sequence = 0; sequence < 256; sequence++) await f.primary(sequence);
    f.writes.length = 0;
    let inFlight = 0, maxInFlight = 0;
    const original = f.sender.dtlsTransport.sendRtp;
    f.sender.dtlsTransport.sendRtp = async (...args: any[]) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      await original(...args); inFlight--;
    };
    const lost = Array.from({ length: 32 }, (_, index) => 224 + index);
    f.nack(lost); f.nack(lost);
    f.pacer.policy.acceptFrame(true);
    f.pacer.enqueue({ keyFrame: false, packets: [{ value: new RtpPacket(new RtpHeader({ sequenceNumber: 256 }), Buffer.from([0x41])), bytes: 80 }] });
    await vi.advanceTimersByTimeAsync(400);
    expect(maxInFlight).toBe(1);
    expect(f.writes.filter(write => write.header.sequenceNumber < 256)).toHaveLength(32);
    expect(f.writes.some(write => write.header.sequenceNumber === 256)).toBe(true);
    const repairTimes = f.writes.filter(write => write.header.sequenceNumber < 256).map(write => write.at);
    expect(repairTimes.at(-1)! - repairTimes[0]).toBeGreaterThan(100);
    expect(f.onError).not.toHaveBeenCalled();
    f.pacer.stop(); f.recovery.dispose();
  });

  it('abandons expired repairs and coalesces keyframe recovery until a new IDR arrives', async () => {
    vi.useFakeTimers();
    const f = fixture(100_000);
    f.history.setRtt(50);
    for (let sequence = 0; sequence < 8; sequence++) await f.primary(sequence, sequence === 0, Date.now() + 10);
    f.writes.length = 0;
    f.nack([0, 1, 2, 3, 4, 5, 6, 7]);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.writes).toHaveLength(1);
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
    f.nack([0, 1]); f.nack([0]);
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
    expect(f.pacer.snapshot()).toMatchObject({ queuedRepairs: 0, waitingForKeyframe: true });
    await f.primary(8, true);
    f.nack([0]);
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
    f.pacer.stop(); f.recovery.dispose();
  });

  it('preserves wire offsets and refreshes transport sequence extensions without mutating history', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sender.seqOffset = 7; f.sender.timestampOffset = 900;
    f.sender.headerExtensions = [{ id: 3, uri: RTP_EXTENSION_URI.transportWideCC }, { id: 4, uri: RTP_EXTENSION_URI.absSendTime }];
    const packet = await f.primary(0);
    const originalExtension = Buffer.from(packet.header.extensions[0].payload);
    const originalSendTime = Buffer.from(packet.header.extensions[1].payload);
    await vi.advanceTimersByTimeAsync(20);
    f.writes.length = 0; f.nack([7]);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.writes[0].header).toMatchObject({ sequenceNumber: 7, timestamp: 90_900 });
    expect(f.writes[0].header.extensions[0].payload).toEqual(serializeTransportWideCC(2));
    expect(packet.header.extensions[0].payload).toEqual(originalExtension);
    expect(f.writes[0].header.extensions[1].payload).not.toEqual(originalSendTime);
    expect(packet.header.extensions[1].payload).toEqual(originalSendTime);
    f.pacer.stop(); f.recovery.dispose();
  });

  it('uses negotiated RTX wrapping and suppresses invalid, other-stream and paused requests', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.primary(0); f.writes.length = 0;
    f.sender.rtxPayloadType = 97; f.sender.rtxSequenceNumber = 65_535;
    f.nack([0], f.sender.ssrc + 1); f.nack([65_535]);
    await vi.advanceTimersByTimeAsync(5); expect(f.writes).toHaveLength(0);
    f.nack([0]); await vi.advanceTimersByTimeAsync(10);
    expect(f.writes[0].header).toMatchObject({ payloadType: 97, ssrc: f.sender.rtxSsrc, sequenceNumber: 65_535 });
    expect(f.writes[0].payload.readUInt16BE(0)).toBe(0);
    expect(f.sender.rtxSequenceNumber).toBe(0);
    f.pacer.pause(); f.nack([0]); await vi.advanceTimersByTimeAsync(500);
    expect(f.writes).toHaveLength(1);
    expect(f.recovery.snapshot().historyBytes).toBe(0);
    f.recovery.dispose();
  });
});
