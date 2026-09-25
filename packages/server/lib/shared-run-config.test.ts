import { describe, expect, it } from "vitest";
import type { SharedSettings } from "./shared-settings";
import { effectiveCapabilityPolicy, resolveSharedRunModel } from "./shared-run-config";

const profile = (
  id: string,
  provider: string,
  modelId: string,
  apiKey = "",
  maxOutputTokens?: number,
  requestTimeoutSeconds?: number,
) => ({
  id,
  name: id,
  provider,
  modelId,
  apiKey,
  baseUrl: "",
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
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
      profile("aihub-deepseek", "aihub", "deepseek", "", 32_768, 600),
    ],
    activeProfileId: "server-default",
    activeAgentIds: [],
    revision: 1,
  };
}

describe("resolveSharedRunModel", () => {
  it("inherits output and timeout limits from the active profile for an ordinary run", () => {
    const configured = settings();
    configured.activeProfileId = "aihub-deepseek";

    expect(resolveSharedRunModel(configured, null, {})).toEqual({
      provider: "aihub",
      modelId: "deepseek",
      apiKey: "",
      baseUrl: "",
      maxOutputTokens: 32_768,
      requestTimeoutSeconds: 600,
    });
  });

  it("lets an agent-bound profile override the active profile", () => {
    const configured = settings();
    configured.activeProfileId = "aihub-deepseek";

    expect(resolveSharedRunModel(
      configured,
      { capabilities: { profileId: "server-default" } },
      {},
    )).toEqual({
      provider: "openai",
      modelId: "server-model",
      apiKey: "server-key",
      baseUrl: "",
      maxOutputTokens: undefined,
      requestTimeoutSeconds: undefined,
    });
  });

  it("lets the conversation selection override agent-bound and active profiles", () => {
    const configured = settings();
    configured.activeProfileId = "server-default";

    expect(resolveSharedRunModel(
      configured,
      { capabilities: { profileId: "server-default" } },
      { profileId: "aihub-deepseek" },
    )).toEqual({
      provider: "aihub",
      modelId: "deepseek",
      apiKey: "",
      baseUrl: "",
      maxOutputTokens: 32_768,
      requestTimeoutSeconds: 600,
    });
  });

  it("keeps the legacy flat settings fallback when no active profile is selected", () => {
    const configured = settings();
    configured.activeProfileId = "";

    expect(resolveSharedRunModel(configured, null, {})).toEqual({
      provider: "openai",
      modelId: "server-model",
      apiKey: "server-key",
      baseUrl: "",
    });
  });

  it("rejects a profile id that is not persisted on the server", () => {
    expect(() => resolveSharedRunModel(settings(), null, { profileId: "missing" }))
      .toThrow("所选模型配置不存在");
  });
});

describe("effectiveCapabilityPolicy", () => {
  it("keeps persisted restrictions when the run omits a policy", () => {
    expect(effectiveCapabilityPolicy(["read_file", "grep"], undefined))
      .toEqual(["read_file", "grep"]);
  });

  it("treats a requested empty list as deny all", () => {
    expect(effectiveCapabilityPolicy([], [])).toEqual([]);
    expect(effectiveCapabilityPolicy(["read_file"], [])).toEqual([]);
  });

  it("intersects a requested policy with a persisted restriction", () => {
    expect(effectiveCapabilityPolicy(["read_file", "grep"], ["grep", "bash"]))
      .toEqual(["grep"]);
  });

  it("uses the request as the full policy when the persisted list is unrestricted", () => {
    expect(effectiveCapabilityPolicy([], ["grep", "grep", " read_file "]))
      .toEqual(["grep", "read_file"]);
  });
});
