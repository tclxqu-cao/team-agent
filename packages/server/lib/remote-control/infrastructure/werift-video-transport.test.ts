import { describe, expect, it, vi } from 'vitest';
import { RTCPeerConnection, RTCRtpCodecParameters, GenericNack, RtcpTransportLayerFeedback,
  useTransportWideCC, useAbsSendTime, RTP_EXTENSION_URI } from 'werift';
import { LiveViewRegistry } from '../../../../core/src/domain/live-view/live-view-registry.js';
import { decodeCompoundTiles } from '../../../../core/src/infrastructure/live-view/compound-video-wire.js';
// @ts-expect-error gateway ESM
import { packetizeH264, WeriftVideoTransport } from './werift-video-transport.mjs';

vi.mock('@agent/core', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js'),
  ...await import('../../../../core/src/domain/live-view/remote-video-pacing.js'),
  ...await import('../../../../core/src/infrastructure/live-view/compound-video-wire.js'),
}));

describe('WeriftVideoTransport', () => {
  it('ignores ICE from a rejected High peer arriving before the Baseline answer', async () => {
    const signals: any[] = [];
    const transport = new WeriftVideoTransport({ signal: (data: any) => signals.push(data), iceConfig: { iceServers: [] } });
    const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({
      mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
      parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
    })] } });
    try {
      await transport.start('baseline');
      const offer = signals.find(signal => signal.kind === 'offer');
      await viewer.setRemoteDescription(offer.sdp);
      await viewer.setLocalDescription(await viewer.createAnswer());
      // Safari can finish gathering for the rejected peer after fallback starts.
      await transport.addIceCandidate({ candidate: 'candidate:1 1 udp 2113937151 127.0.0.1 45678 typ host',
        sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'retired-high-peer' });
      await expect(transport.answer(viewer.localDescription)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 15000 });
      expect(signals.findIndex(signal => signal.kind === 'offer')).toBe(0);
    } finally { await transport.stop(); await viewer.close(); }
  }, 20000);

  it('negotiates TWCC and direct hover over real encrypted local transports and revokes the old controller', async () => {
    const registry = new LiveViewRegistry();
    const messages: any[] = [], signals: any[] = [], feedback: any[] = [], frames: any[] = [], twcc: any[] = [], emitted: any[] = [], incoming: any[] = [];
    const producer = { id: 'producer', userId: 'owner', producerSessionIds: new Set<string>(), watchedSessionId: null, send: (event: any) => messages.push(event) };
    const controller = { id: 'controller', userId: 'owner', producerSessionIds: new Set<string>(), watchedSessionId: null, send: vi.fn() };
    registry.publish(producer, { sessionId: 'desktop', backend: 'desktop', availability: 'ready' });
    registry.takeOver(controller, 'desktop'); registry.producerState(producer, 'desktop', 'user-controlled');
    const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890' };
    registry.enableDirectInput(producer, 'desktop', context);
    const transport = new WeriftVideoTransport({ signal: (data: any) => signals.push(data), iceConfig: { iceServers: [] },
      inputStream: context.stream, onFeedback: (sample: any) => feedback.push(sample), onInput: (message: any) => {
        if (!registry.isDirectInputActive(producer, 'desktop', context)) return 'unavailable';
        return registry.directPointerInput(producer, 'desktop', context, message) ? 'accepted' : 'ignored';
      } });
    const viewer = new RTCPeerConnection({ iceServers: [], headerExtensions: { video: [useTransportWideCC(), useAbsSendTime()] },
      codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90_000, payloadType: 96,
        parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
        rtcpFeedback: [{ type: 'nack' }, { type: 'transport-cc' }],
      })] } });
    let input: any;
    viewer.onDataChannel.subscribe(channel => { if (channel.label === 'agentroam.input.v1') input = channel; });
    viewer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => frames.push(packet)));
    try {
      await transport.start();
      const offer = signals.find(signal => signal.kind === 'offer');
      expect(offer.sdp.sdp).toContain('transport-cc');
      expect(offer.sdp.sdp).toContain(RTP_EXTENSION_URI.transportWideCC);
      expect(offer.inputStream).toBe(context.stream);
      await viewer.setRemoteDescription(offer.sdp); await viewer.setLocalDescription(await viewer.createAnswer());
      await transport.answer(viewer.localDescription);
      await vi.waitFor(() => expect(input?.readyState).toBe('open'), { timeout: 15_000 });
      transport.sender.onRtcp.subscribe((packet: any) => { if (packet.type === 205 && packet.feedback?.count === 15) twcc.push(packet); });
      transport.sender.dtlsTransport.onRtcp.subscribe((packet: any) => incoming.push({ type: packet.type, count: packet.feedback?.count, media: packet.feedback?.mediaSourceSsrc }));
      const rx = viewer.getReceivers()[0] as any;
      const sendRtcp = rx.dtlsTransport.sendRtcp.bind(rx.dtlsTransport);
      rx.dtlsTransport.sendRtcp = (packets: any[]) => {
        // werift's test receiver omits TWCC word alignment. A browser emits aligned RTCP;
        // enable standard RTCP padding only where this synthetic receiver needs it.
        for (const packet of packets) if (packet.type === 205 && packet.feedback?.count === 15) {
          if (packet.serialize().length % 4) packet.feedback.header.padding = true;
          // Browser-style transport feedback can use SSRC zero instead of a media SSRC.
          packet.feedback.mediaSourceSsrc = 0;
        }
        emitted.push(...packets.map(packet => ({ type: packet.type, count: packet.feedback?.count, media: packet.feedback?.mediaSourceSsrc })));
        return sendRtcp(packets);
      };
      const move = { kind: 'move', stream: context.stream, sequence: 1, barrier: 0, x: .25, y: .5 };
      input.send(JSON.stringify(move));
      await vi.waitFor(() => expect(messages.filter(message => message.directMove)).toHaveLength(1));
      input.send(JSON.stringify({ ...move, kind: 'key', sequence: 2 }));
      const nal = Buffer.alloc(40_000, 42); nal[0] = 0x65;
      for (let index = 0; index < 8; index++) {
        expect(transport.send({ timestamp: index + 1, nals: [nal] })).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 130));
      }
      await vi.waitFor(() => expect(twcc.length, JSON.stringify({ codec: transport.sender.codec,
        extensions: transport.sender.headerExtensions, receiverTwcc: (viewer.getReceivers()[0] as any).twccEnabled,
        received: frames.length, firstHeader: frames[0]?.header.extensions, emitted, incoming,
        receiverInfo: rx.receiverTWCC?.extensionInfo, extMap: (viewer as any).router.extIdUriMap },
      (_key, value) => typeof value === 'bigint' ? String(value) : value)).toBeGreaterThan(0), { timeout: 2_000 });
      expect(frames.some(packet => packet.header.extensions.some((extension: any) => extension.payload.length === 2))).toBe(true);
      await vi.waitFor(() => expect(feedback.some(sample => sample.bandwidthSource === 'twcc')).toBe(true), { timeout: 2_000 });
      expect(messages.filter(message => message.directMove)).toHaveLength(1);
      registry.returnControl(controller, 'desktop');
      input.send(JSON.stringify({ ...move, sequence: 3 }));
      await vi.waitFor(() => expect(input.readyState).toBe('closed'), { timeout: 2_000 });
      expect(messages.filter(message => message.directMove)).toHaveLength(1);
    } finally { await transport.stop(); await viewer.close(); }
  }, 30_000);

  it('continues normal RTP when the answer declines transport-cc extensions and feedback', async () => {
    const signals: any[] = [], frames: any[] = [];
    const transport = new WeriftVideoTransport({ signal: (data: any) => signals.push(data), iceConfig: { iceServers: [] } });
    const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({
      mimeType: 'video/H264', clockRate: 90_000, payloadType: 96,
      parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
    })] } });
    viewer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => frames.push(packet)));
    try {
      await transport.start(); await viewer.setRemoteDescription(signals.find(signal => signal.kind === 'offer').sdp);
      await viewer.setLocalDescription(await viewer.createAnswer());
      const answer = viewer.localDescription;
      await transport.answer({ type: 'answer', sdp: answer.sdp.split('\r\n')
        .filter(line => !line.includes('transport-cc') && !line.includes(RTP_EXTENSION_URI.transportWideCC)).join('\r\n') });
      await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 15_000 });
      expect(transport.sender.headerExtensions.some((extension: any) => extension.uri === RTP_EXTENSION_URI.transportWideCC)).toBe(false);
      expect(transport.send({ timestamp: 1, nals: [Buffer.from([0x65, 1])] })).toBe(true);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect((await transport.snapshot()).bandwidthSource).toBeUndefined();
    } finally { await transport.stop(); await viewer.close(); }
  }, 30_000);
  it('normalizes only matching fresh RTCP reports and expires feedback across stop', async () => {
    let now = 0;
    const feedback = vi.fn();
    const transport = new WeriftVideoTransport({
      signal: vi.fn(), iceConfig: { iceServers: [] }, onFeedback: feedback,
      clock: { now: () => now, schedule: setTimeout, cancel: clearTimeout },
    });
    transport.connected = true;
    transport.sender = { ssrc: 7, rtt: 0.3, lastSRtimestamp: 1 };
    transport.handleFeedback({ type: 201, reports: [{ ssrc: 99, fractionLost: 255 }] });
    expect(feedback).not.toHaveBeenCalled();
    transport.handleFeedback({ type: 201, reports: [{ ssrc: 7, fractionLost: 64, lsr: 1, dlsr: 1 }] });
    transport.handleFeedback({ type: 206, feedback: { count: 15, bitrate: 1_500_000n } });
    expect(feedback).toHaveBeenLastCalledWith({ sequence: 2, lossRate: 0.25, rttMs: 300, availableOutgoingBitrate: 1_500_000 });
    now = 3_001;
    expect(await transport.snapshot()).toMatchObject({ sequence: 2, lossRate: undefined, rttMs: undefined, availableOutgoingBitrate: undefined });
    await transport.stop();
    expect(transport.networkSample()).toEqual({ sequence: 0, lossRate: undefined, rttMs: undefined, availableOutgoingBitrate: undefined });
  });

  it('allocates contiguous sequence numbers only for paced packets after dropping queued frames', async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    const transport = new WeriftVideoTransport({
      signal: vi.fn(), iceConfig: { iceServers: [] },
      clock: { now: () => Date.now(), schedule: setTimeout, cancel: clearTimeout },
    });
    transport.connected = true;
    transport.track = { stop: vi.fn() };
    transport.sender = { sendRtp: async (packet: any) => sent.push({
      sequence: packet.header.sequenceNumber, timestamp: packet.header.timestamp, marker: packet.header.marker,
    }) };
    transport.state.sequence = 65_534;
    transport.setTuning({ bitRate: 800_000 });
    const key = Buffer.alloc(12_000, 42); key[0] = 0x65;
    try {
      expect(transport.send({ timestamp: 1, nals: [key] })).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      for (let index = 0; index < 15; index += 1) transport.send({ timestamp: 1.5, nals: [Buffer.from([0x41, index])] });
      transport.send({ timestamp: 2, nals: [Buffer.from([0x65, 9])] });
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.length).toBeGreaterThan(2);
      expect(sent.map((packet, index) => packet.sequence === ((65_534 + index) & 65535))).not.toContain(false);
      expect(sent.some(packet => packet.timestamp === 135_000)).toBe(false);
      expect(sent.at(-1)).toMatchObject({ timestamp: 180_000, marker: true });
      transport.pause();
      expect(transport.send({ timestamp: 3, nals: [Buffer.from([0x65])] })).toBe(false);
    } finally { await transport.stop(); vi.useRealTimers(); }
  });

  it.each([
    ['video', 0, 'recvonly'],
    ['video', 9, 'inactive'],
    ['video', 9, 'sendonly'],
    ['audio', 9, 'recvonly'],
  ])('rejects a %s answer on port %s with direction %s before waiting for ICE', async (kind, port, direction) => {
    const transport = new WeriftVideoTransport({ signal: vi.fn(), iceConfig: { iceServers: [] } });
    const setRemoteDescription = vi.fn();
    transport.peer = { setRemoteDescription } as any;
    const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
      `m=${kind} ${port} UDP/TLS/RTP/SAVPF 96`, 'a=rtpmap:96 H264/90000', `a=${direction}`, ''].join('\r\n');
    await expect(transport.answer({ type: 'answer', sdp })).rejects.toThrow('Viewer rejected H.264 video');
    expect(setRemoteDescription).not.toHaveBeenCalled();
  });

  it('ignores bandwidth feedback and coalesces PLI/FIR keyframe requests', () => {
    const onKeyframe = vi.fn();
    const transport = new WeriftVideoTransport({ signal: vi.fn(), iceConfig: { iceServers: [] }, onKeyframe });
    transport.connected = true;
    for (let now = 0; now < 3000; now += 50) transport.handleFeedback({ type: 206, feedback: { count: 15 } }, now);
    expect(onKeyframe).not.toHaveBeenCalled();
    transport.handleFeedback({ type: 206, feedback: { count: 1 } }, 3000);
    transport.handleFeedback({ type: 206, feedback: { count: 4 } }, 3100);
    transport.handleFeedback({ type: 205, feedback: { count: 1 } }, 4100);
    expect(onKeyframe).toHaveBeenCalledTimes(1);
    transport.handleFeedback({ type: 206, feedback: { count: 4 } }, 4200);
    expect(onKeyframe).toHaveBeenCalledTimes(2);
    transport.connected = false;
    transport.handleFeedback({ type: 206, feedback: { count: 1 } }, 6000);
    expect(onKeyframe).toHaveBeenCalledTimes(2);
  });
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
    const arrivals: number[] = [];
    viewer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => { frames.push(packet); arrivals.push(performance.now()); }));
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
      expect(frames[0].header.timestamp).toBe(90_000);
      frames.length = 0; arrivals.length = 0;
      transport.setTuning({ bitRate: 800_000 });
      const nal = Buffer.alloc(40_000, 42); nal[0] = 0x65;
      expect(transport.send({ timestamp: 2, nals: [nal] })).toBe(true);
      const count = Math.ceil((nal.length - 1) / 1198);
      await vi.waitFor(() => expect(frames).toHaveLength(count), { timeout: 5_000 });
      expect(Buffer.concat([Buffer.from([0x65]), ...frames.map(packet => packet.payload.subarray(2))])).toEqual(nal);
      expect(frames.slice(0, -1).every(packet => !packet.header.marker)).toBe(true);
      expect(frames.at(-1).header.marker).toBe(true);
      expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThan(150);
      const sequences = frames.map(packet => packet.header.sequenceNumber);
      expect(sequences.every((value, index) => value === ((sequences[0] + index) & 65535))).toBe(true);
    } finally {
      await transport.stop();
      await viewer.close();
    }
  }, 30_000);

  it('recovers a deliberately lost early fragment after more than 128 packets over negotiated local UDP', async () => {
    const signals: any[] = [], frames: any[] = [];
    const onKeyframe = vi.fn();
    const transport = new WeriftVideoTransport({ signal: (data: any) => signals.push(data),
      iceConfig: { iceServers: [] }, onKeyframe });
    const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({
      mimeType: 'video/H264', clockRate: 90_000, payloadType: 96,
      parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1', rtcpFeedback: [],
    })] } });
    viewer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => frames.push(packet)));
    try {
      await transport.start();
      await viewer.setRemoteDescription(signals.find(signal => signal.kind === 'offer').sdp);
      await viewer.setLocalDescription(await viewer.createAnswer());
      await transport.answer(viewer.localDescription);
      await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 15_000 });
      const receiver: any = viewer.getReceivers()[0];
      const sendRtcp = receiver.dtlsTransport.sendRtcp.bind(receiver.dtlsTransport);
      // Defer automatic NACK feedback until the complete frame has crossed the wire.
      // Other RTCP continues normally; the explicit request below uses real SRTCP/UDP.
      receiver.dtlsTransport.sendRtcp = async (packets: any[]) => {
        const other = packets.filter(packet => packet.type !== 205 || packet.feedback?.count !== 1);
        if (other.length) await sendRtcp(other);
      };
      const dtls = transport.sender.dtlsTransport;
      const sendRtp = dtls.sendRtp.bind(dtls);
      let dropped: any;
      dtls.sendRtp = async (payload: Buffer, header: any) => {
        if (!dropped) {
          dropped = { sequence: header.sequenceNumber, timestamp: header.timestamp, ssrc: header.ssrc };
          return payload.length + header.serializeSize;
        }
        return sendRtp(payload, header);
      };
      transport.setTuning({ bitRate: 20_000_000 });
      const nal = Buffer.alloc(256 * 1_198 + 1, 42); nal[0] = 0x65;
      expect(transport.send({ timestamp: 2, nals: [nal] })).toBe(true);
      await vi.waitFor(() => expect(frames).toHaveLength(255), { timeout: 5_000, interval: 10 });
      expect(transport.recovery.snapshot().historyPackets).toBe(256);
      await sendRtcp([new RtcpTransportLayerFeedback({ feedback: new GenericNack({
        senderSsrc: receiver.rtcpSsrc, mediaSourceSsrc: dropped.ssrc, lost: [dropped.sequence],
      }) })]);
      await vi.waitFor(() => expect(frames).toHaveLength(256), { timeout: 2_000, interval: 10 });
      const sorted = [...frames].sort((a, b) => ((a.header.sequenceNumber - dropped.sequence + 65_536) & 65_535)
        - ((b.header.sequenceNumber - dropped.sequence + 65_536) & 65_535));
      expect(Buffer.concat([Buffer.from([0x65]), ...sorted.map(packet => packet.payload.subarray(2))])).toEqual(nal);
      expect(sorted[0].header).toMatchObject({ sequenceNumber: dropped.sequence, timestamp: dropped.timestamp, marker: false });
      expect(sorted.at(-1).header.marker).toBe(true);
      expect(transport.recovery.snapshot().repairedPackets).toBe(1);
      expect(onKeyframe).not.toHaveBeenCalled();
    } finally { await transport.stop(); await viewer.close(); }
  }, 30_000);
});


