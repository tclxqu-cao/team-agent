import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTuiModelSelection, parseManualModel, resolveStartupModel, saveTuiModelSelection } from "./model-config.js";

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

  it("parses manual models with environment credentials", () => {
    expect(parseManualModel("deepseek/deepseek-chat", { AGENT_API_KEY: "secret" }).provider).toBe("deepseek");
    expect(() => parseManualModel("invalid", { AGENT_API_KEY: "secret" })).toThrow("用法");
    expect(() => parseManualModel("openai/gpt-4o", {})).toThrow("AGENT_API_KEY");
  });
});
