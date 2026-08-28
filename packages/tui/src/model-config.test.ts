import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  endpointModelSelection,
  loadTuiConfig,
  loadTuiModelSelection,
  parseManualModel,
  resolveStartupModel,
  saveTuiConfig,
  saveTuiModelSelection,
  type CustomModelEndpoint,
} from "./model-config.js";

describe("TUI model configuration", () => {
  it("prefers a persisted Desktop profile and falls back to the active profile", () => {
    const profiles = [
      { id: "one", name: "One", provider: "openai", modelId: "gpt-4o", apiKey: "key-1", sourcePath: "/one.db" },
      { id: "two", name: "Two", provider: "anthropic", modelId: "claude-test", apiKey: "key-2", sourcePath: "/two.db" },
    ];
    expect(resolveStartupModel({
      persisted: { source: "desktop", profileId: "two", sourcePath: "/two.db", name: "Two", provider: "anthropic", modelId: "claude-test" },
      profiles,
      activeProfileId: "one",
      env: {},
    })?.modelId).toBe("claude-test");
    expect(resolveStartupModel({
      persisted: { source: "desktop", profileId: "gone", name: "Gone", provider: "openai", modelId: "gone" },
      profiles,
      activeProfileId: "one",
      env: {},
    })?.modelId).toBe("gpt-4o");
  });

  it("persists no API key and uses mode 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-model-"));
    const configPath = path.join(root, "config.json");
    await saveTuiModelSelection(configPath, {
      source: "manual",
      name: "OpenAI",
      provider: "openai",
      modelId: "gpt-4o",
      apiKey: "must-not-be-saved",
    });
    expect(await readFile(configPath, "utf8")).not.toContain("must-not-be-saved");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await loadTuiModelSelection(configPath))?.modelId).toBe("gpt-4o");
  });

  it("persists custom endpoint credentials and restores its default model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-model-custom-"));
    const configPath = path.join(root, "config.json");
    const endpoint: CustomModelEndpoint = {
      id: "custom-one",
      name: "models.example.com",
      baseUrl: "https://models.example.com",
      modelsUrl: "https://models.example.com/v1/models",
      apiKey: "saved-secret",
      defaultModelId: "gpt-two",
      models: ["gpt-one", "gpt-two"],
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    await saveTuiConfig(configPath, {
      version: 2,
      active: {
        source: "custom",
        endpointId: endpoint.id,
        name: endpointModelSelection(endpoint).name,
        provider: "openai",
        modelId: endpoint.defaultModelId,
        baseUrl: endpoint.baseUrl,
      },
      endpoints: [endpoint],
    });

    const config = await loadTuiConfig(configPath);
    expect(await readFile(configPath, "utf8")).toContain("saved-secret");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(resolveStartupModel({
      persisted: config.active,
      endpoints: config.endpoints,
      profiles: [],
      env: {},
    })).toMatchObject({ source: "custom", modelId: "gpt-two", apiKey: "saved-secret" });
  });

  it("parses manual models with environment credentials", () => {
    expect(parseManualModel("deepseek/deepseek-chat", { AGENT_API_KEY: "secret" }).provider).toBe("deepseek");
    expect(() => parseManualModel("invalid", { AGENT_API_KEY: "secret" })).toThrow("用法");
    expect(() => parseManualModel("openai/gpt-4o", {})).toThrow("AGENT_API_KEY");
  });
});
