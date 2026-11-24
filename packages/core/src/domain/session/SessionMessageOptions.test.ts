import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_GOAL_STATE, enqueueSessionMessage, normalizeSessionMessageRunOptions, readSessionGoalState } from "./SessionGoals";

describe("durable message model configuration", () => {
  it("copies and restores a message's own model/effort with its queue item", () => {
    const runOptions = { model: { id: "native-model", providerID: "native-provider" }, reasoningEffort: "high" as const };
    const state = enqueueSessionMessage(EMPTY_SESSION_GOAL_STATE, {
      id: "item", sourceMessageId: "source", sessionId: "session", objective: "hello", now: 1, activate: false, messagePayload: { runOptions },
    });
    runOptions.model.id = "mutated-after-enqueue";
    const restored = readSessionGoalState(JSON.parse(JSON.stringify({ goalState: state })));
    expect(restored.queued[0].messagePayload?.runOptions).toEqual({ model: { id: "native-model", providerID: "native-provider" }, reasoningEffort: "high" });
  });
  it("drops untrusted option fields and invalid effort values", () => {
    expect(normalizeSessionMessageRunOptions({ model: { id: "valid", apiKey: "do-not-forward" }, reasoningEffort: "invalid", permissionMode: "full-access" }))
      .toEqual({ model: { id: "valid" } });
    expect(normalizeSessionMessageRunOptions({ model: { id: "" } })).toBeUndefined();
  });
  it("restores attached file bytes with the original queue entry", () => {
    const attachments = [{ name: "sample.csv", mimeType: "text/csv", data: "YSxi" }];
    const state = enqueueSessionMessage(EMPTY_SESSION_GOAL_STATE, {
      id: "item", sourceMessageId: "source", sessionId: "session", objective: "Read CSV", now: 1,
      activate: false, messagePayload: { runOptions: { attachments } },
    });
    const restored = readSessionGoalState(JSON.parse(JSON.stringify({ goalState: state })));
    expect(restored.queued[0].messagePayload?.runOptions?.attachments).toEqual(attachments);
    expect(() => normalizeSessionMessageRunOptions({ attachments: [{ ...attachments[0], name: "../sample.csv" }] })).toThrow("无效的文件附件");
  });
});
