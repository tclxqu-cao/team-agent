import * as liveView from '@agent/core';

let instanceSequence = 0;

/** Coordinates ports; pixel extraction and network/image codecs stay in adapters. */
export class CompoundVideoSession {
  constructor({ encoder, transport, onAllocationChanged = () => {}, log = () => {}, clock }) {
    this.encoder = encoder;
    this.transport = transport;
    this.onAllocationChanged = onAllocationChanged;
    this.log = log;
    this.clock = clock ?? {
      now: () => Date.now(),
      schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
      cancel: clearTimeout,
    };
    this.policy = new liveView.RemoteCompoundVideoPolicy();
    this.budgetPolicy = new liveView.RemoteCompoundBudgetPolicy();
    this.quality = new liveView.RemoteCompoundQualityPolicy();
    this.qoe = new liveView.RemoteFrameQoe();
    this.pendingBatches = new Map();
    this.features = new Set();
    this.cursorWireSequence = 0;
    this.receiverMaxTileBytes = 16_384;
    this.limits = liveView.REMOTE_COMPOUND_VIDEO;
    this.prefix = `compound-${++instanceSequence}`;
    this.epochSequence = 0;
    this.sequence = 0;
    this.generation = 0;
    this.bitRate = 8_000_000;
    this.records = new Map();
    this.sent = new Map();
    this.lastSentTimestamp = -Infinity;
    this.active = false;
    this.paused = false;
    this.receiverReady = false;
    this.frames = 0;
    this.reusedTiles = 0;
    this.bytes = 0;
    this.credit = 0;
    this.creditAt = this.clock.now();
    this.creditRate = 0;
    this.format = 'json-v1';
  }

  get pending() { return this.pendingBatches.values().next().value ?? null; }
  noteInteraction(point) { this.quality.noteInteraction(point, this.clock.now()); }
  snapshot() { return { ...this.quality.snapshot(), ...this.qoe.snapshot(), inFlightBatches: this.pendingBatches.size, format: this.format }; }

  async start() {
    if (this.unsupported) return;
    const generation = ++this.generation;
    this.active = true;
    this.unsubscribe = this.encoder.onCompound(frame => this.capture(frame));
    try {
      await this.encoder.enableCompound(true);
      if (!this.active || generation !== this.generation) return;
      this.refreshAllocation(false);
      this.startCursor();
      this.onAllocationChanged();
      this.log('info', 'compound video enabled', { codec: 'png', tileSize: this.limits.tileSize });
      this.schedule();
    } catch (error) { this.disable(error); }
  }

  videoDecision(decision) {
    this.refillCredit();
    this.bitRate = decision.bitRate;
    const allocation = this.refreshAllocation(false);
    return { ...decision, bitRate: allocation.videoBitRate };
  }

  observe(observation) {
    this.budgetPolicy.observe(observation, this.clock.now());
    this.quality.observe(observation.content?.activity);
    this.rttMs = observation.network?.rttMs ?? this.rttMs;
    this.refreshAllocation();
    if (this.active && this.clock.now() - (this.lastQoeLogAt ?? -Infinity) >= 5000 && this.qoe.snapshot().presentedFrames > 0) {
      this.lastQoeLogAt = this.clock.now();
      this.log('info', 'compound presentation quality', this.snapshot());
    }
  }

  startCursor() {
    if (!this.active || this.paused || this.cursorEnabled || !this.features.has('cursor-v1')
      || typeof this.encoder.enableCursor !== 'function' || typeof this.transport.sendCursor !== 'function') return;
    this.cursorEnabled = true;
    const token = this.cursorGeneration = (this.cursorGeneration ?? 0) + 1;
    this.unsubscribeCursor = this.encoder.onCursor(message => { if (this.active && !this.paused && token === this.cursorGeneration) this.transport.sendCursor({ ...message, sequence: ++this.cursorWireSequence }); });
    this.cursorActions = (this.cursorActions ?? Promise.resolve()).then(() => {
      if (this.active && !this.paused && token === this.cursorGeneration) return this.encoder.enableCursor(true);
    }).catch(error => {
      this.log('info', 'independent cursor unavailable', { reason: String(error?.message ?? error).slice(0, 200) });
      if (token === this.cursorGeneration) { this.cursorEnabled = false; this.unsubscribeCursor?.(); this.unsubscribeCursor = null; }
    });
  }

