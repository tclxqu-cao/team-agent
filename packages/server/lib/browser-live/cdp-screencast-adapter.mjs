const BUTTONS = { left: "left", right: "right", middle: "middle" };
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export class BrowserLiveCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserLiveCapabilityError";
    this.code = "BROWSER_LIVE_STREAM_UNAVAILABLE";
  }
}

function directFrame(event) {
  if (event?.method === "Page.screencastFrame") return event.params;
  if (event?.method !== "Target.receivedMessageFromTarget" || typeof event.params?.message !== "string") return null;
  try {
    const nested = JSON.parse(event.params.message);
    return nested.method === "Page.screencastFrame" ? nested.params : null;
  } catch {
    return null;
  }
}

/** Pull-based CDP adapter used by runtimes that expose a replayable event cursor. */
export class CdpScreencastAdapter {
  constructor({ send, readEvents, pageState, fps = 5, quality = 70, maxWidth = 1440, maxHeight = 900, firstFrameTimeoutMs = 4_000, now = () => Date.now() }) {
    this.send = send;
    this.readEvents = readEvents;
    this.pageState = pageState;
    this.maxFps = Math.max(2, Math.min(5, fps));
    this.targetFps = this.maxFps;
    this.fastFrameStreak = 0;
    this.lastForwardedAt = null;
    this.quality = quality;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.cursor = undefined;
    this.running = false;
    this.stopPromise = null;
    this.viewport = null;
    this.firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.now = now;
  }

  async start(onFrame) {
    this.running = true;
    this.stopPromise = null;
    const initial = await this.pageState();
    this.viewport = { width: initial.width, height: initial.height, deviceScaleFactor: initial.deviceScaleFactor ?? 1 };
    const baseline = await this.readEvents({ methods: ["Page.screencastFrame"], timeoutMs: 0, limit: 1 });
    this.cursor = baseline?.cursor;
    await this.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
      everyNthFrame: Math.max(1, Math.round(60 / this.maxFps)),
    });
    const firstFrameDeadline = this.now() + this.firstFrameTimeoutMs;
    let receivedFrame = false;
    while (this.running) {
      const batch = await this.readEvents({
        afterSequence: this.cursor,
        methods: ["Page.screencastFrame", "Target.receivedMessageFromTarget"],
        timeoutMs: 1_000,
        limit: 20,
      });
      if (typeof batch?.cursor === "number") this.cursor = batch.cursor;
      for (const event of batch?.events ?? batch ?? []) {
        const frame = directFrame(event);
        if (!frame?.data || !Number.isInteger(frame.sessionId)) continue;
        receivedFrame = true;
        const timestamp = this.now();
        await this.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
        if (this.lastForwardedAt !== null && timestamp - this.lastForwardedAt < 1_000 / this.targetFps) continue;
        this.lastForwardedAt = timestamp;
        const state = await this.pageState();
        this.viewport = { width: state.width, height: state.height, deviceScaleFactor: state.deviceScaleFactor ?? 1 };
        const sendStartedAt = this.now();
        const result = await onFrame({ data: frame.data, viewport: this.viewport, title: state.title, url: state.url, timestamp });
        this.#adaptFps(result, Math.max(0, this.now() - sendStartedAt));
      }
      if (!receivedFrame && this.now() >= firstFrameDeadline) {
        throw new BrowserLiveCapabilityError("The browser runtime did not expose Page.screencastFrame events");
      }
    }
  }

  async stop() {
    this.running = false;
    if (!this.stopPromise) {
      this.stopPromise = this.send("Page.stopScreencast").catch(() => undefined);
    }
    await this.stopPromise;
  }

  #adaptFps(result, durationMs) {
    if (result?.accepted === false || durationMs > 500) {
      this.targetFps = Math.max(2, this.targetFps - 1);
      this.fastFrameStreak = 0;
      return;
    }
    this.fastFrameStreak += 1;
    if (this.targetFps < this.maxFps && this.fastFrameStreak >= this.targetFps * 2) {
      this.targetFps += 1;
      this.fastFrameStreak = 0;
    }
  }

  async dispatchInput(input) {
    if (!this.viewport) this.viewport = await this.pageState();
    if (input.kind === "pointer") {
      const x = Math.round(input.x * this.viewport.width);
      const y = Math.round(input.y * this.viewport.height);
      const type = input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : input.action === "wheel" ? "mouseWheel" : "mouseMoved";
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: BUTTONS[input.button] ?? "left", clickCount: input.action === "down" || input.action === "up" ? 1 : 0, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
      return;
    }
    if (input.text && !input.key && !input.code) {
      await this.send("Input.insertText", { text: input.text });
      return;
    }
    const modifiers = (input.modifiers ?? []).reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
    const type = input.action === "up" ? "keyUp" : input.text ? "char" : "keyDown";
    await this.send("Input.dispatchKeyEvent", { type, key: input.key, code: input.code, text: input.text, modifiers });
  }
}

