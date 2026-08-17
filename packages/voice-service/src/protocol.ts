export type VoiceMode = "wake" | "dictation" | "barge-in";

export interface AsrStartControl {
  type: "start";
  sessionId: string;
  generation: number;
  sampleRate: 16_000;
  mode: VoiceMode;
  wakeWord?: string;
}

export interface AsrSimpleControl {
  type: "reset" | "finish" | "stop";
  sessionId: string;
  generation: number;
}

export type AsrControl = AsrStartControl | AsrSimpleControl;

export interface TtsRequest {
  sessionId: string;
  generation: number;
  text: string;
  voice: string;
  speed: number;
}

export interface TtsStreamStart extends TtsRequest {
  type: "start";
}

export interface TtsStreamCancel {
  type: "cancel";
  sessionId: string;
  generation: number;
}

export type TtsStreamControl = TtsStreamStart | TtsStreamCancel;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("sessionId must be a non-empty string");
  }
  return value;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("generation must be a non-negative integer");
  }
  return value as number;
}

export function parseAsrControl(raw: string): AsrControl {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("message must be valid JSON");
  }
  const input = record(value);
  const type = input.type;
  const id = sessionId(input.sessionId);
  const gen = generation(input.generation);
  if (type === "reset" || type === "finish" || type === "stop") {
    return { type, sessionId: id, generation: gen };
  }
  if (type !== "start") throw new Error("type is not supported");
  if (input.sampleRate !== 16_000) throw new Error("sampleRate must be 16000");
  if (input.mode !== "wake" && input.mode !== "dictation" && input.mode !== "barge-in") {
    throw new Error("mode is not supported");
  }
  if (input.wakeWord !== undefined && (typeof input.wakeWord !== "string" || !input.wakeWord.trim())) {
    throw new Error("wakeWord must be a non-empty string");
  }
  return {
    type,
    sessionId: id,
    generation: gen,
    sampleRate: 16_000,
    mode: input.mode,
    ...(typeof input.wakeWord === "string" ? { wakeWord: input.wakeWord.trim() } : {}),
  };
}

export function parseTtsRequest(raw: unknown): TtsRequest {
  const input = record(raw);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error("text must be non-empty");
  if (text.length > 600) throw new Error("text must contain at most 600 characters");
  const speed = input.speed === undefined ? 1 : input.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error("speed must be between 0.5 and 2.0");
  }
  const voice = input.voice === undefined ? "Serena" : input.voice;
  if (typeof voice !== "string" || !voice.trim()) throw new Error("voice must be non-empty");
  return {
    sessionId: sessionId(input.sessionId),
    generation: generation(input.generation),
    text,
    voice,
    speed,
  };
}

export function parseTtsStreamControl(raw: string): TtsStreamControl {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("message must be valid JSON");
  }
  const input = record(value);
  if (input.type === "cancel") {
    return {
      type: "cancel",
      sessionId: sessionId(input.sessionId),
      generation: generation(input.generation),
    };
  }
  if (input.type !== "start") throw new Error("type is not supported");
  return { type: "start", ...parseTtsRequest(input) };
}