  stopCursor() {
    this.unsubscribeCursor?.(); this.unsubscribeCursor = null;
    if (!this.cursorEnabled) return Promise.resolve();
    this.cursorGeneration = (this.cursorGeneration ?? 0) + 1;
    this.cursorEnabled = false;
    this.transport.sendCursor?.({ sequence: ++this.cursorWireSequence, active: false, visible: false, x: 0, y: 0, cutoverRtp: 0 });
    this.cursorActions = (this.cursorActions ?? Promise.resolve()).then(() => this.encoder.enableCursor(false)).catch(() => {});
    return this.cursorActions;
  }

  prepare(message) {
    const envelope = { version: 1, ...message };
    if (this.transport.prepareCompound) return this.transport.prepareCompound(envelope, this.format);
    // Compatibility port for existing JSON-only transports.
    return { data: envelope, bytes: new TextEncoder().encode(JSON.stringify(envelope)).length };
  }

  send(message, prepared = this.prepare(message)) {
    if (!this.active || this.paused || !this.receiverReady) return false;
    const { bytes } = prepared;
    this.refillCredit();
    if (bytes > this.limits.maxMessageBytes || bytes > this.credit
      || this.transport.sendCompound?.(this.transport.prepareCompound ? prepared : prepared.data) !== true) return false;
    this.credit -= bytes;
    this.bytes += bytes;
    return true;
  }

  refillCredit() {
    const now = this.clock.now();
    // Accrue at the previous rate: a new demand spike cannot mint past credit.
    this.credit = Math.min(this.limits.maxMessageBytes, this.creditRate / 2,
      this.credit + Math.max(0, now - this.creditAt) * this.creditRate / 1000);
    this.creditAt = now;
  }

  refreshAllocation(notify = true) {
    this.refillCredit();
    const allocation = this.budgetPolicy.allocation(this.bitRate, this.active && !this.paused && this.receiverReady, this.clock.now());
    const changed = allocation.patchBytesPerSecond !== this.creditRate;
    this.creditRate = allocation.patchBytesPerSecond;
    this.credit = Math.min(this.credit, this.limits.maxMessageBytes, this.creditRate / 2);
    if (changed && notify) this.onAllocationChanged();
    return allocation;
  }

  resetFor(frame) {
    this.nativeFrame = frame;
    this.epoch = `${this.prefix}/${++this.epochSequence}/${frame.epoch}`;
    this.policy.reset();
    this.policy.invalidate({ ...frame, epoch: this.epoch });
    this.quality = new liveView.RemoteCompoundQualityPolicy();
    this.quality.invalidate({ ...frame, epoch: this.epoch }, undefined, this.clock.now());
    this.scrollCandidate = null; this.scrolledRevision = -1;
    this.pendingBatches.clear();
    this.records.clear();
    if (frame.kind === 'frame') this.records.set(liveView.compoundRtpTimestamp(frame.timestamp), { ...frame, epoch: this.epoch });
    this.needsReset = true;
    this.needsInvalidation = false;
  }

  flushControl() {
    const frame = this.nativeFrame;
    if (!frame) return false;
    if (this.needsReset) {
      if (!this.send({ kind: 'reset', epoch: this.epoch, revision: frame.revision, width: frame.width, height: frame.height })) return false;
      this.needsReset = false;
      const rtpTimestamp = liveView.compoundRtpTimestamp(frame.timestamp);
      if (frame.kind === 'frame' && this.sent.has(rtpTimestamp)) this.send({ kind: 'frame', epoch: this.epoch, revision: frame.revision, rtpTimestamp });
    }
    if (this.needsInvalidation) {
      const message = { kind: 'invalidate', epoch: this.epoch, revision: frame.revision, ...(this.dirtyRects ? { rects: this.dirtyRects } : {}) };
      // A large partial-clear command must not exceed the maximum attainable credit.
      // Whole-layer invalidation is smaller and preserves correctness on narrow links.
      if (message.rects && this.prepare(message).bytes > Math.min(this.limits.maxMessageBytes, this.creditRate / 2)) delete message.rects;
      if (!this.send(message)) return false;
      this.needsInvalidation = false;
    }
    return true;
  }

