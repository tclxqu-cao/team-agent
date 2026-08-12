import { join, resolve } from "node:path";

const ASR_MODEL = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
const KWS_MODEL = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";
const TTS_MODEL = "vits-melo-tts-zh_en";

export interface VoiceServiceConfig {
  host: string;
  port: number;
  token: string | null;
  asrModelDir: string;
  kwsModelDir: string;
  ttsModelDir: string;
}

export function resolveVoiceServiceConfig(
  env: Record<string, string | undefined>,
  cwd: string,
): VoiceServiceConfig {
  const host = env.VOICE_SERVICE_HOST?.trim() || "127.0.0.1";
  const portText = env.VOICE_SERVICE_PORT?.trim() || "17863";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("VOICE_SERVICE_PORT must be an integer from 1 to 65535");
  }
  const token = env.VOICE_SERVICE_TOKEN?.trim() || null;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !token) {
    throw new Error("VOICE_SERVICE_TOKEN is required for non-loopback hosts");
  }
  return {
    host,
    port,
    token,
    asrModelDir: env.VOICE_ASR_MODEL_DIR
      ? resolve(env.VOICE_ASR_MODEL_DIR)
      : join(cwd, "packages/desktop/.agent-data/asr-models", ASR_MODEL),
    kwsModelDir: env.VOICE_KWS_MODEL_DIR
      ? resolve(env.VOICE_KWS_MODEL_DIR)
      : join(cwd, "packages/desktop/.agent-data/kws-models", KWS_MODEL),
    ttsModelDir: env.VOICE_TTS_MODEL_DIR
      ? resolve(env.VOICE_TTS_MODEL_DIR)
      : join(cwd, "packages/desktop/.agent-data/tts-models", TTS_MODEL),
  };
}
