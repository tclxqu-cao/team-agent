import { describe, expect, it } from 'vitest';
// @ts-expect-error gateway ESM
import { parseProducerRemoteVideoSignal, parseViewerRemoteVideoSignal } from './remote-video-signal.mjs';

describe('remote video signal boundary', () => {
  it('accepts bounded viewer control, capabilities and receiver stats', () => {
    expect(parseViewerRemoteVideoSignal({ kind: 'start', receiverProfiles: ['high', 'baseline'] })).toMatchObject({ kind: 'start' });
    expect(parseViewerRemoteVideoSignal({ kind: 'answer', sdp: { type: 'answer', sdp: 'v=0' } })).toMatchObject({ kind: 'answer' });
    expect(parseViewerRemoteVideoSignal({
      kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1234 typ host', sdpMid: null, sdpMLineIndex: null, usernameFragment: null },
    })).toMatchObject({ kind: 'ice' });
    expect(parseViewerRemoteVideoSignal({
      kind: 'stats', codec: 'H264', codecProfile: 'high', width: 2560, height: 1440, fps: 30,
      rttMs: 42, lossRate: 0.01, receiveBitrate: 4_000_000, availableBitrate: 6_000_000,
      candidateType: 'relay', protocol: 'udp', decoder: { implementation: 'VideoToolbox', powerEfficient: true, acceleration: 'hardware' },
    })).toMatchObject({ kind: 'stats', codecProfile: 'high' });
  });

  it('rejects malformed and oversized viewer data', () => {
    expect(() => parseViewerRemoteVideoSignal({ kind: 'bogus' })).toThrow('invalid remote video signal');
    expect(() => parseViewerRemoteVideoSignal({ kind: 'quality', quality: '4k' })).toThrow();
    expect(() => parseViewerRemoteVideoSignal({ kind: 'stats', lossRate: 2 })).toThrow();
    expect(() => parseViewerRemoteVideoSignal({ kind: 'start', receiverProfiles: ['main'] })).toThrow();
    expect(() => parseViewerRemoteVideoSignal({ kind: 'answer', sdp: { type: 'answer', sdp: 'x'.repeat(70_000) } })).toThrow('too large');
  });

  it('accepts credentialed TURN offers and rejects transport DTO errors', () => {
    expect(parseProducerRemoteVideoSignal({
      kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, selectedProfile: 'high',
      iceServers: [{ urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' }],
    })).toMatchObject({ kind: 'offer', selectedProfile: 'high' });
    expect(() => parseProducerRemoteVideoSignal({ kind: 'offer', sdp: {}, iceServers: [] })).toThrow();
    expect(() => parseProducerRemoteVideoSignal({ kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, iceServers: [{ urls: 'turn:relay.example:3478' }] })).toThrow();
    expect(() => parseProducerRemoteVideoSignal({ kind: 'ice', candidate: { candidate: 12 } })).toThrow();
  });
});