  capture(frame) {
    if (!this.active) return;
    if (frame.unsupported) { this.disable(new Error('Unsupported native compound frame')); return; }
    const previous = this.nativeFrame;
    if (previous?.epoch === frame.epoch && frame.revision < previous.revision) return;
    if (!previous || previous.epoch !== frame.epoch || previous.width !== frame.width || previous.height !== frame.height) this.resetFor(frame);
    else {
      this.nativeFrame = frame;
      this.policy.invalidate({ ...frame, epoch: this.epoch }, frame.rects);
      this.quality.invalidate({ ...frame, epoch: this.epoch }, frame.rects, this.clock.now());
      if (frame.revision !== previous.revision) {
        this.pendingBatches.clear();
        this.scrollCandidate = null;
        // If an earlier invalidation could not be delivered, preserve its damage.
        this.dirtyRects = this.needsInvalidation
          ? this.dirtyRects && frame.rects && this.dirtyRects.length + frame.rects.length <= 32 ? [...this.dirtyRects, ...frame.rects] : undefined
          : frame.rects;
        this.needsInvalidation = true;
      }
    }
    this.flushControl();
    if (frame.kind === 'frame') {
      const rtp = liveView.compoundRtpTimestamp(frame.timestamp);
      this.records.set(rtp, { ...frame, epoch: this.epoch });
      this.trim(this.records);
      if (this.sent.has(rtp)) this.barrier(rtp);
    }
  }

  trim(map) { while (map.size > 128) map.delete(map.keys().next().value); }

  frameSent(frame) {
    if (!this.active || this.paused || !Number.isFinite(frame.timestamp)) return;
    this.lastSentTimestamp = Math.max(this.lastSentTimestamp, frame.timestamp);
    const rtp = liveView.compoundRtpTimestamp(frame.timestamp);
    this.sent.set(rtp, { at: this.clock.now() });
    this.trim(this.sent);
    this.barrier(rtp);
  }

  barrier(rtpTimestamp) {
    const identity = this.records.get(rtpTimestamp);
    if (identity?.epoch !== this.epoch || !this.flushControl()) return;
    if (this.send({ kind: 'frame', epoch: this.epoch, revision: identity.revision, rtpTimestamp })) this.qoe.sent(rtpTimestamp, this.sent.get(rtpTimestamp)?.at ?? this.clock.now(), identity.capturedAt);
  }

  handleMessage(message) {
    if (message.kind === 'cursor-closed') { void this.stopCursor(); return; }
    if (message.kind === 'ready' && message.version === 1) {
      const previousFeatures = [...this.features].sort().join(',');
      this.features = new Set(Array.isArray(message.features) ? message.features.filter(feature => ['window-v1', 'scroll-v1', 'qoe-v1', 'cursor-v1'].includes(feature)) : []);
      const changedFeatures = this.receiverReady && previousFeatures !== [...this.features].sort().join(',');
      this.receiverMaxTileBytes = Number.isSafeInteger(message.maxTileBytes) && message.maxTileBytes > 0 ? Math.min(this.limits.maxTileBytes, message.maxTileBytes) : 16_384;
      if (!this.features.has('cursor-v1')) void this.stopCursor();
      const binary = Array.isArray(message.formats) && message.formats.includes('binary-v1')
        && typeof this.transport.prepareCompound === 'function' && typeof this.transport.compoundEncodingCost === 'function'
        ? 'binary-v1' : 'json-v1';
      const format = binary === 'binary-v1' && message.formats.includes('binary-zstd-v1') ? 'binary-zstd-v1' : binary;
      if (this.format !== format || changedFeatures) {
        this.format = format;
        this.generation += 1;
        if (this.nativeFrame) this.resetFor(this.nativeFrame);
        if (this.active) this.schedule();
      }
      this.receiverReady = true;
      this.startCursor();
      this.refreshAllocation();
      if (this.active) this.flushControl();
      return;
    }
    if (message.kind === 'unsupported') {
      this.unsupported = true;
      if (this.active) this.disable(new Error('Receiver cannot synchronize compound video'));
      return;
    }
    if (!this.active) return;
    if (message.kind === 'pong' && message.t0 === this.lastPing) {
      this.qoe.synchronize(message.t0, message.t1, message.t2, this.clock.now()); return;
    }
    if (message.kind === 'presented' && message.epoch === this.epoch) {
      this.qoe.presented(message.rtpTimestamp, message.presentedAt, this.clock.now()); return;
    }
    const pending = this.pendingBatches.get(message.sequence);
    if (message.kind !== 'ack' || message.epoch !== this.epoch || !pending) return;
    this.pendingBatches.delete(message.sequence);
    if (message.ok === true && pending.scroll) {
      this.quality.acknowledgeScroll(pending.scroll);
    } else if (message.ok === true && this.policy.acknowledge(pending.plan)) {
      this.quality.acknowledge(pending.plan.tiles);
      this.frames += 1;
      this.reusedTiles += pending.plan.tiles.filter(tile => tile.mode === 'reuse').length;
    } else if (this.nativeFrame) this.resetFor(this.nativeFrame);
  }

