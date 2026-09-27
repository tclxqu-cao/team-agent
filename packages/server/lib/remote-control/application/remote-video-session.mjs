import { RemoteVideoPolicy } from '@agent/core';

export class RemoteVideoSession {
  constructor({ signal, policy, adaptation, transportFactory, encoder, logger = null }) {
    this.signal = signal;
    this.encoder = encoder;
    this.logger = logger;
    this.policy = policy ?? adaptation ?? new RemoteVideoPolicy('hd', this.encoder.capabilities());
    this.transportFactory = transportFactory;
    this.generation = 0;
    this.paused = false;
    this.tuningChain = Promise.resolve();
    this.lastMediaLogKey = '';
  }

  get connected() { return Boolean(this.transport?.connected ?? this._connectedOverride); }
  set connected(value) { if (this.transport) this.transport.connected = Boolean(value); else this._connectedOverride = Boolean(value); }
  get peer() { return this.transport?.peer ?? this._peerOverride ?? null; }
  set peer(value) { this._peerOverride = value; }

  setQuality(quality) { return this.applyTuning(this.policy.setQuality(quality)); }
  noteInteraction() {
    const decision = this.policy.noteInteraction();
    const previous = this.latestDecision;
    if (!previous
      || previous.bitRate !== decision.bitRate
      || previous.maxFps !== decision.maxFps
      || previous.preferredCodec !== decision.preferredCodec) this.applyTuning(decision);
    this.logMediaDecision('interaction', decision);
    return decision;
  }
  applyTuning(decision) {
    this.latestDecision = decision;
    this.pendingDecision = decision;
    this.tuningChain = this.tuningChain.then(async () => {
      while (this.pendingDecision) {
        const next = this.pendingDecision;
        this.pendingDecision = null;
        await this.encoder.apply(next).catch(() => undefined);
      }
    });
    return decision;
  }
  applyStats(sample) {
    const observation = { network: {
      lossRate: sample.lossRate, rttMs: sample.rttMs, droppedFrames: sample.droppedFrames,
      availableOutgoingBitrate: sample.availableBitrate ?? sample.availableOutgoingBitrate,
    } };
    this.receiverObservation = { ...observation, sampledAt: Date.now() };
    const decision = this.policy.current();
    this.logMediaDecision('receiver-stats', decision, observation);
    return decision;
  }

  logMediaDecision(trigger, decision, observation = {}) {
    if (!this.logger?.info) return;
    const network = observation.network ?? {};
    const encoder = observation.encoder ?? {};
    const content = observation.content ?? {};
    const payload = {
      trigger,
      reason: decision.reason,
      quality: decision.quality,
      targetBitRate: decision.bitRate,
      targetFps: decision.maxFps,
      codecProfile: decision.preferredCodec,
      activity: content.activity,
      activityConfidence: content.confidence,
      rttMs: network.rttMs,
      lossRate: network.lossRate,
      availableBitrate: network.availableOutgoingBitrate,
      transportDroppedFrames: network.droppedFrames,
      encoderPendingFrames: encoder.pendingFrames,
      encoderLatencyMs: encoder.encodeLatencyMs,
      encoderDroppedFrames: encoder.droppedFrames,
      encoderSequence: encoder.sequence,
    };
    const bucket = (value, size) => Number.isFinite(value) ? Math.round(value / size) * size : undefined;
    const material = {
      ...payload,
      reason: undefined,
      rttMs: bucket(payload.rttMs, 5),
      lossRate: bucket(payload.lossRate, 0.01),
      availableBitrate: bucket(payload.availableBitrate, 250_000),
      encoderLatencyMs: bucket(payload.encoderLatencyMs, 5),
      encoderSequence: undefined,
    };
    const key = JSON.stringify(material);
    if (key === this.lastMediaLogKey) return;
    this.lastMediaLogKey = key;
    this.logger.info('remote video decision', payload);
  }

  async handle(data) {
    if (data.kind === 'stop') return this.stop();
    if (data.kind === 'quality') return this.setQuality(data.quality);
    if (data.kind === 'stats') return this.connected ? this.applyStats(data) : undefined;
    if (data.kind === 'start') {
      await this.stop();
      const generation = this.generation;
      this.policy.resetSession?.();
      const receiverProfiles = Array.isArray(data.receiverProfiles) ? data.receiverProfiles : ['baseline'];
      const profile = this.policy.selectCodec?.(receiverProfiles) ?? 'baseline';
      return this.startAttempt(profile, generation);
    }
    if (data.kind === 'answer') return this.transport?.answer(data.sdp);
    if (data.kind === 'ice') return this.transport?.addIceCandidate(data.candidate);
  }

  async startAttempt(profile, generation, fallbackReason) {
    if (generation !== this.generation) return;
    await this.stopAttempt();
    if (generation !== this.generation) return;
    this.profile = profile;
    let transport;
    transport = this.transportFactory({
      signal: this.signal,
      onKeyframe: () => { if (!this.paused) void this.encoder.requestKeyframe().catch(() => undefined); },
      onState: state => { void this.onTransportState(state, transport, generation); },
    });
    this.transport = transport;
    this.unsubscribe = this.encoder.onFrame(frame => this.onFrame(frame, generation, transport));
    this.connectTimer = setTimeout(() => {
      if (this.transport === transport && !transport.connected) void this.failAttempt(new Error('WebRTC connection timeout'), generation);
    }, 20_000);
    this.connectTimer.unref?.();
    if (fallbackReason) this.signal({ kind: 'state', state: 'connecting', fallbackReason });
    try { await transport.start(profile); } catch (error) { await this.failAttempt(error, generation); }
  }

