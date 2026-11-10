import { describe, expect, it, vi } from 'vitest';
import { BrowserRemoteVideoNegotiation } from './remote-video-negotiation';

function fixture(attemptId = 'baseline-2') {
  const answer = { type: 'answer', sdp: 'v=0', toJSON: () => ({ type: 'answer', sdp: 'v=0' }) } as RTCSessionDescription;
  const peer = { setRemoteDescription: vi.fn(async () => undefined), createAnswer: vi.fn(async () => answer),
    setLocalDescription: vi.fn(async () => undefined), addIceCandidate: vi.fn(async () => undefined), localDescription: answer };
  return { peer, negotiation: new BrowserRemoteVideoNegotiation(peer, attemptId), answer };
}

describe('BrowserRemoteVideoNegotiation', () => {
  it('queues early ICE and ignores retired attempt ids and credentials', async () => {
    const { peer, negotiation } = fixture();
    const candidate = { candidate: 'candidate:1', sdpMid: '0', usernameFragment: 'baseline' };
    await negotiation.addIceCandidate(candidate, 'high-1');
    await negotiation.addIceCandidate({ ...candidate, usernameFragment: 'high' });
    await negotiation.addIceCandidate(candidate, 'baseline-2');
    expect(peer.addIceCandidate).not.toHaveBeenCalled();
    await negotiation.answer({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:baseline\r\n' });
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(peer.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  it('does not answer or flush queued work after replacement during setRemoteDescription', async () => {
    const { peer, negotiation } = fixture();
    let finish!: () => void;
    peer.setRemoteDescription.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const answer = negotiation.answer({ type: 'offer', sdp: 'v=0' });
    await negotiation.addIceCandidate({ candidate: 'candidate:1' });
    negotiation.stop(); finish();
    expect(await answer).toBeNull();
    expect(peer.addIceCandidate).not.toHaveBeenCalled();
    expect(peer.createAnswer).not.toHaveBeenCalled();
    expect(negotiation.accepts('baseline-2')).toBe(false);
  });

  it('bounds candidate buffering and retains compatibility with untagged producers', async () => {
    const { peer, negotiation } = fixture();
    for (let index = 0; index < 100; index += 1) await negotiation.addIceCandidate({ candidate: `candidate:${index}` });
    await negotiation.answer({ type: 'offer', sdp: 'v=0' });
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(64);
  });
});
