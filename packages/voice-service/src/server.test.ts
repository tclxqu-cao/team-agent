import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine";
import { createVoiceServer, type AsrEngineLike, type TtsEngineLike } from "./server";

class RecordingAsrEngine implements AsrEngineLike {
  sessions: Array<{ sessionId: string; generation: number; pcm: number[]; resets: number }> = [];

  createSession(
    sessionId: string,
    generation: number,
    emit: (event: AsrResultEvent) => void,
  ): AsrSession {
    const state = { sessionId, generation, pcm: [] as number[], resets: 0 };
    this.sessions.push(state);
    return {
      acceptPcm: (samples) => {
        state.pcm.push(...samples);
        emit({ type: "partial", sessionId, generation, text: "你好" });
      },
      finish: () => emit({
        type: "final",
        sessionId,
        generation,
        utteranceId: 1,
        text: "你好小智",
      }),
      reset: () => { state.resets += 1; },
      close: () => {},
    };
  }
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
  });
}

function openSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("voice service", () => {
  it("reports ASR readiness without exposing model paths", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: new RecordingAsrEngine() });
    try {
      const response = await fetch(`${service.httpUrl}/health`);
      expect(await response.json()).toEqual({ ready: true, asr: true, tts: false });
    } finally {
      await service.close();
    }
  });

  it("streams binary PCM only after start and maps ASR events to JSON", async () => {
    const engine = new RecordingAsrEngine();
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: engine });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const readyPromise = nextJson(socket);
      socket.send(JSON.stringify({ type: "start", sessionId: "voice-1", generation: 7, sampleRate: 16_000, mode: "wake" }));
      expect(await readyPromise).toEqual({ type: "ready", sessionId: "voice-1", generation: 7 });

      const partialPromise = nextJson(socket);
      socket.send(Buffer.from(new Float32Array([0.25, -0.5]).buffer));
      expect(await partialPromise).toEqual({ type: "partial", sessionId: "voice-1", generation: 7, text: "你好" });
      expect(engine.sessions[0].pcm).toEqual([0.25, -0.5]);

      const finalPromise = nextJson(socket);
      socket.send(JSON.stringify({ type: "finish", sessionId: "voice-1", generation: 7 }));
      expect(await finalPromise).toEqual({ type: "final", sessionId: "voice-1", generation: 7, utteranceId: 1, text: "你好小智" });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("rejects audio before start with a structured error", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: new RecordingAsrEngine() });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const errorPromise = nextJson(socket);
      socket.send(Buffer.from(new Float32Array([0.1]).buffer));
      expect(await errorPromise).toEqual({ type: "error", code: "not-started", message: "ASR start is required before audio" });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("requires the configured Bearer token", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: "secret", asrEngine: new RecordingAsrEngine() });
    try {
      expect((await fetch(`${service.httpUrl}/health`)).status).toBe(401);
      expect((await fetch(`${service.httpUrl}/health`, { headers: { Authorization: "Bearer secret" } })).status).toBe(200);
      await expect(openSocket(`${service.wsUrl}/v1/asr`)).rejects.toThrow(/401/);
      const socket = await openSocket(`${service.wsUrl}/v1/asr`, "secret");
      socket.close();
    } finally {
      await service.close();
    }
  });

  it("returns generated WAV with the request generation", async () => {
    const calls: any[] = [];
    const ttsEngine: TtsEngineLike = {
      async generate(request, signal) {
        calls.push({ request, aborted: signal.aborted });
        return { wav: Buffer.from("RIFF-test"), sampleRate: 24_000 };
      },
    };
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsEngine,
    });
    try {
      const response = await fetch(`${service.httpUrl}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "voice-1", generation: 12, text: "这是回答。" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("x-voice-generation")).toBe("12");
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("RIFF-test");
      expect(calls).toEqual([{
        request: {
          sessionId: "voice-1",
          generation: 12,
          text: "这是回答。",
          voice: "default-zh-female",
          speed: 1,
        },
        aborted: false,
      }]);
    } finally {
      await service.close();
    }
  });

  it("reports invalid and unavailable TTS requests", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: new RecordingAsrEngine() });
    try {
      const invalid = await fetch(`${service.httpUrl}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "voice-1", generation: 1, text: "" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "text must be non-empty" });

      const unavailable = await fetch(`${service.httpUrl}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "voice-1", generation: 1, text: "你好" }),
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: "tts-unavailable" });
    } finally {
      await service.close();
    }
  });
});