/** Push-based adapter for ego-browser's dedicated screencast subscription. */
export class EgoScreencastAdapter {
  constructor({ send, subscribe, pageState, fps = 5, quality = 70, maxWidth = 1440, maxHeight = 900, firstFrameTimeoutMs = 4_000, now = () => Date.now() }) {
    this.send = send;
    this.subscribe = subscribe;
    this.pageState = pageState;
    this.maxFps = Math.max(2, Math.min(5, fps));
    this.targetFps = this.maxFps;
    this.fastFrameStreak = 0;
    this.lastForwardedAt = null;
    this.quality = quality;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.now = now;
    this.viewport = null;
    this.subscription = null;
    this.running = false;
    this.stopPromise = null;
    this.resolveStopped = null;
    this.rejectStopped = null;
  }

  async start(onFrame) {
    this.running = true;
    this.stopPromise = null;
    const initial = await this.pageState();
    this.viewport = { width: initial.width, height: initial.height, deviceScaleFactor: initial.deviceScaleFactor ?? 1 };
    const stopped = new Promise((resolve, reject) => {
      this.resolveStopped = resolve;
      this.rejectStopped = reject;
    });
    let receivedFrame = false;
    const firstFrameTimer = setTimeout(() => {
      if (!receivedFrame && this.running) {
        const error = new BrowserLiveCapabilityError("The ego-browser runtime did not expose Page.screencastFrame events");
        this.rejectStopped?.(error);
        void this.#disposeSubscription();
      }
    }, this.firstFrameTimeoutMs);
    try {
      this.subscription = await this.subscribe({
        size: { width: this.maxWidth, height: this.maxHeight },
        quality: this.quality,
        // Some shipped ego Chromium builds stop producing frames when this is
        // greater than one. Capture every compositor frame and enforce 2-5 FPS
        // in the forwarding path below.
        everyNthFrame: 1,
        onFrame: async (frame) => {
          if (!this.running || !frame?.data) return;
          receivedFrame = true;
          clearTimeout(firstFrameTimer);
          const timestamp = this.now();
          if (this.lastForwardedAt !== null && timestamp - this.lastForwardedAt < 1_000 / this.targetFps) return;
          this.lastForwardedAt = timestamp;
          const state = await this.pageState();
          this.viewport = { width: state.width, height: state.height, deviceScaleFactor: state.deviceScaleFactor ?? 1 };
          const sendStartedAt = this.now();
          try {
            const result = await onFrame({ data: frame.data, viewport: this.viewport, title: state.title, url: state.url, timestamp });
            this.#adaptFps(result, Math.max(0, this.now() - sendStartedAt));
          } catch (error) {
            this.rejectStopped?.(error);
            void this.#disposeSubscription();
          }
        },
      });
      await stopped;
    } finally {
      clearTimeout(firstFrameTimer);
      await this.#disposeSubscription();
    }
  }

  async stop() {
    if (!this.stopPromise) {
      this.running = false;
      this.stopPromise = this.#disposeSubscription().finally(() => this.resolveStopped?.());
    }
    await this.stopPromise;
  }

  async #disposeSubscription() {
    this.running = false;
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription?.dispose) await subscription.dispose();
  }

  #adaptFps(result, durationMs) {
    if (result?.accepted === false || durationMs > 500) {
      this.targetFps = Math.max(2, this.targetFps - 1);
      this.fastFrameStreak = 0;
      return;
    }
    this.fastFrameStreak += 1;
    if (this.targetFps < this.maxFps && this.fastFrameStreak >= this.targetFps * 2) {
      this.targetFps += 1;
      this.fastFrameStreak = 0;
    }
  }

  async dispatchInput(input) {
    if (!this.viewport) this.viewport = await this.pageState();
    if (input.kind === "pointer") {
      const x = Math.round(input.x * this.viewport.width);
      const y = Math.round(input.y * this.viewport.height);
      const type = input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : input.action === "wheel" ? "mouseWheel" : "mouseMoved";
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: BUTTONS[input.button] ?? "left", clickCount: input.action === "down" || input.action === "up" ? 1 : 0, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
      return;
    }
    if (input.text && !input.key && !input.code) {
      await this.send("Input.insertText", { text: input.text });
      return;
    }
    const modifiers = (input.modifiers ?? []).reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
    const type = input.action === "up" ? "keyUp" : input.text ? "char" : "keyDown";
    await this.send("Input.dispatchKeyEvent", { type, key: input.key, code: input.code, text: input.text, modifiers });
  }
}

export function createCodexCdpPort(cdp) {
  return {
    send: (method, params) => cdp.send(method, params),
    readEvents: (options) => cdp.readEvents(options),
  };
}
