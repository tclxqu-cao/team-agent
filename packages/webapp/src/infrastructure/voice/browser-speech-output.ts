import type { SpeechOutputPort } from "../../domain/ports/speech-output-port";
import type { TtsStreamMetadata } from "../../domain/ports/agent-port";

type Generation = { generation: number };

export class BrowserSpeechOutput implements SpeechOutputPort {
  private generation = 0;
  private playing: number | null = null;
  private active: { sessionId: string; generation: number; socket?: WebSocket; cancel(): void } | null = null;
  private readonly starts = new Set<(metadata: TtsStreamMetadata) => void>();
  private readonly pcm = new Set<(chunk: { generation: number; pcm: ArrayBuffer }) => void>();
  private readonly finishes = new Set<(event: Generation) => void>();
  private readonly flushes = new Set<(event: Generation) => void>();
  private readonly ends = new Set<(event: Generation) => void>();

  constructor(private readonly openSocket: () => Promise<WebSocket>) {
    window.addEventListener("pagehide", () => { void this.ttsStop(); });
  }

  async ttsSpeak(text: string): Promise<{ ok: boolean }> {
    await this.ttsStop();
    this.active?.cancel();
    if (!text.trim()) throw new Error("播报内容不能为空");
    const state = { sessionId: crypto.randomUUID(), generation: ++this.generation, socket: undefined as WebSocket | undefined, cancel: () => {} };
    this.active = state;
    let timer: ReturnType<typeof setTimeout>;
    let started = false;
    return new Promise<{ ok: boolean }>((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer);
        if (this.active !== state) return;
        this.active = null;
        state.socket?.close();
        if (error) {
          if (this.playing === state.generation) this.playing = null;
          for (const callback of this.flushes) callback(state);
          for (const callback of this.ends) callback(state);
          reject(error);
        } else resolve({ ok: true });
      };
      state.cancel = () => {
        if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "cancel", sessionId: state.sessionId, generation: state.generation }));
        if (this.playing === state.generation) this.playing = null;
        for (const callback of this.flushes) callback(state);
        for (const callback of this.ends) callback(state);
        settle();
      };
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(new Error("语音播报超时，请重试")), 35_000);
      };
      resetTimer();
      void this.openSocket().then((socket) => {
        if (this.active !== state) { socket.close(); return; }
        state.socket = socket;
        socket.binaryType = "arraybuffer";
        const start = () => socket.send(JSON.stringify({ type: "start", sessionId: state.sessionId, generation: state.generation, text: text.trim().slice(0, 600), speed: 1 }));
        socket.addEventListener("open", start, { once: true });
        socket.addEventListener("error", () => settle(new Error("语音播报连接失败")));
        socket.addEventListener("close", () => settle(new Error("语音播报连接已断开")));
        socket.addEventListener("message", ({ data }) => {
          if (this.active !== state) return;
          resetTimer();
          if (data instanceof ArrayBuffer) {
            if (!started || data.byteLength % 2 !== 0) { settle(new Error("语音播报音频无效")); return; }
            for (const callback of this.pcm) callback({ generation: state.generation, pcm: data });
            return;
          }
          let event: Record<string, unknown>;
          try { event = JSON.parse(String(data)); } catch { settle(new Error("语音播报数据无效")); return; }
          if (event.type === "error") { settle(new Error(typeof event.message === "string" ? event.message : "语音播报失败")); return; }
          if (event.sessionId !== state.sessionId || event.generation !== state.generation) return;
          if (event.type === "started") {
            if (started || event.sampleRate !== 24_000 || event.channels !== 1 || event.sampleFormat !== "s16le") { settle(new Error("语音播报格式无效")); return; }
            started = true;
            this.playing = state.generation;
            for (const callback of this.starts) callback({ sessionId: state.sessionId, generation: state.generation, sampleRate: 24_000, channels: 1, sampleFormat: "s16le" });
          } else if (event.type === "finished" && started) {
            for (const callback of this.finishes) callback(state);
            settle();
          } else if (event.type === "cancelled") state.cancel();
        });
        if (socket.readyState === WebSocket.OPEN) start();
      }).catch((error) => settle(error instanceof Error ? error : new Error("语音播报连接失败")));
    });
  }

  async ttsStop(): Promise<{ ok: boolean }> {
    this.active?.cancel();
    // Synthesis may have finished while PCM is still playing.
    if (this.playing !== null) {
      const generation = this.playing;
      this.playing = null;
      for (const callback of this.flushes) callback({ generation });
      for (const callback of this.ends) callback({ generation });
    }
    return { ok: true };
  }

  async ttsPlaybackEnded(generation: number): Promise<{ ok: boolean }> {
    if (generation === this.playing) {
      this.playing = null;
      for (const callback of this.ends) callback({ generation });
    }
    return { ok: true };
  }

  onTtsStart(callback: (metadata: TtsStreamMetadata) => void): () => void { this.starts.add(callback); return () => { this.starts.delete(callback); }; }
  onTtsPcm(callback: (chunk: { generation: number; pcm: ArrayBuffer }) => void): () => void { this.pcm.add(callback); return () => { this.pcm.delete(callback); }; }
  onTtsStreamEnd(callback: (event: Generation) => void): () => void { this.finishes.add(callback); return () => { this.finishes.delete(callback); }; }
  onTtsFlush(callback: (event: Generation) => void): () => void { this.flushes.add(callback); return () => { this.flushes.delete(callback); }; }
  onTtsEnd(callback: (event: Generation) => void): () => void { this.ends.add(callback); return () => { this.ends.delete(callback); }; }
}
