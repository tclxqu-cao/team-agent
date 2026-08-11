import { createRequire } from "node:module";
import { resolveVoiceServiceConfig } from "./config.js";
import { createVoiceServer } from "./server.js";
import { createSherpaEngines, type SherpaAddonLike } from "./sherpa-runtime.js";

async function main(): Promise<void> {
  const config = resolveVoiceServiceConfig(process.env, process.cwd());
  const require = createRequire(import.meta.url);
  const addon = require("sherpa-onnx-node") as SherpaAddonLike;
  const engines = await createSherpaEngines(addon, config.asrModelDir, config.ttsModelDir);
  const service = await createVoiceServer({
    host: config.host,
    port: config.port,
    token: config.token,
    asrEngine: engines.asr,
    ttsEngine: engines.tts ?? undefined,
  });
  process.stdout.write(`${JSON.stringify({
    type: "ready",
    url: service.httpUrl,
    asr: true,
    tts: engines.tts !== null,
    addonVersion: addon.version ?? "unknown",
    ttsError: engines.ttsError?.message ?? null,
  })}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

main().catch((error) => {
  process.stderr.write(`voice-service: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
