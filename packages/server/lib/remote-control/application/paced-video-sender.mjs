/** Coordinates an opaque packet queue through policy, clock, writer and recovery ports. */
export class PacedVideoSender {
  /**
   * Ports: policy supplies budget/admission decisions; clock supplies monotonic time and cancellable timers;
   * write resolves after one packet leaves the adapter; callbacks report recovery, failure and completed frames.
   * Packet values and frame contexts are opaque to this coordinator.
   */
  constructor({ policy, clock, write, writeRepair, onRepairExpired = () => undefined,
    onRecovery = () => undefined, onKeyframe, onError, onFrameSent = () => undefined }) {
    this.policy = policy;
    this.clock = clock;
    this.write = write;
    this.writeRepair = writeRepair;
    this.onRepairExpired = onRepairExpired;
    this.onRecovery = onRecovery;
    this.onKeyframe = onKeyframe;
    this.onError = onError;
    this.onFrameSent = onFrameSent;
    this.queue = [];
    this.repairs = [];
    this.queuedRepairBytes = 0;
    this.current = null;
    this.queuedBytes = 0;
    this.droppedFrames = 0; this.supersededFrames = 0;
    this.lastKeyframeRequestAt = -Infinity;
    this.timer = null;
    this.draining = false;
    this.running = true;
    this.generation = 0;
    this.policy.reset(this.clock.now());
  }

  enqueue({ packets, keyFrame, context }) {
    if (!this.running) return false;
    const now = this.clock.now();
    this.expire(now);
    const valid = Array.isArray(packets) && packets.length > 0
      && packets.every(packet => Number.isFinite(packet.bytes) && packet.bytes > 0 && packet.bytes <= this.policy.maxPacketBytes);
    const bytes = valid ? packets.reduce((total, packet) => total + packet.bytes, 0) : Infinity;
    if (!valid || bytes > this.policy.maxQueuedBytes) {
      this.recover(now, true);
      this.droppedFrames += 1;
      return false;
    }
    if (keyFrame) this.discardPending();
    if (this.policy.overloaded({
      bytes: this.queuedBytes + bytes,
      frames: this.queue.length + (this.current ? 1 : 0) + 1,
      ageMs: this.queue.length ? now - this.queue[0].enqueuedAt : 0,
    })) this.recover(now, true);
    if (this.policy.waitingForKeyframe && !keyFrame) {
      this.droppedFrames += 1;
      this.requestKeyframe(now);
      return false;
    }
    // A partial frame can occupy the cap by itself. Never exceed the byte bound even for an IDR.
    if (this.queuedBytes + bytes > this.policy.maxQueuedBytes) {
      this.droppedFrames += 1;
      return false;
    }
    if (!this.policy.acceptFrame(keyFrame)) return false;
    this.queue.push({ packets, bytes, keyFrame, context, index: 0, enqueuedAt: now });
    this.queuedBytes += bytes;
    this.wake();
    return true;
  }

  setBitRate(bitRate) {
    this.policy.setBitRate(bitRate, this.clock.now());
    this.cancelTimer();
    this.wake();
  }

  setRepairBitRate(bitRate) {
    this.policy.setRepairBitRate(bitRate, this.clock.now());
    this.cancelTimer(); this.wake();
  }

  enqueueRepair({ value, bytes, expiresAt }) {
    if (!this.running || !this.writeRepair || !Number.isFinite(bytes) || bytes <= 0
      || bytes > this.policy.maxPacketBytes || !Number.isFinite(expiresAt) || expiresAt <= this.clock.now()
      || this.repairs.length >= this.policy.maxQueuedRepairs
      || this.queuedRepairBytes + bytes > this.policy.maxQueuedRepairBytes) return false;
    this.repairs.push({ value, bytes, expiresAt });
    this.queuedRepairBytes += bytes;
    // A new eligible repair may precede a timer waiting on the next primary packet.
    this.cancelTimer();
    this.wake();
    return true;
  }

  clearRepairs() {
    this.repairs = [];
    this.queuedRepairBytes = 0;
  }

  get queueDelayMs() {
    const oldest = this.current ?? this.queue[0];
    return oldest ? Math.max(0, this.clock.now() - oldest.enqueuedAt) : 0;
  }

  snapshot() {
    const oldest = this.current ?? this.queue[0];
    const snapshot = {
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length + (this.current ? 1 : 0),
      queueDelayMs: oldest ? Math.max(0, this.clock.now() - oldest.enqueuedAt) : 0,
      droppedFrames: this.droppedFrames,
      supersededFrames: this.supersededFrames,
      pacingBitRate: this.policy.pacingBitRate,
      waitingForKeyframe: this.policy.waitingForKeyframe,
      queuedRepairBytes: this.queuedRepairBytes,
      queuedRepairs: this.repairs.length,
    };
    this.droppedFrames = 0; this.supersededFrames = 0;
    return snapshot;
  }

