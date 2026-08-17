import { createRequire } from "node:module";
import { resolveVoiceServiceConfig } from "./config.js";
import { MlxTtsEngine } from "./mlx-tts-engine.js";
import { createVoiceServer } from "./server.js";
import { createSherpaEngines, type SherpaAddonLike } from "./sherpa-runtime.js";

async function main(): Promise<void> {
  const config = resolveVoiceServiceConfig(process.env, process.cwd());
  const require = createRequire(import.meta.url);
  const addon = require("sherpa-onnx-node") as SherpaAddonLike;
  const engines = await createSherpaEngines(
    addon,
    config.asrModelDir,
    config.kwsModelDir,
  );
  let tts: MlxTtsEngine | null = null;
  let ttsError: Error | null = null;
  try {
    tts = await MlxTtsEngine.start({
      python: config.ttsPython,
      workerScript: config.ttsWorkerScript,
      model: config.ttsModel,
      voice: config.ttsVoice,
      streamingInterval: config.ttsStreamingInterval,
    });
  } catch (error) {
    ttsError = error instanceof Error ? error : new Error(String(error));
  }
  const service = await createVoiceServer({
    host: config.host,
    port: config.port,
    token: config.token,
    asrEngine: engines.asr,
    kwsEngine: engines.kws ?? undefined,
    ttsEngine: tts ?? undefined,
    ttsError: ttsError?.message ?? null,
  });
  process.stdout.write(`${JSON.stringify({
    type: "ready",
    url: service.httpUrl,
    asr: true,
    kws: engines.kws !== null,
    tts: tts !== null,
    addonVersion: addon.version ?? "unknown",
    kwsError: engines.kwsError?.message ?? null,
    ttsError: ttsError?.message ?? null,
  })}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    await tts?.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

main().catch((error) => {
  process.stderr.write(`voice-service: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
