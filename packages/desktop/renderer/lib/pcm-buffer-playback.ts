interface PlaybackMessage {
  type: string;
  generation: number;
  sampleRate?: number;
  samples?: Float32Array;
}

/** Scheduled buffers keep PCM playback available when AudioWorklet cannot load. */
export function createBufferPlaybackNode(context: AudioContext) {
  type Playback = {
    generation: number;
    sampleRate: number;
    until: number;
    pendingSamples: number;
    finished: boolean;
    sources: Set<AudioBufferSourceNode>;
  };
  let destination: AudioDestinationNode | null = null;
  let active: Playback | null = null;
  const emit = (type: string, generation: number) => {
    queueMicrotask(() => port.onmessage?.({ data: { type, generation } } as MessageEvent));
  };
  const stop = (playback: Playback, type: string) => {
    if (active !== playback) return;
    active = null;
    for (const source of playback.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    playback.sources.clear();
    emit(type, playback.generation);
  };
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage(value: unknown): void {
      const message = value as PlaybackMessage;
      if (message.type === "start") {
        if (active) stop(active, "stopped");
        active = {
          generation: message.generation, sampleRate: message.sampleRate!,
          until: context.currentTime, pendingSamples: 0, finished: false, sources: new Set(),
        };
        return;
      }
      const playback = active;
      if (!playback || message.generation !== playback.generation) return;
      if (message.type === "flush") { stop(playback, "stopped"); return; }
      if (message.type === "finish") {
        playback.finished = true;
        if (playback.sources.size === 0) stop(playback, "drained");
        return;
      }
      if (message.type !== "chunk" || playback.finished) return;
      const samples = message.samples;
      if (!(samples instanceof Float32Array) || playback.pendingSamples + samples.length > playback.sampleRate) {
        stop(playback, "overflow");
        return;
      }
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, playback.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination!);
      playback.sources.add(source);
      playback.pendingSamples += samples.length;
      source.onended = () => {
        source.disconnect();
        if (active !== playback) return;
        playback.sources.delete(source);
        playback.pendingSamples -= samples.length;
        if (playback.finished && playback.sources.size === 0) stop(playback, "drained");
      };
      const startAt = Math.max(playback.until, context.currentTime + 0.02);
      playback.until = startAt + buffer.duration;
      source.start(startAt);
    },
  };
  return {
    port,
    connect(target: AudioDestinationNode): void { destination = target; },
    disconnect(): void {
      if (active) stop(active, "stopped");
      destination = null;
    },
  };
}
