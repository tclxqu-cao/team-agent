import { describe, expect, it, vi } from 'vitest';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
// @ts-expect-error gateway ESM
import { packetizeH264, WeriftVideoTransport } from './werift-video-transport.mjs';

describe('WeriftVideoTransport', () => {
  it('fragments H264 NALs without dropping bytes and wraps sequence numbers', () => {
    const nal = Buffer.alloc(3500, 42); nal[0] = 0x65;
    const packets = packetizeH264([Buffer.from([0x67, 1, 2]), nal], 123, { sequence: 65535, ssrc: 7 });
    expect(packets.map(packet => packet.header.sequenceNumber)).toEqual([65535, 0, 1, 2]);
    expect(packets.map(packet => packet.header.marker)).toEqual([false, false, false, true]);
    expect(Buffer.concat([Buffer.from([0x65]), ...packets.slice(1).map(packet => packet.payload.subarray(2))])).toEqual(nal);
  });

  it('offers the selected profile and sends RTP after real negotiation', async () => {
    const signals: any[] = [];
    const states: string[] = [];
    const transport = new WeriftVideoTransport({
      signal: data => signals.push(data), iceConfig: { iceServers: [], warning: null }, onState: state => states.push(state),
    });
    const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({
      mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
      parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
    })] } });
    const frames: any[] = [];
    viewer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => frames.push(packet)));
    try {
      await transport.start('baseline');
      const offer = signals.find(signal => signal.kind === 'offer');
      expect(offer.selectedProfile).toBe('baseline');
      await viewer.setRemoteDescription(offer.sdp);
      await viewer.setLocalDescription(await viewer.createAnswer());
      await transport.answer(viewer.localDescription);
      await vi.waitFor(() => expect(states).toContain('connected'), { timeout: 15_000 });
      expect(transport.send({ timestamp: 1, nals: [Buffer.from([0x65, 1, 2, 3])] })).toBe(true);
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      expect(frames[0].payload).toEqual(Buffer.from([0x65, 1, 2, 3]));
    } finally {
      await transport.stop();
      await viewer.close();
    }
  }, 30_000);
});
