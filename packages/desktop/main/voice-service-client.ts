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

export class VoiceServiceClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private socket: WebSocket | null = null;
  private current: AsrStart | null = null;
  private ready = false;

  constructor(options: { baseUrl: string; token: string | null }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  startAsr(
    start: AsrStart,
    onEvent: (event: VoiceServiceEvent) => void,
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
        if (!this.ready) fail(new Error("voice service ASR closed before ready"));
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

  async synthesize(
    request: { sessionId: string; generation: number; text: string; voice?: string; speed?: number },
    signal: AbortSignal,
  ): Promise<Buffer> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(new URL("/v1/tts", this.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) detail = body.error;
      } catch { /* non-JSON response */ }
      throw new Error(`voice service TTS failed: ${detail}`);
    }
    if (response.headers.get("x-voice-generation") !== String(request.generation)) {
      throw new Error("voice service TTS returned a stale generation");
    }
    return Buffer.from(await response.arrayBuffer());
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
  }
}
