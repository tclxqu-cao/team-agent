import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine";
import type { KwsResultEvent, KwsSession } from "./kws-engine";
import {
  createVoiceServer,
  type AsrEngineLike,
  type KwsEngineLike,
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
  it("survives oversized websocket frames", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: new EmptyAsrEngine() });
    const socket = await openSocket(`${service.wsUrl}/v1/asr`);
    try {
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(Buffer.alloc(256 * 1024 + 1));
      expect(await closed).toBe(1009);
      expect((await fetch(`${service.httpUrl}/health`)).status).toBe(200);
    } finally { socket.terminate(); await service.close(); }
  });
  it("reports ASR readiness without exposing model paths", async () => {
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, asrEngine: new RecordingAsrEngine() });
    try {
      const response = await fetch(`${service.httpUrl}/health`);
      expect(await response.json()).toEqual({
        ready: true,
        provider: "local",
        asr: true,
        kws: false,
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
      const socket = await openSocket(`${service.wsUrl}/v1/asr`, "secret");
      socket.close();
    } finally {
      await service.close();
    }
  });
  it("keeps recognition available after removing read-aloud endpoints", async () => {
    const service = await createVoiceServer({
      host: "127.0.0.1", port: 0, token: null, asrEngine: new RecordingAsrEngine(),
    });
    try {
      const response = await fetch(`${service.httpUrl}/v1/tts`, { method: "POST" });
      expect(response.status).toBe(404);
      await expect(openSocket(`${service.wsUrl}/v1/tts/stream`)).rejects.toThrow(/404/);
      const health = await (await fetch(`${service.httpUrl}/health`)).json();
      expect(health).toMatchObject({ ready: true, asr: true });
      expect(health).not.toHaveProperty("tts");
    } finally {
      await service.close();
    }
  });

});