it('negotiates compound data alongside H264 without routing image bytes through signalling', async () => {
  const signals: any[] = [], received: any[] = [], feedback: any[] = [];
  const transport = new WeriftVideoTransport({ compound: true, signal: (data: any) => signals.push(data),
    iceConfig: { iceServers: [] }, onCompoundMessage: (message: any) => feedback.push(message) });
  const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({
    mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
    parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1',
  })] } });
  let channel: any;
  viewer.onDataChannel.subscribe((next: any) => { if (next.label !== 'agentroam.compound.v1') return; channel = next; next.onMessage.subscribe((message: any) => received.push(typeof message === 'string' ? JSON.parse(message) : decodeCompoundTiles(message))); });
  try {
    await transport.start('baseline');
    await viewer.setRemoteDescription(signals.find(signal => signal.kind === 'offer').sdp);
    await viewer.setLocalDescription(await viewer.createAnswer());
    await transport.answer(viewer.localDescription);
    await vi.waitFor(() => expect(channel?.readyState).toBe('open'), { timeout: 15_000 });
    channel.send(JSON.stringify({ kind: 'ready', version: 1, formats: ['binary-v1', 'json-v1'] }));
    await vi.waitFor(() => expect(feedback).toContainEqual({ kind: 'ready', version: 1, formats: ['binary-v1', 'json-v1'] }));
    expect(transport.sendCompound({ version: 1, kind: 'reset', epoch: 'one', revision: 0, width: 128, height: 64 })).toBe(true);
    await vi.waitFor(() => expect(received[0]).toMatchObject({ kind: 'reset', epoch: 'one' }));
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
    const prepared = transport.prepareCompound({ version: 1, kind: 'tiles', epoch: 'one', revision: 0, sequence: 1, rtpTimestamp: 90_000,
      tiles: [{ cacheId: 1, x: 0, y: 0, width: 64, height: 64, data: png.toString('base64') }, { cacheId: 1, x: 64, y: 0, width: 64, height: 64 }] }, 'binary-v1');
    expect(prepared.bytes).toBe(77);
    expect(transport.sendCompound(prepared)).toBe(true);
    await vi.waitFor(() => expect(received[1]).toMatchObject({ kind: 'tiles', tiles: [{ cacheId: 1, data: expect.any(Uint8Array) }, { cacheId: 1 }] }));
    const json = transport.prepareCompound({ kind: 'reset', epoch: '中' });
    expect(json.bytes).toBe(Buffer.byteLength(json.data));
    expect(json.bytes).toBeGreaterThan(json.data.length);
    expect(signals.every(signal => !['tiles', 'reset'].includes(signal.kind))).toBe(true);
    transport.compoundChannel.bufferedAmount = 64_000;
    expect(transport.sendCompound({ kind: 'frame' })).toBe(false);
  } finally { await transport.stop(); await viewer.close(); }
}, 25_000);

