import { describe, expect, it } from "vitest";
import type { SharedSettings } from "./shared-settings";
import { resolveSharedRunModel } from "./shared-run-config";

const profile = (id: string, provider: string, modelId: string, apiKey = "") => ({
  id,
  name: id,
  provider,
  modelId,
  apiKey,
  baseUrl: "",
});

function settings(): SharedSettings {
  return {
    modelProvider: "openai",
    modelId: "server-model",
    apiKey: "server-key",
    baseUrl: "",
    maxIterations: 10,
    contextWindow: 100,
    workingDirectory: "/tmp",
    isConfigured: true,
    profiles: [
      profile("server-default", "openai", "server-model", "server-key"),
      profile("aihub-deepseek", "aihub", "deepseek"),
    ],
    activeProfileId: "server-default",
    activeAgentIds: [],
    revision: 1,
  };
}

describe("resolveSharedRunModel", () => {
  it("lets the conversation selection override an agent-bound profile", () => {
    expect(resolveSharedRunModel(
      settings(),
      { capabilities: { profileId: "server-default" } },
      { profileId: "aihub-deepseek" },
    )).toEqual({ provider: "aihub", modelId: "deepseek", apiKey: "", baseUrl: "" });
  });

  it("rejects a profile id that is not persisted on the server", () => {
    expect(() => resolveSharedRunModel(settings(), null, { profileId: "missing" }))
      .toThrow("所选模型配置不存在");
  });
});
