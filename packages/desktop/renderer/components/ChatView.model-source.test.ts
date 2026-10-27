import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

describe("ChatView model source boundaries", () => {
  it("does not offer CA settings profiles in a native Agent picker", () => {
    expect(chatView.includes("profileModelOptions")).toBe(false);
    expect(chatView.includes("profileProviderMatches")).toBe(false);
    expect(chatView.includes('label="设置里的模型"')).toBe(false);
  });

  it("validates native preferences as soon as the runtime catalog is loaded", () => {
    const catalog = chatView.slice(
      chatView.indexOf("  const availableNativeModelKeys ="),
      chatView.indexOf("  const effectiveNativePref ="),
    );
    expect(catalog).toContain("runtimeModelOptions.map");
    expect(catalog).not.toMatch(/profiles|settingsRevision/);
    expect(catalog).toContain("nativeModelsLoadedAgent === composerAgentType;");
    expect(chatView.includes("const nativeModelPickerReady = runtimeModelOptions.length > 0;")).toBe(true);
  });

  it("does not send an unvalidated saved model while the runtime catalog loads", () => {
    expect(chatView.includes(
      "supportsNativeModelSelection && nativeModelCatalogReady && effectiveNativePref.model?.id",
    )).toBe(true);
  });

  it("keeps the CA profile picker and profile-based run options", () => {
    expect(chatView.includes("value={activeProfileId}")).toBe(true);
    expect(chatView.includes("switchActiveProfile(event.target.value)")).toBe(true);
    expect(chatView.includes("profiles.map((profile)")).toBe(true);
    expect(chatView.includes("activeProfileId ? { profileId: activeProfileId } : undefined")).toBe(true);
  });
});
