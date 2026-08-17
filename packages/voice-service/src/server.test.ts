import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine";
import type { KwsResultEvent, KwsSession } from "./kws-engine";
import { TtsOverloadedError } from "./tts-engine";
import {
  createVoiceServer,
  type AsrEngineLike,
  type KwsEngineLike,
  type TtsEngineLike,
} from "./server";

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

class EmptyAsrEngine implements AsrEngineLike {
  createSession(): AsrSession {
    return {
      acceptPcm: () => {},
      finish: () => {},
      reset: () => {},
      close: () => {},
    };
  }
}

class RecordingKwsEngine implements KwsEngineLike {
  sessions: Array<{ sessionId: string; generation: number; pcm: number[]; resets: number; closed: boolean }> = [];

  createSession(
    sessionId: string,
    generation: number,
    emit: (event: KwsResultEvent) => void,
  ): KwsSession {
    const state = { sessionId, generation, pcm: [] as number[], resets: 0, closed: false };
    this.sessions.push(state);
    return {
      acceptPcm: (samples) => {
        state.pcm.push(...samples);
        emit({ type: "keyword", sessionId, generation, keyword: "小智" });
      },
      reset: () => { state.resets += 1; },
      close: () => { state.closed = true; },
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

function nextMessage(socket: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  return new Promise((resolve) => {
    socket.once("message", (data, isBinary) => resolve({ data: Buffer.from(data as any), binary: isBinary }));
  });
}

class SocketInbox {
  private readonly messages: Array<{ data: Buffer; binary: boolean }> = [];
  private readonly waiters: Array<(message: { data: Buffer; binary: boolean }) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const message = { data: Buffer.from(data as any), binary: isBinary };
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  next(): Promise<{ data: Buffer; binary: boolean }> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
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
      expect(await response.json()).toEqual({
        ready: true,
        asr: true,
        kws: false,
        tts: false,
        ttsLoading: false,
        ttsError: null,
      });
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
      expect(await readyPromise).toEqual({
        type: "ready",
        sessionId: "voice-1",
        generation: 7,
        strategy: "asr",
      });

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

  it("uses KWS for the default wake word then switches later PCM to ASR", async () => {
    const asr = new RecordingAsrEngine();
    const kws = new RecordingKwsEngine();
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: asr,
      kwsEngine: kws,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const readyPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-kws",
        generation: 11,
        sampleRate: 16_000,
        mode: "wake",
        wakeWord: "小智",
      }));
      expect(await readyPromise).toEqual({
        type: "ready",
        sessionId: "voice-kws",
        generation: 11,
        strategy: "kws",
      });

      const keywordPromise = nextJson(socket);
      socket.send(Buffer.from(new Float32Array([0.1]).buffer));
      expect(await keywordPromise).toEqual({
        type: "keyword",
        sessionId: "voice-kws",
        generation: 11,
        keyword: "小智",
      });
      expect(kws.sessions[0].pcm).toEqual(expect.arrayContaining([expect.closeTo(0.1)]));
      expect(kws.sessions[0].closed).toBe(true);
      expect(asr.sessions).toHaveLength(1);
      expect(asr.sessions[0].pcm).toEqual([]);

      const partialPromise = nextJson(socket);
      socket.send(Buffer.from(new Float32Array([0.25]).buffer));
      expect(await partialPromise).toEqual({
        type: "partial",
        sessionId: "voice-kws",
        generation: 11,
        text: "你好",
      });
      expect(asr.sessions[0].pcm).toEqual([0.25]);
    } finally {
      socket.close();
      await service.close();
    }
  });

  it.each([
    ["custom wake word", new RecordingKwsEngine(), "小助手"],
    ["missing KWS", undefined, "小智"],
  ])("uses ASR strategy for %s", async (_name, kwsEngine, wakeWord) => {
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new EmptyAsrEngine(),
      kwsEngine,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const readyPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-fallback",
        generation: 3,
        sampleRate: 16_000,
        mode: "wake",
        wakeWord,
      }));
      expect(await readyPromise).toEqual({
        type: "ready",
        sessionId: "voice-fallback",
        generation: 3,
        strategy: "asr",
      });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("acknowledges finish while still waiting for KWS", async () => {
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new EmptyAsrEngine(),
      kwsEngine: new RecordingKwsEngine(),
    });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const readyPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-kws-finish",
        generation: 4,
        sampleRate: 16_000,
        mode: "wake",
        wakeWord: "小智",
      }));
      await readyPromise;
      const finishedPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "finish",
        sessionId: "voice-kws-finish",
        generation: 4,
      }));
      expect(await finishedPromise).toEqual({
        type: "finished",
        sessionId: "voice-kws-finish",
        generation: 4,
      });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("acknowledges finish even when ASR has no final text", async () => {
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new EmptyAsrEngine(),
    });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const readyPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-empty",
        generation: 8,
        sampleRate: 16_000,
        mode: "dictation",
      }));
      await readyPromise;

      const finishedPromise = nextJson(socket);
      socket.send(JSON.stringify({
        type: "finish",
        sessionId: "voice-empty",
        generation: 8,
      }));

      await expect(finishedPromise).resolves.toEqual({
        type: "finished",
        sessionId: "voice-empty",
        generation: 8,
      });
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
      await expect(openSocket(`${service.wsUrl}/v1/tts/stream`)).rejects.toThrow(/401/);
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
          voice: "Serena",
          speed: 1,
        },
        aborted: false,
      }]);
    } finally {
      await service.close();
    }
  });

  it("returns 429 when TTS capacity is exhausted", async () => {
    const ttsEngine: TtsEngineLike = {
      async generate() {
        throw new TtsOverloadedError();
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
        body: JSON.stringify({ sessionId: "voice-1", generation: 13, text: "你好" }),
      });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "tts-overloaded" });
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

  it("streams generation-scoped PCM after started metadata", async () => {
    const ttsEngine: TtsEngineLike = {
      async stream() {
        return {
          sampleRate: 24_000,
          channels: 1,
          sampleFormat: "s16le",
          chunks: (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield Buffer.from([0, 0, 1, 0]);
          })(),
          completed: Promise.resolve(),
        };
      },
    };
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsEngine,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/tts/stream`);
    const inbox = new SocketInbox(socket);
    try {
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-stream",
        generation: 12,
        text: "这是回答。",
        voice: "Serena",
        speed: 1,
      }));
      const started = await inbox.next();
      expect(started.binary).toBe(false);
      expect(JSON.parse(started.data.toString())).toEqual({
        type: "started",
        sessionId: "voice-stream",
        generation: 12,
        sampleRate: 24_000,
        channels: 1,
        sampleFormat: "s16le",
      });
      const pcm = await inbox.next();
      expect(pcm).toEqual({ data: Buffer.from([0, 0, 1, 0]), binary: true });
      const finished = await inbox.next();
      expect(JSON.parse(finished.data.toString())).toEqual({
        type: "finished",
        sessionId: "voice-stream",
        generation: 12,
      });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("paces PCM so a faster-than-realtime model cannot overflow playback", async () => {
    const chunk = Buffer.alloc(15_360); // 320 ms of 24 kHz mono s16le PCM
    const ttsEngine: TtsEngineLike = {
      async stream() {
        return {
          sampleRate: 24_000,
          channels: 1,
          sampleFormat: "s16le",
          chunks: (async function* () {
            for (let index = 0; index < 4; index += 1) yield chunk;
          })(),
          completed: Promise.resolve(),
        };
      },
    };
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsEngine,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/tts/stream`);
    const inbox = new SocketInbox(socket);
    try {
      socket.send(JSON.stringify({ type: "start", sessionId: "voice-paced", generation: 13, text: "快速模型" }));
      await inbox.next();
      await inbox.next();
      const firstPcmAt = performance.now();
      await inbox.next();
      expect(performance.now() - firstPcmAt).toBeGreaterThanOrEqual(100);
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("cancels only the matching active TTS generation", async () => {
    let aborted = false;
    const ttsEngine: TtsEngineLike = {
      async stream(_request, signal) {
        const completed = new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return {
          sampleRate: 24_000,
          channels: 1,
          sampleFormat: "s16le",
          chunks: (async function* () {
            yield Buffer.from([1, 0]);
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("chunk stream aborted");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            });
          })(),
          completed,
        };
      },
    };
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsEngine,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/tts/stream`);
    const inbox = new SocketInbox(socket);
    try {
      socket.send(JSON.stringify({ type: "start", sessionId: "voice-cancel", generation: 5, text: "长回答" }));
      expect(JSON.parse((await inbox.next()).data.toString()).type).toBe("started");
      await inbox.next();

      socket.send(JSON.stringify({ type: "cancel", sessionId: "voice-cancel", generation: 4 }));
      expect(JSON.parse((await inbox.next()).data.toString())).toMatchObject({
        type: "error",
        code: "invalid-message",
      });
      expect(aborted).toBe(false);

      socket.send(JSON.stringify({ type: "cancel", sessionId: "voice-cancel", generation: 5 }));
      expect(JSON.parse((await inbox.next()).data.toString())).toEqual({
        type: "cancelled",
        sessionId: "voice-cancel",
        generation: 5,
      });
      expect(aborted).toBe(true);
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("rejects malformed TTS controls and reports startup availability", async () => {
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsError: "model missing",
    });
    const socket = await openSocket(`${service.wsUrl}/v1/tts/stream`);
    try {
      let pending = nextMessage(socket);
      socket.send(Buffer.from([1, 2]));
      expect(JSON.parse((await pending).data.toString())).toMatchObject({ code: "invalid-message" });
      pending = nextMessage(socket);
      socket.send(JSON.stringify({ type: "start", sessionId: "voice-err", generation: 1, text: "你好" }));
      expect(JSON.parse((await pending).data.toString())).toMatchObject({
        type: "error",
        code: "tts-unavailable",
        message: "model missing",
        generation: 1,
      });
      expect(await (await fetch(`${service.httpUrl}/health`)).json()).toMatchObject({
        tts: false,
        ttsLoading: false,
        ttsError: "model missing",
      });
    } finally {
      socket.close();
      await service.close();
    }
  });

  it("keeps ASR ready while TTS loads and lets a stream wait for warmup", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const ttsState = { loading: true, error: null, ready } as import("./server").TtsRuntimeState;
    const service = await createVoiceServer({
      host: "127.0.0.1",
      port: 0,
      token: null,
      asrEngine: new RecordingAsrEngine(),
      ttsState,
    });
    const socket = await openSocket(`${service.wsUrl}/v1/tts/stream`);
    const inbox = new SocketInbox(socket);
    try {
      expect(await (await fetch(`${service.httpUrl}/health`)).json()).toMatchObject({
        ready: true,
        asr: true,
        tts: false,
        ttsLoading: true,
      });
      socket.send(JSON.stringify({
        type: "start",
        sessionId: "voice-warmup",
        generation: 21,
        text: "等待模型",
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      ttsState.engine = {
        async stream() {
          return {
            sampleRate: 24_000,
            channels: 1,
            sampleFormat: "s16le",
            chunks: (async function* () { yield Buffer.from([0, 0]); })(),
            completed: Promise.resolve(),
          };
        },
      };
      ttsState.loading = false;
      resolveReady();
      expect(JSON.parse((await inbox.next()).data.toString()).type).toBe("started");
      expect((await inbox.next()).binary).toBe(true);
      expect(JSON.parse((await inbox.next()).data.toString()).type).toBe("finished");
    } finally {
      socket.close();
      await service.close();
    }
  });
});
