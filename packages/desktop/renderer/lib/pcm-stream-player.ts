import type { TtsStreamMetadata } from "../global";

interface PlaybackApi {
  ttsStop(): Promise<{ ok: boolean }>;
  ttsPlaybackEnded(generation: number): Promise<{ ok: boolean }>;
}

interface WorkletPortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

interface WorkletNodeLike {
  port: WorkletPortLike;
  connect(destination: AudioDestinationNode): void;
  disconnect(): void;
}

interface AudioContextLike {
  destination: AudioDestinationNode;
  state: string;
  audioWorklet: { addModule(url: string): Promise<void> };
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface PlayerDependencies {
  createContext(): AudioContextLike;
  createNode(context: AudioContextLike): WorkletNodeLike;
  workletUrl: string;
}

interface GenerationState {
  metadata: TtsStreamMetadata;
  pending: Float32Array[];
  pendingSamples: number;
  finished: boolean;
  acknowledged: boolean;
}

const defaultDependencies: PlayerDependencies = {
  createContext: () => new AudioContext() as unknown as AudioContextLike,
  createNode: (context) => new AudioWorkletNode(
    context as unknown as BaseAudioContext,
    "pcm-stream-player",
    { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] },
  ) as unknown as WorkletNodeLike,
  workletUrl: "./pcm-audio-worklet.js",
};

export function decodeS16Le(pcm: ArrayBuffer | ArrayBufferView): Float32Array {
  const bytes = pcm instanceof ArrayBuffer
    ? new Uint8Array(pcm)
    : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (bytes.byteLength % 2 !== 0) throw new Error("PCM chunk contains an incomplete int16 sample");
  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

export class PcmStreamPlayer {
  private context: AudioContextLike | null = null;
  private node: WorkletNodeLike | null = null;
  private ready: Promise<void> | null = null;
  private current: GenerationState | null = null;

  constructor(
    private readonly api: PlaybackApi,
    private readonly dependencies: PlayerDependencies = defaultDependencies,
  ) {}

  start(metadata: TtsStreamMetadata): void {
    if (this.current && !this.current.acknowledged) {
      this.node?.port.postMessage({ type: "flush", generation: this.current.metadata.generation });
    }
    const state: GenerationState = {
      metadata,
      pending: [],
      pendingSamples: 0,
      finished: false,
      acknowledged: false,
    };
    this.current = state;
    void this.ensureReady().then(() => {
      if (this.current !== state || !this.node) return;
      this.node.port.postMessage({
        type: "start",
        generation: metadata.generation,
        sampleRate: metadata.sampleRate,
      });
      for (const samples of state.pending) this.postSamples(metadata.generation, samples);
      state.pending = [];
      state.pendingSamples = 0;
      if (state.finished) this.node.port.postMessage({ type: "finish", generation: metadata.generation });
    }).catch((error) => this.fail(state, error));
  }

  enqueue(generation: number, pcm: ArrayBuffer | ArrayBufferView): void {
    const state = this.current;
    if (!state || state.metadata.generation !== generation || state.acknowledged) return;
    let samples: Float32Array;
    try {
      samples = decodeS16Le(pcm);
    } catch (error) {
      this.fail(state, error);
      return;
    }
    if (this.node) {
      this.postSamples(generation, samples);
      return;
    }
    if (state.pendingSamples + samples.length > state.metadata.sampleRate) {
      this.fail(state, new Error("TTS PCM queue overflow"));
      return;
    }
    state.pending.push(samples);
    state.pendingSamples += samples.length;
  }

  finish(generation: number): void {
    const state = this.current;
    if (!state || state.metadata.generation !== generation || state.acknowledged) return;
    state.finished = true;
    this.node?.port.postMessage({ type: "finish", generation });
  }

  flush(generation: number): void {
    const state = this.current;
    if (!state || state.metadata.generation !== generation || state.acknowledged) return;
    this.node?.port.postMessage({ type: "flush", generation });
    state.pending = [];
    state.pendingSamples = 0;
    this.acknowledge(state);
  }

  dispose(): void {
    if (this.current) this.flush(this.current.metadata.generation);
    this.node?.disconnect();
    this.node = null;
    void this.context?.close();
    this.context = null;
    this.ready = null;
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const context = this.dependencies.createContext();
      this.context = context;
      await context.audioWorklet.addModule(this.dependencies.workletUrl);
      const node = this.dependencies.createNode(context);
      node.port.onmessage = (event) => this.onWorkletMessage(event.data as Record<string, unknown>);
      node.connect(context.destination);
      this.node = node;
      if (context.state !== "running") await context.resume();
    })();
    return this.ready;
  }

  private postSamples(generation: number, samples: Float32Array): void {
    this.node?.port.postMessage({ type: "chunk", generation, samples }, [samples.buffer]);
  }

  private onWorkletMessage(message: Record<string, unknown>): void {
    const state = this.current;
    if (!state || message.generation !== state.metadata.generation) return;
    if (message.type === "drained" || message.type === "stopped") {
      this.acknowledge(state);
      return;
    }
    if (message.type === "overflow") {
      this.fail(state, new Error("TTS AudioWorklet buffer overflow"));
    }
  }

  private fail(state: GenerationState, error: unknown): void {
    if (this.current !== state || state.acknowledged) return;
    console.error("[tts] PCM playback failed", error);
    state.acknowledged = true;
    this.current = null;
    void this.api.ttsStop();
    void this.api.ttsPlaybackEnded(state.metadata.generation);
  }

  private acknowledge(state: GenerationState): void {
    if (this.current !== state || state.acknowledged) return;
    state.acknowledged = true;
    this.current = null;
    void this.api.ttsPlaybackEnded(state.metadata.generation);
  }
}
