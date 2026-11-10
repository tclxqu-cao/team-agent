import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as liveView from '@agent/core';
import { RTCPeerConnection, MediaStream, RTCRtpCodecParameters, MediaStreamTrack, RtpHeader, RtpPacket, SessionDescription,
  useTransportWideCC, useAbsSendTime } from 'werift';
import { RemoteHoverDispatch } from '../application/remote-hover-dispatch.mjs';
import { PacedVideoSender } from '../application/paced-video-sender.mjs';
import { WeriftVideoRecovery } from './werift-video-recovery.mjs';
import { WeriftVideoFeedback } from './werift-video-feedback.mjs';
import { createCompoundCompressor, compressCompoundPacket } from './compound-compression.mjs';

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
  constructor({ signal, iceConfig, onState = () => undefined, onKeyframe = () => undefined, onFeedback = () => undefined,
    onFrameSent = () => undefined, compound = false, onCompoundMessage = () => undefined, inputStream, inputVersion = 1, onInput = () => 'unavailable', onReliableInput, clock }) {
    this.signal = signal;
    this.iceConfig = iceConfig;
    this.onState = onState;
    this.onKeyframe = onKeyframe;
    this.onFeedback = onFeedback;
    this.onFrameSent = onFrameSent;
    this.compound = compound;
    this.onCompoundMessage = onCompoundMessage;
    this.inputStream = inputStream; this.inputVersion = inputVersion; this.onInput = onInput; this.onReliableInput = onReliableInput;
    this.reportsFrameDelivery = true;
    this.clock = clock ?? {
      now: () => performance.now(),
      schedule: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
      cancel: timer => clearTimeout(timer),
    };
    this.connected = false;
    this.state = { sequence: randomBytes(2).readUInt16BE(), ssrc: randomBytes(4).readUInt32BE() };
    this.bitRate = 8_000_000;
    this.feedbackSequence = 0;
    this.sentBytes = 0;
    this.pacer = this.createPacer();
  }

  createPacer() {
    return new PacedVideoSender({
      policy: new liveView.RemoteVideoPacingPolicy({ bitRate: this.bitRate, now: this.clock.now() }),
      clock: this.clock,
      write: async (packet, frame) => {
        if (!this.connected || !this.sender) throw new Error('Remote video sender disconnected');
        // Reserve only transmitted sequence numbers: discarded queued frames must not trigger NACK gaps.
        packet.header.sequenceNumber = this.state.sequence++ & 65535;
        this.track.header = packet.header;
        this.track.muted = false;
        // track.writeRtp discards this promise. Await the existing sender to bound in-flight UDP work.
        const sender = this.sender;
        const generation = this.pacer.generation;
        await sender.sendRtp(packet);
        if (sender === this.sender && generation === this.pacer.generation) {
          this.sentBytes += packet.serializeSize + 64;
          this.bandwidthFeedback?.noteSent();
          this.recovery?.record(packet, frame);
        }
      },
      writeRepair: async entry => {
        const result = await this.recovery?.write(entry);
        this.bandwidthFeedback?.noteSent(); return result;
      },
      onRepairExpired: entry => this.recovery?.expired(entry),
      onRecovery: () => this.recovery?.reset(),
      onKeyframe: () => this.requestKeyframe(),
      onFrameSent: context => this.onFrameSent(context),
      onError: () => { this.connected = false; this.onState('failed'); },
    });
  }

  async start(profile = 'baseline') {
    await this.stop();
    if (this.compound) this.compressCompound = await createCompoundCompressor().catch(() => null);
    this.pacer = this.createPacer();
    this.profile = profile === 'high' ? 'high' : 'baseline';
    const peer = new RTCPeerConnection({
      codecs: {
        video: [new RTCRtpCodecParameters({
          mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
          parameters: H264_FMTP[this.profile],
          rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }, { type: 'transport-cc' }],
        })],
      },
      headerExtensions: { video: [useTransportWideCC(), useAbsSendTime()] },
      iceAdditionalHostAddresses: Object.values(networkInterfaces()).flat()
        .filter(address => address && !address.internal && address.family === 'IPv4')
        .map(address => address.address),
      iceServers: this.iceConfig.iceServers,
    });
    this.peer = peer;
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
    this.remoteIceCredentials = [];
    if (typeof this.inputStream === 'string') {
      const inputChannel = peer.createDataChannel('agentroam.input.v1', { ordered: false, maxRetransmits: 0 });
      this.inputChannel = inputChannel;
      this.hover = new RemoteHoverDispatch({ clock: this.clock, write: message => {
        if (this.peer === peer && this.connected && this.pacer.running && this.onInput(message) === 'unavailable') inputChannel.close();
      } });
      const hover = this.hover;
      inputChannel.stateChanged.subscribe(state => { if (state === 'closed') hover.cancel(); });
      inputChannel.onMessage.subscribe(raw => {
        if (this.peer !== peer || !this.connected || !this.pacer.running || typeof raw !== 'string' || raw.length > 512) return;
        try {
          const message = JSON.parse(raw);
          if (message?.kind !== 'move' || message.stream !== this.inputStream
            || !Number.isSafeInteger(message.sequence) || !Number.isSafeInteger(message.barrier)
            || ![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return;
          this.hover.offer(message);
        } catch { /* Optional hover input cannot terminate a video session. */ }
      });
    }
    if (this.inputStream && this.inputVersion === 2 && this.onReliableInput) this.createReliableInput(peer);
    if (this.compound) {
      const channel = peer.createDataChannel('agentroam.compound.v1', { ordered: true });
      const cursor = peer.createDataChannel('agentroam.cursor.v1', { ordered: false, maxRetransmits: 0 });
      this.cursorChannel = cursor;
      cursor.stateChanged.subscribe(state => {
        if (state === 'closed' && this.peer === peer) this.onCompoundMessage({ kind: 'cursor-closed' });
      });
      this.compoundChannel = channel;
      channel.stateChanged.subscribe(state => {
        if (state === 'closed' && this.peer === peer) this.onCompoundMessage({ kind: 'unsupported' });
      });
      channel.onMessage.subscribe(input => {
        if (this.peer !== peer || typeof input !== 'string' || input.length > 512) return;
        try {
          const message = JSON.parse(input);
          if (message && ['ready', 'ack', 'unsupported', 'presented', 'pong'].includes(message.kind)) this.onCompoundMessage(message);
        } catch { /* Invalid enhancement feedback cannot affect video playback. */ }
      });
    }
    const track = new MediaStreamTrack({ kind: 'video' });
    this.track = track;
    this.sender = peer.addTrack(track, new MediaStream([track]));
    const sender = this.sender;
    this.bandwidthFeedback = new WeriftVideoFeedback({ sender, clock: this.clock,
      active: () => this.connected && this.pacer.running && this.sender === sender,
      sample: () => ({ sentBytes: this.sentBytes + (this.recovery?.repairedBytes ?? 0),
        targetBitRate: this.bitRate, queueDelayMs: this.pacer.queueDelayMs }),
      onEstimate: sample => {
        this.twccSample = sample; this.lastTwccAt = this.clock.now(); this.feedbackSequence += 1;
        this.onFeedback(this.networkSample());
      },
    });
    this.recovery = new WeriftVideoRecovery({
      sender, history: new liveView.RemoteVideoRecoveryHistory(), pacer: this.pacer, clock: this.clock,
      active: () => this.connected && this.pacer.running && this.sender === sender,
    });
    this.sender.onRtcp.subscribe(packet => {
      this.handleFeedback(packet);
    });
    const localCandidates = [];
    let offerSent = false;
    peer.onIceCandidate.subscribe(candidate => {
      if (!candidate || this.peer !== peer) return;
      const signal = { kind: 'ice', candidate: candidate.toJSON() };
      if (offerSent) this.signal(signal);
      else if (localCandidates.length < 64) localCandidates.push(signal);
    });
    peer.connectionStateChange.subscribe(connection => {
      if (this.peer !== peer) return;
      this.connected = connection === 'connected';
      if (!this.connected) this.pause();
      else this.pacer.resume();
      this.onState(connection);
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (this.peer !== peer) return;
    this.signal({
      kind: 'offer',
      sdp: { type: 'offer', sdp: peer.localDescription.sdp },
      selectedProfile: this.profile,
      ...(this.inputStream ? { inputStream: this.inputStream, inputVersion: this.inputVersion } : {}),
      iceServers: this.iceConfig.iceServers,
      ...(this.iceConfig.warning ? { warning: this.iceConfig.warning } : {}),
    });
    offerSent = true;
    for (const candidate of localCandidates) {
      if (this.peer === peer) this.signal(candidate);
    }
  }

  createReliableInput(peer) {
    const channel = peer.createDataChannel('agentroam.input.reliable.v1', { ordered: true });
    this.reliableInputChannel = channel;
    let pending = 0;
    channel.onMessage.subscribe(raw => {
      if (this.peer !== peer || !this.connected || !this.pacer.running || typeof raw !== 'string' || Buffer.byteLength(raw) > 12_288) return;
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message?.kind !== 'request' || message.stream !== this.inputStream || !Number.isSafeInteger(message.index)
        || message.index < 1 || !Number.isSafeInteger(message.sequence) || message.sequence < 1) return;
      const reply = value => {
        if (this.peer !== peer || channel.readyState !== 'open') return;
        let data = JSON.stringify({ kind: 'result', stream: message.stream, index: message.index, sequence: message.sequence, ...value });
        if (Buffer.byteLength(data) > 32_768) data = JSON.stringify({ kind: 'result', stream: message.stream, index: message.index,
          sequence: message.sequence, ok: false, error: '输入结果超过通道限制', code: 'ETOOBIG' });
        // A congested receipt is reconciled over RPC with the same operation id.
        if (channel.bufferedAmount <= 64_000) { try { channel.send(data); } catch {} }
      };
      if (pending >= 64) { reply({ ok: false, error: '输入队列繁忙', code: 'EBUSY' }); return; }
      this.cancelPendingHover(); pending += 1;
      Promise.resolve().then(() => this.onReliableInput(message)).then(result => reply({ ok: true, result }),
        error => reply({ ok: false, error: String(error?.message ?? error).slice(0, 500), code: String(error?.code ?? 'EINPUT').slice(0, 40) }))
        .finally(() => { pending -= 1; });
    });
  }

  cancelPendingHover() { this.hover?.cancel(); }

  async answer(sdp) {
    const peer = this.peer;
    if (!peer) return;
    const description = SessionDescription.parse(sdp.sdp);
    const receivingVideo = description.media.some(media => media.kind === 'video'
      && media.port !== 0 && !['inactive', 'sendonly'].includes(media.direction)
      && media.rtp.codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264'));
    if (!receivingVideo) throw new Error('Viewer rejected H.264 video');
    // Do not let werift drain unvalidated trickle ICE inside setRemoteDescription:
    // a late candidate from a rejected profile can otherwise reject the new answer.
    await peer.setRemoteDescription(sdp);
    if (this.peer !== peer) return;
    this.remoteIceCredentials = description.media.map(media => ({
      mid: media.rtp.muxId, usernameFragment: media.iceParams?.usernameFragment,
    }));
    this.remoteDescriptionReady = true;
    const pending = this.pendingCandidates; this.pendingCandidates = [];
    for (const candidate of pending) {
      if (this.peer !== peer) return;
      await this.addIceCandidate(candidate);
    }
  }

  handleFeedback(packet, now = this.clock.now()) {
    if (!this.connected) return;
    const report = [200, 201].includes(packet.type) ? packet.reports?.find(report => report.ssrc === this.sender?.ssrc) : null;
    let updated = false;
    if (report) {
      this.lastReportAt = now;
      this.feedbackLossRate = Number.isFinite(report.fractionLost) ? Math.max(0, Math.min(1, report.fractionLost / 256)) : undefined;
      if (report.lsr && report.lsr === this.sender?.lastSRtimestamp && report.dlsr && Number.isFinite(this.sender?.rtt)) {
        this.lastRttAt = now;
        this.recovery?.history.setRtt(this.sender.rtt * 1000);
      }
      updated = true;
    }
    if (packet.type === 206 && packet.feedback?.count === 15) {
      const bitRate = Number(packet.feedback.bitrate);
      if (Number.isFinite(bitRate) && bitRate > 0) {
        this.lastEstimateAt = now;
        this.availableOutgoingBitrate = bitRate;
        updated = true;
      }
    }
    if (updated) {
      this.feedbackSequence += 1;
      this.onFeedback(this.networkSample(now));
    }
    // PSFB also carries REMB (FMT=15): bandwidth reports must never force
    // an IDR. Coalesce repeated PLI/FIR while a lost keyframe is in flight.
    if (!this.connected || packet.type !== 206 || ![1, 4].includes(packet.feedback?.count)) return;
    this.requestKeyframe(now);
  }

  requestKeyframe(now = this.clock.now()) {
    if (this.lastKeyframeRequest !== undefined && now - this.lastKeyframeRequest < 1000) return;
    this.lastKeyframeRequest = now;
    this.onKeyframe();
  }

  async addIceCandidate(candidate) {
    const peer = this.peer;
    if (!peer || !candidate) return;
    if (!this.remoteDescriptionReady) {
      if (this.pendingCandidates.length < 64) this.pendingCandidates.push(candidate);
      return;
    }
    if (typeof candidate.usernameFragment === 'string') {
      const credentials = typeof candidate.sdpMid === 'string'
        ? this.remoteIceCredentials.filter(media => media.mid === candidate.sdpMid)
        : this.remoteIceCredentials.slice(candidate.sdpMLineIndex, candidate.sdpMLineIndex + 1);
      if (!credentials.some(media => media.usernameFragment === candidate.usernameFragment)) return;
    }
    await peer.addIceCandidate(candidate);
  }

  send(frame) {
    if (!this.connected || !this.track) return false;
    const timestamp = Math.round(frame.timestamp * 90000) >>> 0;
    const nals = frame.nals.map(nal => Buffer.isBuffer(nal) ? nal : Buffer.from(nal, 'base64'));
    const packets = packetizeH264(nals, timestamp, { ...this.state, sequence: 0 });
    const keyFrame = nals.some(nal => nal.length > 0 && (nal[0] & 31) === 5);
    return this.pacer.enqueue({
      keyFrame,
      context: { timestamp: frame.timestamp, key: keyFrame, bytes: nals.reduce((sum, nal) => sum + nal.length, 0) },
      // Reserve header-extension, SRTP and network overhead in addition to the RTP bytes.
      packets: packets.map(packet => ({ value: packet, bytes: packet.header.serializeSize + packet.payload.length + 64 })),
    });
  }

  networkSample(now = this.clock.now()) {
    const freshReport = now - (this.lastReportAt ?? -Infinity) <= 3000;
    const freshEstimate = now - (this.lastEstimateAt ?? -Infinity) <= 3000;
    const freshRtt = now - (this.lastRttAt ?? -Infinity) <= 3000;
    const freshTwcc = now - (this.lastTwccAt ?? -Infinity) <= 3000;
    return {
      sequence: this.feedbackSequence,
      lossRate: freshReport ? this.feedbackLossRate : undefined,
      rttMs: freshRtt && Number.isFinite(this.sender?.rtt) ? this.sender.rtt * 1000 : undefined,
      availableOutgoingBitrate: freshEstimate ? this.availableOutgoingBitrate : undefined,
      ...(freshTwcc ? { ...this.twccSample, bandwidthSource: 'twcc' } : {}),
    };
  }

  protectionSample() {
    if (!this.sender) return null;
    return { sentBytes: this.sentBytes, repairedBytes: this.recovery?.repairedBytes ?? 0,
      queuedRepairBytes: this.pacer.queuedRepairBytes ?? 0 };
  }

  async snapshot() {
    if (!this.sender) return null;
    return { ...this.networkSample(), sender: { ...this.pacer.snapshot(), ...this.recovery?.snapshot(), sentBytes: this.sentBytes } };
  }

  canSendCompound(bytes = 0) {
    return this.connected && this.compoundChannel?.readyState === 'open'
      && this.compoundChannel.bufferedAmount + bytes <= 64_000;
  }

  compoundEncodingCost(format, epoch) { return liveView.compoundTileEncodingCost(format, epoch); }

  sendCursor(message) {
    const data = JSON.stringify(message);
    if (!this.connected || this.cursorChannel?.readyState !== 'open' || Buffer.byteLength(data) > 12_000 || this.cursorChannel.bufferedAmount > 16_000) return false;
    try { this.cursorChannel.send(data); return true; } catch { return false; }
  }

  prepareCompound(message, format = 'json-v1') {
    let data = format !== 'json-v1' && message.kind === 'tiles'
      ? liveView.encodeCompoundTiles(message) : JSON.stringify(message);
    if (format === 'binary-zstd-v1' && data instanceof Uint8Array) data = compressCompoundPacket(data, this.compressCompound);
    return { data, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength };
  }

  sendCompound(message) {
    const prepared = typeof message?.bytes === 'number' ? message : this.prepareCompound(message);
    const { data, bytes } = prepared;
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) return false;
    const actualBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes !== actualBytes || bytes > 48_000 || !this.canSendCompound(bytes)) return false;
    try { this.compoundChannel.send(typeof data === 'string' ? data : Buffer.from(data)); return true; } catch { return false; }
  }

  setTuning(decision) {
    if (!Number.isFinite(decision.bitRate) || decision.bitRate <= 0) return;
    this.bitRate = Number.isFinite(decision.pacingBitRate) ? decision.pacingBitRate : decision.bitRate;
    this.pacer.setBitRate(this.bitRate);
    if (Number.isFinite(decision.repairBitRate)) this.pacer.setRepairBitRate(decision.repairBitRate);
  }

  pause() { this.cancelPendingHover(); this.pacer.pause(); this.bandwidthFeedback?.reset(); this.twccSample = undefined; this.lastTwccAt = undefined; }
  resume() { this.pacer.resume(); }

  async stop() {
    this.connected = false;
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
    this.remoteIceCredentials = [];
    this.pacer.stop();
    const bandwidthFeedback = this.bandwidthFeedback; this.bandwidthFeedback = null;
    this.twccSample = undefined; this.lastTwccAt = undefined; this.sentBytes = 0;
    this.hover?.stop(); this.hover = undefined;
    const recovery = this.recovery;
    this.recovery = null;
    this.lastKeyframeRequest = undefined;
    this.lastReportAt = undefined;
    this.lastRttAt = undefined;
    this.lastEstimateAt = undefined;
    this.feedbackLossRate = undefined;
    this.availableOutgoingBitrate = undefined;
    this.feedbackSequence = 0;
    const peer = this.peer;
    this.peer = null;
    this.compoundChannel?.close();
    this.compoundChannel = null;
    this.cursorChannel?.close(); this.cursorChannel = null;
    this.inputChannel?.close(); this.inputChannel = null;
    this.reliableInputChannel?.close(); this.reliableInputChannel = null;
    this.sender = null;
    this.track?.stop();
    this.track = null;
    // Keep NACK interception inactive until the old router/DTLS transport is closed.
    try { if (peer) await peer.close(); } finally { recovery?.dispose(); bandwidthFeedback?.dispose(); }
  }
}
