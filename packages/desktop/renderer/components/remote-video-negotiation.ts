type NegotiationPeer = Pick<RTCPeerConnection, 'setRemoteDescription' | 'createAnswer' | 'setLocalDescription' | 'addIceCandidate' | 'localDescription'>;

/** One offer owns its peer, queued ICE and asynchronous description work. */
export class BrowserRemoteVideoNegotiation {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;
  private stopped = false;
  private credentials: string[] = [];

  constructor(readonly peer: NegotiationPeer, readonly attemptId?: string) {}

  accepts(attemptId: unknown): boolean {
    return !this.stopped && (attemptId === undefined || attemptId === this.attemptId);
  }

  async answer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescription | null> {
    await this.peer.setRemoteDescription(sdp);
    if (this.stopped) return null;
    this.credentials = [...(sdp.sdp ?? '').matchAll(/^a=ice-ufrag:([^\r\n]+)$/gm)].map(match => match[1].trim());
    this.ready = true;
    const pending = this.pending; this.pending = [];
    for (const candidate of pending) await this.addIceCandidate(candidate);
    if (this.stopped) return null;
    const answer = await this.peer.createAnswer();
    if (this.stopped) return null;
    await this.peer.setLocalDescription(answer);
    return this.stopped ? null : this.peer.localDescription;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit, attemptId?: unknown): Promise<void> {
    if (!this.accepts(attemptId)) return;
    if (!this.ready) {
      if (this.pending.length < 64) this.pending.push(candidate);
      return;
    }
    if (candidate.usernameFragment && !this.credentials.includes(candidate.usernameFragment)) return;
    await this.peer.addIceCandidate(candidate);
  }

  stop(): void { this.stopped = true; this.pending = []; }
}
