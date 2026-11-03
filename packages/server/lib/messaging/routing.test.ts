import { expect, it, vi } from "vitest";
import { candidateFixture, messageFixture } from "../../../core/src/application/messaging/fixtures";
const fixture = vi.hoisted(() => ({ response: "", options: null as unknown, messages: null as unknown }));
vi.mock("../shared-settings", () => ({ sharedSettings: () => ({ read: () => ({
  profiles: [{ id: "profile", provider: "openai", modelId: "route-model", apiKey: "not-a-real-key" }], activeProfileId: "profile",
}) }) }));
vi.mock("@agent/core", () => ({ ModelRegistry: class {
  createAndRegister() { return { async *streamChat(messages: unknown, options: unknown) {
    fixture.messages = messages; fixture.options = options; yield { type: "text_chunk", text: fixture.response };
  } }; }
} }));
import { modelRoute } from "./routing";
it("uses the system model for a tool-free structured routing decision", async () => {
  fixture.response = JSON.stringify({ action: "dispatch", projectId: "refund", agentType: "codex", reason: "消息指向 Refund" });
  const result = await modelRoute(messageFixture(), candidateFixture);
  expect(result).toMatchObject({ action: "dispatch", projectId: "refund", model: "openai/route-model" });
  expect(fixture.options).not.toHaveProperty("tools");
  expect(JSON.stringify(fixture.messages)).toContain("不可信数据");
  expect(JSON.stringify(fixture.messages)).not.toContain("not-a-real-key");
});
it("returns an inspectable review when no candidates exist and rejects malformed model output", async () => {
  expect(await modelRoute(messageFixture(), [])).toMatchObject({ action: "review" });
  fixture.response = "not JSON";
  await expect(modelRoute(messageFixture(), candidateFixture)).rejects.toThrow();
});
