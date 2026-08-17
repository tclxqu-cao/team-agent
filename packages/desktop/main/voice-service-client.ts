import WebSocket from "ws";

export type VoiceServiceEvent =
  | { type: "keyword"; sessionId: string; generation: number; keyword: string }
  | { type: "partial"; sessionId: string; generation: number; text: string }
  | { type: "final"; sessionId: string; generation: number; utteranceId: number; text: string }
  | { type: "finished"; sessionId: string; generation: number };

export function isCurrentVoiceEvent(
  event: VoiceServiceEvent,
  current: { sessionId: string; generation: number },
): boolean {
  return event.sessionId === current.sessionId && event.generation === current.generation;
}

type VoiceMode = "wake" | "dictation" | "barge-in";
type AsrStart = { sessionId: string; generation: number; mode: VoiceMode; wakeWord?: string };

export class VoiceServiceTtsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`voice service TTS failed: ${code}`);
    this.name = "VoiceServiceTtsError";
  }
}

export interface TtsStreamMetadata {
  sessionId: string;
  generation: number;
  sampleRate: 24_000;
  channels: 1;
  sampleFormat: "s16le";
}

export interface TtsStreamHandlers {
  onStarted(metadata: TtsStreamMetadata): void;
  onPcm(chunk: Buffer): void;
}

interface ActiveSynthesis {
  socket: WebSocket;
  request: { sessionId: string; generation: number };
}

export class VoiceServiceClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private socket: WebSocket | null = null;
  private current: AsrStart | null = null;
  private ready = false;
  private readonly syntheses = new Set<ActiveSynthesis>();
  private readonly ttsStartTimeoutMs: number;

  constructor(options: { baseUrl: string; token: string | null; ttsStartTimeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.ttsStartTimeoutMs = options.ttsStartTimeoutMs ?? 10_000;
  }

  startAsr(
    start: AsrStart,
    onEvent: (event: VoiceServiceEvent) => void,
    onDisconnect?: (error: Error) => void,
  ): Promise<void> {
    this.closeAsr();
    this.current = start;
    this.ready = false;
    const endpoint = new URL("/v1/asr", this.baseUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
    const socket = new WebSocket(endpoint, { headers });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("voice service ASR readiness timed out"));
      }, 5_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.once("close", () => {
        if (!this.ready) {
          fail(new Error("voice service ASR closed before ready"));
          return;
        }
        if (this.socket === socket) {
          onDisconnect?.(new Error("voice service ASR disconnected"));
        }
      });
      socket.on("message", (data) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.type === "ready"
          && message.sessionId === start.sessionId
          && message.generation === start.generation) {
          clearTimeout(timer);
          this.ready = true;
          resolve();
          return;
        }
        if ((message.type === "keyword" || message.type === "partial" || message.type === "final" || message.type === "finished")
          && this.current) {
          const event = message as unknown as VoiceServiceEvent;
          if (isCurrentVoiceEvent(event, this.current)) onEvent(event);
        }
      });
      socket.once("open", () => {
        socket.send(JSON.stringify({ ...start, type: "start", sampleRate: 16_000 }));
      });
    });
  }

  sendPcm(pcm: Buffer): void {
    if (!this.socket || !this.ready || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(pcm, { binary: true });
  }

  finishAsr(): void {
    this.sendControl("finish");
  }

  resetAsr(): void {
    this.sendControl("reset");
  }

  private sendControl(type: "finish" | "reset" | "stop"): void {
    if (!this.socket || !this.current || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type,
      sessionId: this.current.sessionId,
      generation: this.current.generation,
    }));
  }

  streamSynthesize(
    request: { sessionId: string; generation: number; text: string; voice?: string; speed?: number },
    signal: AbortSignal,
    handlers: TtsStreamHandlers,
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(this.abortError());
    const endpoint = new URL("/v1/tts/stream", this.baseUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
    const socket = new WebSocket(endpoint, { headers });
    const active = { socket, request };
    this.syntheses.add(active);

    return new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      let opened = false;
      const timer = setTimeout(() => {
        fail(new Error("voice service TTS start timed out"));
      }, this.ttsStartTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.syntheses.delete(active);
        socket.removeAllListeners();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(error);
      };
      const matching = (message: Record<string, unknown>): boolean => (
        message.sessionId === request.sessionId && message.generation === request.generation
      );
      const abort = () => {
        if (settled) return;
        if (opened && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "cancel",
            sessionId: request.sessionId,
            generation: request.generation,
          }));
        } else {
          fail(this.abortError());
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        opened = true;
        if (signal.aborted) {
          abort();
          return;
        }
        socket.send(JSON.stringify({ ...request, type: "start" }));
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          if (!started) {
            fail(new Error("voice service TTS sent PCM before started metadata"));
            return;
          }
          handlers.onPcm(Buffer.from(data as Buffer));
          return;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          fail(new Error("voice service TTS returned malformed JSON"));
          return;
        }
        if (!matching(message)) {
          fail(new Error("voice service TTS returned a stale generation"));
          return;
        }
        if (message.type === "started") {
          if (started
            || message.sampleRate !== 24_000
            || message.channels !== 1
            || message.sampleFormat !== "s16le") {
            fail(new Error("voice service TTS returned invalid audio metadata"));
            return;
          }
          started = true;
          clearTimeout(timer);
          handlers.onStarted({
            sessionId: request.sessionId,
            generation: request.generation,
            sampleRate: 24_000,
            channels: 1,
            sampleFormat: "s16le",
          });
          return;
        }
        if (message.type === "finished") {
          if (!started) fail(new Error("voice service TTS finished before start"));
          else finish();
          return;
        }
        if (message.type === "cancelled") {
          fail(this.abortError());
          return;
        }
        if (message.type === "error") {
          fail(new VoiceServiceTtsError(0, typeof message.code === "string" ? message.code : "tts-failed"));
          return;
        }
        fail(new Error("voice service TTS returned an unsupported message"));
      });
      socket.once("error", (error) => fail(error));
      socket.once("close", () => {
        if (!settled) fail(new Error("voice service TTS closed before completion"));
      });
    });
  }

  private abortError(): Error {
    const error = new Error("voice service TTS aborted");
    error.name = "AbortError";
    return error;
  }

  private closeAsr(): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) this.sendControl("stop");
    socket?.close();
    this.socket = null;
    this.current = null;
    this.ready = false;
  }

  close(): void {
    this.closeAsr();
    for (const { socket, request } of this.syntheses) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel", ...request }));
      }
      socket.terminate();
    }
    this.syntheses.clear();
  }
}