  schedule() {
    this.clock.cancel(this.timer);
    if (this.active && !this.paused) this.timer = this.clock.schedule(() => { void this.tick(); }, this.limits.sampleIntervalMs);
  }

  async tick() {
    if (this.sampling) return;
    this.sampling = true;
    const generation = this.generation;
    try {
      this.refreshAllocation();
      if (!this.active || this.paused || !this.receiverReady || !this.nativeFrame || !this.flushControl()) return;
      if (this.features.has('qoe-v1') && this.clock.now() - (this.lastPing ?? -Infinity) >= 5000) {
        const t0 = this.clock.now(); if (this.send({ kind: 'ping', t0 })) this.lastPing = t0;
      }
      for (const pending of this.pendingBatches.values()) if (this.clock.now() - pending.at > this.limits.acknowledgementTimeoutMs) { this.resetFor(this.nativeFrame); return; }
      const window = liveView.compoundWindowLimits(this.features.has('window-v1'), this.rttMs);
      const outstanding = [...this.pendingBatches.values()].reduce((sum, pending) => sum + pending.bytes, 0);
      if (this.pendingBatches.size >= window.batches || outstanding >= window.bytes || [...this.pendingBatches.values()].some(pending => pending.scroll)) return;
      if (this.creditRate === 0 || !this.transport.canSendCompound?.(this.limits.maxMessageBytes)) return;
      const nativeEpoch = this.nativeFrame.epoch;
      // Discover demand independently of earned credit, avoiding an idle-budget bootstrap deadlock.
      const inFlight = [...this.pendingBatches.values()].flatMap(pending => pending.plan?.tiles ?? []);
      const priorityIndices = this.quality.priorities(this.clock.now(), 128, inFlight);
      if (priorityIndices.length === 0) return;
      const sample = await this.encoder.sampleCompound(this.limits.maxMessageBytes, { priorityIndices, selectedOnly: true, maxEntropy: this.quality.entropyLimit(this.clock.now()) });
      if (!this.active || this.paused || generation !== this.generation || !sample
        || nativeEpoch !== sample.frame.epoch || this.nativeFrame?.epoch !== sample.frame.epoch
        || this.nativeFrame.revision !== sample.frame.revision || sample.frame.timestamp > this.lastSentTimestamp) return;
      this.quality.attempted(priorityIndices, this.clock.now());
      if (sample.scroll && this.features.has('scroll-v1') && this.scrolledRevision !== sample.frame.revision) this.scrollCandidate = sample.scroll;
      if (this.scrollCandidate && this.scrollCandidate.sourceRevision < sample.frame.revision && this.features.has('scroll-v1')) {
        const sequence = this.sequence + 1, scroll = this.scrollCandidate;
        const message = { kind: 'scroll', epoch: this.epoch, revision: sample.frame.revision, sequence, rtpTimestamp: liveView.compoundRtpTimestamp(sample.frame.timestamp), copy: scroll };
        const prepared = this.prepare(message);
        if (prepared.bytes <= this.credit) {
          this.sequence = sequence;
          this.pendingBatches.set(sequence, { sequence, scroll, bytes: prepared.bytes, at: this.clock.now() });
          if (this.send(message, prepared)) { this.scrolledRevision = sample.frame.revision; this.scrollCandidate = null; }
          else this.pendingBatches.delete(sequence);
        }
        return;
      }
      const occupied = new Set([...this.pendingBatches.values()].flatMap(pending => pending.plan?.tiles.map(tile => `${tile.x},${tile.y}`) ?? []));
      const unconfirmed = new Set([...this.pendingBatches.values()].flatMap(pending => pending.plan?.tiles.filter(tile => tile.mode === 'put').map(tile => tile.key) ?? []));
      const candidates = sample.tiles.filter(tile => tile.bytes <= this.receiverMaxTileBytes && !occupied.has(`${tile.x},${tile.y}`) && !unconfirmed.has(tile.key) && !this.quality.isSharp(tile));
      const identity = { ...sample.frame, epoch: this.epoch };
      const cost = this.transport.compoundEncodingCost?.(this.format, this.epoch);
      const offered = this.policy.plan(identity, candidates, this.limits.maxMessageBytes, cost);
      if (offered?.resetRequired) { this.resetFor(this.nativeFrame); return; }
      const payloads = new Map(sample.tiles.map(tile => [tile.key, tile.data]));
      const sequence = this.sequence + 1;
      const messageFor = plan => ({
        version: 1, kind: 'tiles', epoch: this.epoch, revision: sample.frame.revision, sequence,
        rtpTimestamp: liveView.compoundRtpTimestamp(sample.frame.timestamp),
        tiles: plan.tiles.map(tile => ({
          key: tile.key, cacheId: tile.cacheId, x: tile.x, y: tile.y, width: tile.width, height: tile.height,
          ...(tile.mode === 'put' ? { data: payloads.get(tile.key) } : {}),
        })),
      });
      if (offered) this.budgetPolicy.noteDemand(this.prepare(messageFor(offered)).bytes, this.clock.now());
      this.refreshAllocation();
      const budget = Math.min(this.limits.maxMessageBytes, Math.floor(this.credit), window.bytes - outstanding);
      const plan = this.policy.plan(identity, candidates, budget, cost);
      if (!plan) return;
      if (plan.resetRequired) { this.resetFor(this.nativeFrame); return; }
      const message = messageFor(plan), prepared = this.prepare(message);
      if (prepared.bytes > budget) return;
      this.sequence = sequence;
      this.policy.markSent(plan);
      // Install the receipt before sending: injected ports may acknowledge synchronously.
      this.pendingBatches.set(sequence, { sequence, plan, bytes: prepared.bytes, at: this.clock.now() });
      if (!this.send(message, prepared)) this.pendingBatches.delete(sequence);
    } catch (error) { this.disable(error); }
    finally { this.sampling = false; if (this.active && generation === this.generation) this.schedule(); }
  }

