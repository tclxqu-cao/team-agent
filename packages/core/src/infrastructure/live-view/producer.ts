import type { LiveViewDisplayOption, LiveViewInput, LiveViewOwnershipState, LiveViewSource } from "../../domain/live-view/entities.js";

/** Port implemented per runtime: continuous frames plus normalized input dispatch. */
export interface LiveScreencastPort {
  start(onFrame: (frame: LiveScreencastFrame) => Promise<{ accepted?: boolean } | void>): Promise<void>;
  stop(): Promise<void>;
  /** Returns an adapter-defined result (e.g. a hit-test of a tapped element) when available. */
  dispatchInput(input: LiveViewInput): Promise<unknown>;
}

export interface LiveScreencastFrame {
  data: Uint8Array | string;
  viewport: unknown;
  title: string;
  url: string;
  timestamp: number;
}

export interface LiveViewProducerClientPort {
  connect(): Promise<void>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  publish(metadata: Record<string, unknown>): Promise<unknown>;
  frame(sessionId: string, frame: LiveScreencastFrame & { sequence: number }): Promise<{ accepted?: boolean }>;
  state(sessionId: string, state: LiveViewOwnershipState): Promise<unknown>;
  /** Relays the adapter's input dispatch result back to the requesting viewer. */
  inputResult(sessionId: string, token: number, result: unknown): Promise<unknown>;
  /** Relays WebRTC signaling from the producer to the active viewer. */
  webrtcRelay(sessionId: string, data: Record<string, unknown>): Promise<unknown>;
  /** Re-publishes session metadata (e.g. after the capture display changed). */
  publish(metadata: PublishLiveSessionMetadata): Promise<unknown>;
  unavailable(sessionId: string, error: unknown): Promise<unknown>;
  waitForDisconnect(): Promise<void>;
  close(sessionId: string): Promise<unknown>;
  disconnect(): void;
}

interface ProducerMetadata {
  sessionId: string;
  backend: LiveViewSource;
  [key: string]: unknown;
}

/** Application service coordinating a screencast adapter with the live relay. */
export class LiveViewProducer {
  private readonly client: LiveViewProducerClientPort;
  private readonly screencast: LiveScreencastPort;
  readonly metadata: ProducerMetadata;
  private readonly pauseAgent: () => Promise<void>;
  private readonly resyncAgent: () => Promise<void>;
  private frameSequence = 0;
  private unsubscribe: (() => void) | null = null;
  private controlState: LiveViewOwnershipState = "agent-controlled";
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly onError: (error: unknown) => void;
  private readonly onSetDisplay: ((displayId: string | null) => Promise<LiveViewDisplayOption[] | null>) | null;

  constructor({ client, screencast, metadata, pauseAgent, resyncAgent, onError = () => undefined, onSetDisplay = null }: {
    client: LiveViewProducerClientPort;
    screencast: LiveScreencastPort;
    metadata: ProducerMetadata;
    pauseAgent: () => Promise<void>;
    resyncAgent: () => Promise<void>;
    onError?: (error: unknown) => void;
    onSetDisplay?: ((displayId: string | null) => Promise<LiveViewDisplayOption[] | null>) | null;
  }) {
    this.client = client;
    this.screencast = screencast;
    this.metadata = metadata;
    this.pauseAgent = pauseAgent;
    this.resyncAgent = resyncAgent;
    this.onError = onError;
    this.onSetDisplay = onSetDisplay;
  }

  #reportError(error: unknown): void {
    try { this.onError(error); } catch {}
  }

  async run(): Promise<void> {
    await this.client.connect();
    this.unsubscribe = this.client.onEvent((event) => {
      this.eventQueue = this.eventQueue
        .then(() => this.#handleEvent(event))
        .catch((error) => { this.#reportError(error); });
    });
    await this.client.publish({ ...this.metadata, state: "agent-controlled", availability: "starting", transport: "cdp-jpeg-ws" });
    try {
      await this.screencast.start((frame) => this.client.frame(this.metadata.sessionId, { ...frame, sequence: ++this.frameSequence }));
    } catch (error) {
      await this.client.unavailable(this.metadata.sessionId, error).catch(() => undefined);
      this.#reportError(error);
      await this.client.waitForDisconnect();
    } finally {
      this.unsubscribe?.();
      await this.screencast.stop();
      await this.client.close(this.metadata.sessionId).catch(() => this.client.disconnect());
    }
  }

  async #handleEvent(event: Record<string, unknown>): Promise<void> {
    if (event.sessionId !== this.metadata.sessionId) return;
    if (event.type === "browser:takeover-requested") {
      if (this.controlState !== "agent-controlled") return;
      this.controlState = "handoff-requested";
      try {
        await this.pauseAgent();
      } catch (error) {
        this.controlState = "agent-controlled";
        await this.client.state(this.metadata.sessionId, "agent-controlled").catch(() => undefined);
        throw error;
      }
      this.controlState = "user-controlled";
      await this.client.state(this.metadata.sessionId, "user-controlled");
      return;
    }
    if (event.type === "browser:input") {
      if (this.controlState !== "user-controlled" || !event.input) return;
      const result = await this.screencast.dispatchInput(event.input as LiveViewInput);
      const token = event.token;
      if (typeof token === "number" && Number.isSafeInteger(token)) {
        await this.client.inputResult(this.metadata.sessionId, token, result ?? null).catch(() => undefined);
      }
      return;
    }
    if (event.type === "browser:set-display") {
      if (this.controlState !== "user-controlled" || !this.onSetDisplay) return;
      const displays = await this.onSetDisplay(typeof event.displayId === "string" ? event.displayId : null);
      if (Array.isArray(displays)) {
        await this.client.publish({ ...this.metadata, displays }).catch(() => undefined);
      }
      return;
    }
    if (event.type === "browser:return-requested") {
      if (this.controlState !== "user-controlled") return;
      this.controlState = "resyncing";
      await this.client.state(this.metadata.sessionId, "resyncing");
      try {
        await this.resyncAgent();
      } catch (error) {
        this.controlState = "user-controlled";
        await this.client.state(this.metadata.sessionId, "user-controlled").catch(() => undefined);
        throw error;
      }
      this.controlState = "agent-controlled";
      await this.client.state(this.metadata.sessionId, "agent-controlled");
    }
  }
}
