import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveVoiceServiceConfig } from "../dist/config.js";
import { createSherpaEngines } from "../dist/sherpa-runtime.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { asrModelDir, kwsModelDir } = resolveVoiceServiceConfig({
  VOICE_ASR_MODEL_DIR: process.env.VOICE_ASR_MODEL_DIR,
  VOICE_KWS_MODEL_DIR: process.env.VOICE_KWS_MODEL_DIR,
}, repoRoot);

try {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const { asr, kws, kwsError } = await createSherpaEngines(sherpa, asrModelDir, kwsModelDir);
  const silence = new Float32Array(16_000);

  const transcription = asr.createSession("model-check", 0, () => {});
  transcription.acceptPcm(silence);
  await transcription.finish();
  transcription.close();
  console.log(`ASR loaded and processed audio: ${asrModelDir}`);

  if (!kws) throw new Error("Could not load KWS model", { cause: kwsError });
  const wakeWord = kws.createSession("model-check", 0, () => {});
  wakeWord.acceptPcm(silence);
  wakeWord.close();
  console.log(`KWS loaded and processed audio: ${kwsModelDir}`);
} catch (error) {
  console.error("Voice model verification failed:", error);
  process.exitCode = 1;
}