  async onTransportState(state, transport, generation) {
    if (generation !== this.generation || this.transport !== transport) return;
    if (state === 'connected') {
      clearTimeout(this.connectTimer);
      const decision = { ...this.policy.current('connected'), preferredCodec: this.profile };
      try {
        await this.encoder.start({ profile: this.profile, decision });
        if (generation !== this.generation || this.transport !== transport) {
          await this.encoder.stop().catch(() => undefined);
          return;
        }
        this.encoderActive = true;
        this.applyTuning(decision);
        this.signal({ kind: 'state', state: 'connected' });
        this.watchFrames(transport, generation);
        this.watchStats(transport, generation);
        this.firstFrameTimer = setTimeout(() => {
          if (this.transport === transport && !this.firstFrameSeen) void this.failAttempt(new Error('H.264 first frame timeout'), generation);
        }, 5_000);
        this.firstFrameTimer.unref?.();
      } catch (error) { await this.failAttempt(error, generation); }
      return;
    }
    if (['failed', 'closed', 'disconnected'].includes(state)) await this.failAttempt(new Error(`WebRTC ${state}`), generation);
    else this.signal({ kind: 'state', state });
  }

  onFrame(frame, generation, transport = this.transport) {
    if (generation !== this.generation || this.transport !== transport || this.paused || !this.connected) return;
    if (frame.error) { void this.failAttempt(new Error(frame.error), generation); return; }
    if (!this.transport?.send(frame)) return;
    this.firstFrameSeen = true;
    clearTimeout(this.firstFrameTimer);
    this.watchFrames(this.transport, generation);
  }

  async failAttempt(error, generation) {
    if (generation !== this.generation || this.failing) return;
    this.failing = true;
    try {
      const fallback = this.policy.fallbackCodec?.(this.profile);
      if (fallback) {
        const reason = String(error?.message ?? error).slice(0, 500);
        await this.stopAttempt();
        this.failing = false;
        await this.startAttempt(fallback, generation, reason);
        return;
      }
      this.signal({ kind: 'state', state: 'failed', error: String(error?.message ?? error).slice(0, 500) });
      await this.stop();
    } finally { this.failing = false; }
  }

  watchStats(transport, generation) {
    clearInterval(this.statsTimer);
    let sampling = false;
    this.statsTimer = setInterval(async () => {
      if (sampling || generation !== this.generation || this.transport !== transport || this.paused || !transport.connected) return;
      sampling = true;
      try {
      const [network, encoder] = await Promise.all([transport.snapshot().catch(() => null), this.encoder.snapshot().catch(() => null)]);
      if (generation !== this.generation || this.transport !== transport || this.paused) return;
      const receiver = this.receiverObservation;
      this.receiverObservation = null;
      const freshReceiver = receiver && Date.now() - receiver.sampledAt <= 3_000 ? receiver.network : null;
      if (network || encoder || freshReceiver) {
        // Receiver stats can omit RTT/available bitrate. Do not erase fresh
        // sender feedback with those undefined fields.
        const receiverFields = Object.fromEntries(Object.entries(freshReceiver ?? {}).filter(([, value]) => Number.isFinite(value)));
        const observation = { network: { ...network, ...receiverFields }, encoder: encoder?.telemetry, content: encoder?.content };
        const decision = this.applyTuning(this.policy.update(observation));
        this.logMediaDecision('adaptive-sample', decision, observation);
      }
      } finally { sampling = false; }
    }, 2_000);
    this.statsTimer.unref?.();
  }

  watchFrames(transport = this.transport, generation = this.generation) {
    if (this.paused || !transport) return;
    clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(async () => {
      if (generation !== this.generation || this.transport !== transport || this.paused) return;
      try { await this.encoder.requestKeyframe(); this.watchFrames(transport, generation); }
      catch (error) { await this.failAttempt(error, generation); }
    }, 5_000);
    this.frameTimer.unref?.();
  }

  pause() { this.paused = true; clearTimeout(this.frameTimer); clearInterval(this.statsTimer); }
  async resume() {
    this.paused = false;
    if (this.connected && this.peer) {
      if (this.transport) {
        this.watchFrames(this.transport, this.generation);
        this.watchStats(this.transport, this.generation);
      }
      await this.encoder.requestKeyframe();
    }
  }
  async stopAttempt() {
    this.receiverObservation = null;
    const hadAttempt = Boolean(this.transport || this.unsubscribe || this.encoderActive);
    clearTimeout(this.connectTimer); clearTimeout(this.firstFrameTimer); clearTimeout(this.frameTimer); clearInterval(this.statsTimer);
    this.firstFrameSeen = false;
    this.unsubscribe?.(); this.unsubscribe = null;
    const transport = this.transport; this.transport = null;
    if (hadAttempt) await this.encoder.stop();
    this.encoderActive = false;
    await transport?.stop();
  }
  async stop() {
    this.generation += 1; this.paused = false;
    await this.stopAttempt();
    const peer = this._peerOverride; this._peerOverride = null; this._connectedOverride = false;
    if (peer?.close) await peer.close();
  }
}
