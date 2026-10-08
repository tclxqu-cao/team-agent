import { logGlobal } from '@agent/core';
import { RemoteVideoSession } from './application/remote-video-session.mjs';
import { readRemoteIceConfig } from './ice-config.mjs';
import { NativeVideoEncoder } from './infrastructure/native-video-encoder.mjs';
import { WeriftVideoTransport } from './infrastructure/werift-video-transport.mjs';

export class RemoteWebrtcVideo extends RemoteVideoSession {
  constructor({
    helper,
    signal,
    policy,
    adaptation,
    iceConfig = readRemoteIceConfig(),
    highProfile = process.platform === 'darwin',
    transportFactory,
    encoder,
    log,
  }) {
    const resolvedEncoder = encoder ?? new NativeVideoEncoder({ helper, highProfile });
    const resolvedTransportFactory = transportFactory
      ?? ((options) => new WeriftVideoTransport({ ...options, iceConfig }));
    super({
      signal, policy, adaptation, encoder: resolvedEncoder, transportFactory: resolvedTransportFactory,
      // Timeline lands in the server daily NDJSON log under source "remote-video".
      log: log ?? ((level, message, data) => logGlobal(level, 'remote-video', message, undefined, data)),
    });
  }
}

export { packetizeH264 } from './infrastructure/werift-video-transport.mjs';
