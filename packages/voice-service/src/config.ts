import { join, resolve } from "node:path";

const ASR_MODEL = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
const KWS_MODEL = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";
const TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";

export interface VoiceServiceConfig {
  host: string;
  port: number;
  token: string | null;
  asrModelDir: string;
  kwsModelDir: string;
  ttsPython: string;
  ttsWorkerScript: string;
  ttsModel: string;
  ttsVoice: string;
  ttsStreamingInterval: number;
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
  const ttsStreamingInterval = Number(env.VOICE_TTS_STREAMING_INTERVAL?.trim() || "0.32");
  if (!Number.isFinite(ttsStreamingInterval) || ttsStreamingInterval < 0.08 || ttsStreamingInterval > 1) {
    throw new Error("VOICE_TTS_STREAMING_INTERVAL must be between 0.08 and 1.0 seconds");
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
    ttsPython: env.VOICE_TTS_PYTHON
      ? resolve(env.VOICE_TTS_PYTHON)
      : join(cwd, "packages/desktop/.agent-data/tts-runtime/bin/python"),
    ttsWorkerScript: env.VOICE_TTS_WORKER_SCRIPT
      ? resolve(env.VOICE_TTS_WORKER_SCRIPT)
      : join(cwd, "packages/voice-service/python/mlx_tts_worker.py"),
    ttsModel: env.VOICE_TTS_MODEL?.trim() || TTS_MODEL,
    ttsVoice: env.VOICE_TTS_VOICE?.trim() || "Serena",
    ttsStreamingInterval,
  };
}