  pause() {
    this.running = false;
    this.generation += 1;
    this.cancelTimer();
    this.current = null;
    this.queue = [];
    this.clearRepairs();
    this.queuedBytes = 0;
    this.droppedFrames = 0; this.supersededFrames = 0;
    this.policy.requireKeyframe();
    this.onRecovery();
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.policy.reset(this.clock.now());
    this.lastKeyframeRequestAt = -Infinity;
  }

  stop() { this.pause(); }

  discardPending() {
    this.clearRepairs();
    this.supersededFrames += this.queue.length;
    this.queue = [];
    if (this.current?.index === 0) {
      this.supersededFrames += 1;
      this.current = null;
    }
    this.queuedBytes = this.remainingBytes();
  }

  remainingBytes() {
    return this.current
      ? this.current.packets.slice(this.current.index).reduce((sum, packet) => sum + packet.bytes, 0)
      : 0;
  }

  recover(now, preserveActive = false) {
    this.clearRepairs();
    this.onRecovery();
    this.droppedFrames += this.queue.length;
    this.queue = [];
    if (this.current && (!preserveActive || this.current.index === 0)) {
      this.droppedFrames += 1;
      this.current = null;
    }
    this.queuedBytes = this.remainingBytes();
    this.policy.requireKeyframe();
    this.requestKeyframe(now);
  }

  expire(now) {
    if (this.current && now - this.current.enqueuedAt >= this.policy.frameLifetimeMs(this.current.bytes, this.current.keyFrame)) {
      this.recover(now);
    } else if (this.queue[0] && now - this.queue[0].enqueuedAt >= this.policy.frameLifetimeMs(this.queue[0].bytes, this.queue[0].keyFrame)) {
      this.recover(now, true);
    }
  }

  expireRepairs(now) {
    const expired = this.repairs.filter(packet => now >= packet.expiresAt);
    this.repairs = this.repairs.filter(packet => now < packet.expiresAt);
    this.queuedRepairBytes = this.repairs.reduce((sum, packet) => sum + packet.bytes, 0);
    for (const packet of expired) this.onRepairExpired(packet.value);
  }

  requestKeyframe(now) {
    if (now - this.lastKeyframeRequestAt < 1_000) return;
    this.lastKeyframeRequestAt = now;
    this.onKeyframe();
  }

  cancelTimer() {
    if (this.timer !== null) this.clock.cancel(this.timer);
    this.timer = null;
  }

  wake(delay = 0) {
    if (!this.running || this.draining || this.timer !== null || (!this.current && !this.queue.length && !this.repairs.length)) return;
    const generation = this.generation;
    this.timer = this.clock.schedule(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      void this.drain();
    }, delay > 0 ? Math.max(1, Math.ceil(delay)) : 0);
  }

  async drain() {
    if (this.draining || !this.running) return;
    this.draining = true;
    const generation = this.generation;
    let delay = 0;
    try {
      while (this.running && generation === this.generation) {
        const now = this.clock.now();
        this.expire(now);
        this.expireRepairs(now);
        this.current ??= this.queue.shift() ?? null;
        const frame = this.current;
        const repair = this.repairs[0];
        if (!frame && !repair) break;
        const packet = frame?.packets[frame.index];
        const primaryDelay = packet ? this.policy.delayFor(packet.bytes, now) : Infinity;
        const repairDelay = repair ? this.policy.delayForRepair(repair.bytes, now) : Infinity;
        if (repair && repairDelay <= 0 && this.policy.consumeRepair(repair.bytes, now)) {
          this.repairs.shift();
          this.queuedRepairBytes -= repair.bytes;
          await this.writeRepair(repair.value);
          continue;
        }
        if (primaryDelay > 0) {
          const deadlines = [frame, this.queue[0]].filter(Boolean)
            .map(queued => this.policy.frameLifetimeMs(queued.bytes, queued.keyFrame) - (now - queued.enqueuedAt));
          delay = Math.min(primaryDelay, repairDelay, ...deadlines, ...this.repairs.map(packet => packet.expiresAt - now));
          break;
        }
        if (!this.policy.consume(packet.bytes, now)) break;
        const firstPacket = frame.index === 0;
        frame.index += 1;
        this.queuedBytes -= packet.bytes;
        await this.write(packet.value, {
          keyFrameStart: frame.keyFrame && firstPacket,
          frameDeadline: frame.enqueuedAt + this.policy.frameLifetimeMs(frame.bytes, frame.keyFrame),
        });
        if (!this.running || generation !== this.generation) break;
        if (this.current === frame && frame.index === frame.packets.length) {
          this.current = null;
          this.onFrameSent(frame.context);
        }
      }
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.stop();
        this.onError(error);
      }
    } finally {
      this.draining = false;
      this.wake(delay);
    }
  }
}
