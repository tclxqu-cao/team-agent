import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RTCPeerConnection, MediaStream, RTCRtpCodecParameters, MediaStreamTrack, RtpHeader, RtpPacket } from 'werift';

export function packetizeH264(nals, timestamp, state) {
  const packets = [];
  for (const nal of nals) {
    if (!nal.length) continue;
    const payloads = [];
    if (nal.length <= 1200) payloads.push(nal);
    else for (let offset = 1; offset < nal.length; offset += 1198) {
      const end = Math.min(offset + 1198, nal.length);
      payloads.push(Buffer.concat([Buffer.from([(nal[0] & 0xe0) | 28, (nal[0] & 31) | (offset === 1 ? 128 : 0) | (end === nal.length ? 64 : 0)]), nal.subarray(offset, end)]));
    }
    for (const payload of payloads) packets.push(new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: state.sequence++ & 65535, timestamp, ssrc: state.ssrc }), payload));
  }
  if (packets.length) packets.at(-1).header.marker = true;
  return packets;
}

export class RemoteWebrtcVideo {
  constructor({ helper, signal }) { this.helper = helper; this.signal = signal; this.generation = 0; this.connected = false; }
  async handle(data) {
    if (data.kind === 'stop') return this.stop();
    if (data.kind === 'start') {
      await this.stop();
      const generation = this.generation;
      const peer = new RTCPeerConnection({ codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96, parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1', rtcpFeedback: [{type:'nack'},{type:'nack',parameter:'pli'}] })] }, iceAdditionalHostAddresses: Object.values(networkInterfaces()).flat().filter(address => address && !address.internal && address.family === 'IPv4').map(address => address.address), iceServers: [{urls:'stun:stun.l.google.com:19302'}] });
      this.peer = peer;
      const track = new MediaStreamTrack({ kind: 'video' });
      this.track = track;
      const sender = peer.addTrack(track, new MediaStream([track]));
      sender.onRtcp.subscribe(packet => { if (packet.type === 206 && this.connected) void this.helper.request({op:'video',enabled:true}).catch(()=>{}); });
      const state = { sequence: randomBytes(2).readUInt16BE(), ssrc: randomBytes(4).readUInt32BE() };
      this.unsubscribe = this.helper.onVideo(frame => {
        if (this.peer !== peer) return;
        if (frame.error) { this.signal({kind:'state',state:'failed'}); void this.stop(); return; }
        if (this.paused || !this.connected) return;
        this.watchFrames(peer);
        const timestamp = Math.round(frame.timestamp * 90000) >>> 0;
        for (const packet of packetizeH264(frame.nals.map(n => Buffer.from(n, 'base64')), timestamp, state)) track.writeRtp(packet);
      });
      peer.onIceCandidate.subscribe(candidate => { if (candidate && this.peer === peer) this.signal({kind:'ice',candidate:candidate.toJSON()}); });
      peer.connectionStateChange.subscribe(connection => {
        if (this.peer !== peer) return;
        this.connected = connection === 'connected';
        this.signal({kind:'state',state:connection});
        if (this.connected) {
          clearTimeout(this.timer);
          this.watchFrames(peer);
          void this.helper.request({op:'video',enabled:true}).catch(()=>{ this.signal({kind:'state',state:'failed'}); return this.stop(); });
        } else if (['failed','closed','disconnected'].includes(connection)) void this.stop();
      });
      this.timer = setTimeout(()=>{ if(this.peer === peer) { this.signal({kind:'state',state:'failed'}); void this.stop(); } },20000);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (this.generation !== generation) return;
      this.signal({kind:'offer',sdp:{type:'offer',sdp:peer.localDescription.sdp}});
    } else if (data.kind === 'answer' && this.peer) await this.peer.setRemoteDescription(data.sdp);
    else if (data.kind === 'ice' && this.peer && data.candidate) await this.peer.addIceCandidate(data.candidate);
  }
  pause() { this.paused = true; clearTimeout(this.frameTimer); }
  async resume() {
    this.paused = false;
    if (this.connected && this.peer) {
      this.watchFrames(this.peer);
      await this.helper.request({op:'video',enabled:true});
    }
  }
  watchFrames(peer) {
    if (this.paused) return;
    clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(async () => {
      if (this.peer !== peer || this.paused) return;
      // ScreenCaptureKit may emit no new complete frames for a static desktop.
      // Probe the helper and request a keyframe instead of dropping a healthy peer.
      try {
        await this.helper.request({op:'video',enabled:true});
        if (this.peer === peer && !this.paused) this.watchFrames(peer);
      } catch {
        if (this.peer === peer) { this.signal({kind:'state',state:'failed'}); await this.stop(); }
      }
    }, 5000);
  }
  async stop() {
    this.generation++; this.paused = false; this.connected = false; clearTimeout(this.timer); clearTimeout(this.frameTimer);
    this.unsubscribe?.(); this.unsubscribe = null;
    const peer = this.peer; this.peer = null; this.track?.stop(); this.track = null;
    if (peer) { await this.helper.request({op:'video',enabled:false}).catch(()=>{}); await peer.close(); }
  }
}
