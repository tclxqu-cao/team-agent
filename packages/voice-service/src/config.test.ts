import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVoiceServiceConfig } from "./config";

describe("resolveVoiceServiceConfig", () => {
  it("uses loopback, the stable port, and ignored development model paths", () => {
    expect(resolveVoiceServiceConfig({}, "/repo")).toEqual({
      provider: "local",
      azure: null,
      host: "127.0.0.1",
      port: 17_863,
      token: null,
      asrModelDir: join(
        "/repo",
        "packages/desktop/.agent-data/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
      ),
      kwsModelDir: join(
        "/repo",
        "packages/desktop/.agent-data/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01",
      ),
    });
  });

  it("uses explicit deployment configuration", () => {
    expect(resolveVoiceServiceConfig({
      VOICE_SERVICE_HOST: "0.0.0.0",
      VOICE_SERVICE_PORT: "19000",
      VOICE_SERVICE_TOKEN: "secret",
      VOICE_ASR_MODEL_DIR: "/models/asr",
      VOICE_KWS_MODEL_DIR: "/models/kws",
    }, "/repo")).toEqual({
      provider: "local",
      azure: null,
      host: "0.0.0.0",
      port: 19_000,
      token: "secret",
      asrModelDir: "/models/asr",
      kwsModelDir: "/models/kws",
    });
  });

  it("rejects an unauthenticated non-loopback deployment", () => {
    expect(() => resolveVoiceServiceConfig({
      VOICE_SERVICE_HOST: "0.0.0.0",
    }, "/repo")).toThrow("VOICE_SERVICE_TOKEN");
  });

  it("requires explicit Azure selection and leaves local independent of credentials", () => {
    expect(resolveVoiceServiceConfig({ AZURE_SPEECH_KEY: "unused" }, "/repo").azure).toBeNull();
    expect(() => resolveVoiceServiceConfig({ VOICE_PROVIDER: "other" }, "/repo")).toThrow("VOICE_PROVIDER");
    expect(() => resolveVoiceServiceConfig({ VOICE_PROVIDER: "azure" }, "/repo")).toThrow("AZURE_SPEECH_KEY");
    expect(() => resolveVoiceServiceConfig({ VOICE_PROVIDER: "azure", AZURE_SPEECH_KEY: "private", AZURE_SPEECH_REGION: "https://bad/" }, "/repo")).toThrow("region name");
    const azure = resolveVoiceServiceConfig({ VOICE_PROVIDER: "azure", AZURE_SPEECH_KEY: "private", AZURE_SPEECH_REGION: "eastasia" }, "/repo");
    expect(azure).toMatchObject({ provider: "azure", azure: { region: "eastasia", language: "zh-CN" } });
  });

  it("rejects invalid ports", () => {
    expect(() => resolveVoiceServiceConfig({
      VOICE_SERVICE_PORT: "70000",
    }, "/repo")).toThrow("VOICE_SERVICE_PORT");
  });
});
