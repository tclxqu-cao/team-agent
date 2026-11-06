import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock("../shared-settings", () => ({ sharedSettings: () => ({ read: mocks.read }) }));
vi.mock("@agent/core", () => ({ ModelRegistry: class { createAndRegister = mocks.create; } }));
import { messagingModel } from "./model";
afterEach(() => vi.resetAllMocks());

it("selects native model capacity without a messaging-specific budget or settings field", () => {
  const provider = { streamChat: vi.fn() };
  mocks.create.mockReturnValue(provider);
  mocks.read.mockReturnValue({ profiles: [{ id: "selected", provider: "openai", modelId: "dynamic/alias", apiKey: "fixture", baseUrl: "https://example.com", maxOutputTokens: 256 }], activeProfileId: "selected" });
  expect(messagingModel()).toEqual({ provider, model: "openai/dynamic/alias" });
  expect(mocks.create).toHaveBeenCalledWith("openai", expect.objectContaining({ modelId: "dynamic/alias", maxTokens: null }));
});
