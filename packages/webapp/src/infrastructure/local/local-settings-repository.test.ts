import { afterEach, describe, expect, it } from "vitest";
import { LocalSettingsRepository } from "./local-settings-repository";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("LocalSettingsRepository", () => {
  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("preserves unlimited and large iteration limits while bounding context", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    const settings = new LocalSettingsRepository();
    settings.save({ maxIterations: 0, contextWindow: 4 });

    expect(settings.getRunLimits()).toEqual({ maxIterations: 0, maxTokens: 8_000 });

    settings.save({ maxIterations: 5_000 });

    expect(settings.getRunLimits()).toEqual({ maxIterations: 5_000, maxTokens: 8_000 });
  });

  it("does not overwrite a server-managed entry after it becomes a local override", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    const settings = new LocalSettingsRepository();
    settings.save({
      profiles: [{
        id: "server-managed",
        name: "本机覆盖",
        provider: "openai",
        modelId: "custom-model",
        apiKey: "local-key",
        baseUrl: "https://example.test/v1",
      }],
      activeProfileId: "server-managed",
    });

    settings.reflectServerModel({ provider: "openai", modelId: "server-model", baseUrl: "http://server/v1" });

    expect(settings.getModelOverride()).toEqual({
      provider: "openai",
      modelId: "custom-model",
      apiKey: "local-key",
      baseUrl: "https://example.test/v1",
    });
  });
});