it('reconciles real reliable SCTP with reordered RPC fallback without repeating native text', async () => {
  const registry = new LiveViewRegistry(); const messages: any[] = [], signals: any[] = [], replies: any[] = [];
  const producer = { id: 'producer', userId: 'owner', producerSessionIds: new Set<string>(), watchedSessionId: null,
    send: (event: any) => { messages.push(event); if (event.token) queueMicrotask(() => registry.inputResult(producer, 'desktop', event.token, { dispatched: event.input.text ?? event.input.action })); } };
  const controller = { id: 'controller', userId: 'owner', producerSessionIds: new Set<string>(), watchedSessionId: null, send: vi.fn() };
  registry.publish(producer, { sessionId: 'desktop', backend: 'desktop', availability: 'ready' });
  registry.takeOver(controller, 'desktop'); registry.producerState(producer, 'desktop', 'user-controlled');
  const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890', version: 2 };
  registry.enableDirectInput(producer, 'desktop', context);
  const transport = new WeriftVideoTransport({ signal: (value: any) => signals.push(value), iceConfig: { iceServers: [] },
    inputStream: context.stream, inputVersion: 2, onReliableInput: (value: any) => registry.directReliableInput(producer, 'desktop', context, value) });
  const viewer = new RTCPeerConnection({ iceServers: [], codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
    parameters: 'packetization-mode=1;profile-level-id=42e034;level-asymmetry-allowed=1' })] } });
  let channel: any;
  viewer.onDataChannel.subscribe(value => { if (value.label === 'agentroam.input.reliable.v1') { channel = value; channel.onMessage.subscribe(raw => replies.push(JSON.parse(String(raw)))); } });
  try {
    await transport.start(); const offer = signals.find(value => value.kind === 'offer'); expect(offer.inputVersion).toBe(2);
    await viewer.setRemoteDescription(offer.sdp); await viewer.setLocalDescription(await viewer.createAnswer()); await transport.answer(viewer.localDescription);
    await vi.waitFor(() => expect(channel?.readyState).toBe('open'), { timeout: 15_000 });
    const first = { kind: 'key', text: '中文只输入一次', action: 'down' };
    channel.send(JSON.stringify({ kind: 'request', stream: context.stream, index: 2, sequence: 4, input: { kind: 'pointer', action: 'up', x: .2, y: .3 } }));
    const fallback = await registry.input(controller, 'desktop', { ...first, direct: { stream: context.stream, index: 1, sequence: 2 } });
    expect(fallback).toEqual({ dispatched: '中文只输入一次' });
    channel.send(JSON.stringify({ kind: 'request', stream: context.stream, index: 1, sequence: 2, input: first }));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.find(value => value.index === 1)).toMatchObject({ ok: true, result: fallback });
    expect(messages.filter(value => value.type === 'browser:input').map(value => value.input.text ?? value.input.action)).toEqual(['中文只输入一次', 'up']);
    registry.returnControl(controller, 'desktop');
    channel.send(JSON.stringify({ kind: 'request', stream: context.stream, index: 3, sequence: 5, input: first }));
    await vi.waitFor(() => expect(replies).toHaveLength(3)); expect(replies[2]).toMatchObject({ ok: false, code: 'ESTALE' });
    expect(messages.filter(value => value.type === 'browser:input')).toHaveLength(2);
  } finally { await transport.stop(); await viewer.close(); }
}, 30_000);
