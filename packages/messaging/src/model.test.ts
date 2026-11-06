import { expect, it } from "vitest";
import { MessagingModelError, modelJson } from "./model";

it("retains complete JSON returned under the model's native budget", async () => {
  const reason = "完整内容".repeat(6000);
  const result = await modelJson(() => ({ model: "provider/dynamic-model", provider: {
    async *streamChat(_messages, options) {
      expect(options).not.toHaveProperty("maxTokens");
      yield { type: "text_chunk" as const, text: JSON.stringify({ reason }) };
    },
  } }), "return JSON", {});
  expect(result.value).toEqual({ reason });
});

it("preserves model and initialization failures as technical errors", async () => {
  await expect(modelJson(() => { throw new Error("credentials unavailable"); }, "", {}))
    .rejects.toBeInstanceOf(MessagingModelError);
  await expect(modelJson(() => ({ model: "provider/model", provider: { async *streamChat() {
    yield { type: "error" as const, message: "输出被截断（max_tokens 限制）" };
  } } }), "", {})).rejects.toMatchObject({ name: "MessagingModelError", message: "输出被截断（max_tokens 限制）" });
});
