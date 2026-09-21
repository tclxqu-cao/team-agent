import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RTCPeerConnection, MediaStream, RTCRtpCodecParameters, MediaStreamTrack, RtpHeader, RtpPacket } from 'werift';

const H264_FMTP = Object.freeze({
  high: 'packetization-mode=1;profile-level-id=640034;level-asymmetry-allowed=1',
  baseline: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
});

export function packetizeH264(nals, timestamp, state) {
  const packets = [];
  for (const nal of nals) {
    if (!nal.length) continue;
    const payloads = [];
    if (nal.length <= 1200) payloads.push(nal);
    else for (let offset = 1; offset < nal.length; offset += 1198) {
      const end = Math.min(offset + 1198, nal.length);
      payloads.push(Buffer.concat([
        Buffer.from([(nal[0] & 0xe0) | 28, (nal[0] & 31) | (offset === 1 ? 128 : 0) | (end === nal.length ? 64 : 0)]),
        nal.subarray(offset, end),
      ]));
    }
    for (const payload of payloads) {
      packets.push(new RtpPacket(new RtpHeader({
        payloadType: 96,
        sequenceNumber: state.sequence++ & 65535,
        timestamp,
        ssrc: state.ssrc,
      }), payload));
    }
  }
  if (packets.length) packets.at(-1).header.marker = true;
  return packets;
}

export class WeriftVideoTransport {
  constructor({ signal, iceConfig, onState = () => undefined, onKeyframe = () => undefined }) {
    this.signal = signal;
    this.iceConfig = iceConfig;
    this.onState = onState;
    this.onKeyframe = onKeyframe;
    this.connected = false;
    this.state = { sequence: randomBytes(2).readUInt16BE(), ssrc: randomBytes(4).readUInt32BE() };
  }

  async start(profile = 'baseline') {
    await this.stop();
    this.profile = profile === 'high' ? 'high' : 'baseline';
    const peer = new RTCPeerConnection({
      codecs: {
        video: [new RTCRtpCodecParameters({
          mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
          parameters: H264_FMTP[this.profile],
          rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
        })],
      },
      iceAdditionalHostAddresses: Object.values(networkInterfaces()).flat()
        .filter(address => address && !address.internal && address.family === 'IPv4')
        .map(address => address.address),
      iceServers: this.iceConfig.iceServers,
    });
    this.peer = peer;
    const track = new MediaStreamTrack({ kind: 'video' });
    this.track = track;
    this.sender = peer.addTrack(track, new MediaStream([track]));
    this.sender.onRtcp.subscribe(packet => {
      if (packet.type === 206 && this.connected) this.onKeyframe();
    });
    peer.onIceCandidate.subscribe(candidate => {
      if (candidate && this.peer === peer) this.signal({ kind: 'ice', candidate: candidate.toJSON() });
    });
    peer.connectionStateChange.subscribe(connection => {
      if (this.peer !== peer) return;
      this.connected = connection === 'connected';
      this.onState(connection);
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (this.peer !== peer) return;
    this.signal({
      kind: 'offer',
      sdp: { type: 'offer', sdp: peer.localDescription.sdp },
      selectedProfile: this.profile,
      iceServers: this.iceConfig.iceServers,
      ...(this.iceConfig.warning ? { warning: this.iceConfig.warning } : {}),
    });
  }

  async answer(sdp) {
    if (this.peer) await this.peer.setRemoteDescription(sdp);
  }

  async addIceCandidate(candidate) {
    if (this.peer && candidate) await this.peer.addIceCandidate(candidate);
  }

  send(frame) {
    if (!this.connected || !this.track) return false;
    const timestamp = Math.round(frame.timestamp * 90000) >>> 0;
    const nals = frame.nals.map(nal => Buffer.isBuffer(nal) ? nal : Buffer.from(nal, 'base64'));
    for (const packet of packetizeH264(nals, timestamp, this.state)) this.track.writeRtp(packet);
    return true;
  }

  async snapshot() {
    if (!this.sender) return null;
    const report = await this.sender.getStats();
    const values = typeof report.values === 'function' ? [...report.values()] : [];
    const remote = values.find(item => item.type === 'remote-inbound-rtp');
    const availableOutgoingBitrate = Number(this.sender.receiverEstimatedMaxBitrate);
    const sample = {
      lossRate: Number.isFinite(remote?.fractionLost) ? remote.fractionLost : undefined,
      rttMs: Number.isFinite(remote?.roundTripTime) ? remote.roundTripTime * 1000 : undefined,
      availableOutgoingBitrate: Number.isFinite(availableOutgoingBitrate) && availableOutgoingBitrate > 0 ? availableOutgoingBitrate : undefined,
    };
    return Object.values(sample).some(Number.isFinite) ? sample : null;
  }

  async stop() {
    this.connected = false;
    const peer = this.peer;
    this.peer = null;
    this.sender = null;
    this.track?.stop();
    this.track = null;
    if (peer) await peer.close();
  }
}
