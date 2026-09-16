import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedSettingsService, STORED_SECRET } from "./shared-settings";

const directories: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "shared-settings-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("shared customer settings", () => {
  it("imports env once, persists changes across clients and never returns a secret", () => {
    const path = temp(); const first = new SharedSettingsService(path, { AGENT_API_KEY: "test-secret", AGENT_MODEL_ID: "model-before" });
    const view = first.publicView();
    expect(JSON.stringify(view)).not.toContain("test-secret");
    expect(view.apiKey).toBe(STORED_SECRET);
    const saved = first.save({ ...view, profiles: view.profiles.map((p) => ({ ...p, modelId: "model-after", apiKey: "" })) });
    const second = new SharedSettingsService(path, { AGENT_API_KEY: "other-env-secret", AGENT_MODEL_ID: "old-env-model" });
    expect(second.read()).toMatchObject({ modelId: "model-after", apiKey: "test-secret", revision: saved.revision });
  });
  it("rejects stale edits rather than overwriting another client", () => {
    const path = temp(); const a = new SharedSettingsService(path, {}); const b = new SharedSettingsService(path, {});
    const before = a.publicView(); b.save({ maxIterations: 20 });
    expect(() => a.save({ ...before, maxIterations: 30 })).toThrow("另一端");
    expect(a.read().maxIterations).toBe(20);
  });
  it("validates all fields before committing", () => {
    const service = new SharedSettingsService(temp(), {});
    expect(() => service.save({ modelId: "changed", contextWindow: -2 })).toThrow();
    expect(service.read().modelId).not.toBe("changed");
    expect(() => service.save({ activeProfileId: "missing" })).toThrow();
    expect(service.read().revision).toBe(0);
  });
  it("accepts an AI Hub profile without an API key", () => {
    const service = new SharedSettingsService(temp(), {});
    const profile = {
      id: "aihub-deepseek",
      name: "AI Hub DeepSeek",
      provider: "aihub",
      modelId: "deepseek",
      apiKey: "",
      baseUrl: "",
    };

    service.save({ profiles: [profile], activeProfileId: profile.id });

    expect(service.read()).toMatchObject({
      modelProvider: "aihub",
      modelId: "deepseek",
      apiKey: "",
      isConfigured: true,
    });
  });
});