  disable(error) {
    this.send({ kind: 'disabled', epoch: this.epoch });
    this.log('info', 'compound video unavailable; continuing H264', { reason: String(error?.message ?? error).slice(0, 200) });
    void this.stop();
  }

  pause() { this.paused = true; void this.stopCursor(); this.generation += 1; this.clock.cancel(this.timer); this.pendingBatches.clear(); this.refreshAllocation(false); this.onAllocationChanged(); }
  resume() {
    this.paused = false;
    this.startCursor();
    this.generation += 1;
    if (this.nativeFrame) this.resetFor(this.nativeFrame);
    this.refreshAllocation(false);
    this.onAllocationChanged();
    this.schedule();
  }

  async stop() {
    const active = this.active;
    this.active = false;
    this.generation += 1;
    this.clock.cancel(this.timer);
    this.unsubscribe?.(); this.unsubscribe = null;
    this.policy.reset(); this.records.clear(); this.sent.clear(); this.pendingBatches.clear();
    const cursorStop = this.stopCursor();
    this.refreshAllocation(false);
    if (active) {
      this.onAllocationChanged();
      await cursorStop;
      await this.encoder.enableCompound(false).catch(() => undefined);
      this.log('info', 'compound video stopped', { acknowledgedBatches: this.frames, reusedTiles: this.reusedTiles, wireBytes: this.bytes, ...this.snapshot() });
    }
  }
}
