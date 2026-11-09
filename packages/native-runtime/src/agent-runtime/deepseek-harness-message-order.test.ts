import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@agent/core";
import { decodeHarnessHistory, harnessMessage } from "./deepseek-harness-codec.js";
import { mergeProjectionMessages } from "./native-runtime-broker.js";

const user = (content = "Question"): Message => ({ role: "user", content });
const thought = (itemId: string, text: string, content = ""): Message => ({
  role: "assistant", content,
  presentation: { reasoning: [{ itemId, sectionIndex: 0, text }] },
});
const call = (id: string) => ({ id, name: "bash", arguments: { command: "pwd" } });
const reasoning = (itemId: string, delta: string): AgentEvent => ({
  type: "reasoning_summary_delta", itemId, sectionIndex: 0, delta,
});
const result = (id: string): AgentEvent => ({
  type: "tool_result", result: { toolCallId: id, content: `${id} completed` },
});
const context = (kind: string, seq = 2): Message => harnessMessage({
  type: "user/message", seq,
  data: { role: "user", content: [{ type: "text", text: kind }], source: { kind } },
})!;

function project(messages: Message[], events: AgentEvent[]): Message[] {
  return mergeProjectionMessages(messages, {
    runId: "run", sessionId: "session", agentType: "deepseek-harness", nativeSessionId: "native",
    input: "Question", permissionMode: "request-approval", controller: "web", status: "active",
    createdAt: 1, terminalAt: null, nextSequence: events.length, goalId: null,
  }, events.map((event, index) => ({ runId: "run", sequence: index + 1, event })));
}

function transcript(messages: Message[]): string[] {
  return messages.flatMap(message => [
    ...(message.presentation?.reasoning ?? []).map(section => section.text),
    ...(message.content ? [message.content] : []),
    ...(message.toolCalls ?? []).map(tool => tool.id),
  ]);
}

describe("Harness transcript recovery order", () => {
  const record = (type: string, seq: number, data: Record<string, unknown>) => ({ type: "event", event: { type, seq, data } });

  it("reconciles the Markdown answer across a same-turn user clarification without repeating it", () => {
    const first = "我把处理流程和检测列表整理成 Markdown。";
    const final = "下面是带完整格式的 Markdown 源码：\n```markdown\n## 一、处理流程\n```";
    const native = decodeHarnessHistory([
      record("turn/start", 7396, { turn: 31 }),
      record("user/message", 7399, { role: "user", content: "Question", source: { kind: "user" } }),
      record("assistant/message", 7401, { turn: 31, step: 1, message: { role: "assistant", content: first } }),
      record("user/message", 7407, { role: "user", content: "包括格式额", source: { kind: "user" } }),
      record("user/message", 7419, { role: "user", content: "sampled time", source: { kind: "time-context" } }),
      record("assistant/message", 7420, { turn: 31, step: 4, message: { role: "assistant", content: final } }),
      record("turn/end", 7423, { turn: 31 }),
      record("turn/start", 7425, { turn: 32 }),
      record("user/message", 7426, { role: "user", content: "Next question", source: { kind: "user" } }),
    ]).messages;
    const events: AgentEvent[] = [{ type: "text_chunk", text: first }, { type: "text_done" },
      { type: "text_chunk", text: final }, { type: "text_done" }];

    expect(project(native, events)).toEqual(native);
    expect(native.find(message => message.content === "包括格式额")?.name).toBe("__native_steered:harness:31:7407");
    expect(native.at(-1)?.name).toBeUndefined();
    expect(project(project(native, events), events)).toEqual(native);
  });

  it("preserves the original boundaries when legacy history has no native turn markers", () => {
    const history = decodeHarnessHistory([
      record("user/message", 1, { role: "user", content: "Question" }),
      record("user/message", 2, { role: "user", content: "Next question" }),
    ]);
    expect(history.messages.every(message => message.name === undefined)).toBe(true);
  });

  it.each(["time-context", "model-selection", "agent-instructions", "runtime-context", "skill-catalog", "user-approval"])(
    "retains %s as injected context rather than a new user turn", kind => {
      expect(context(kind)).toMatchObject({
        role: "user", content: kind, name: `__native_harness_context:${kind}`,
      });
    },
  );

  it("keeps actual and legacy user messages as user-turn boundaries", () => {
    for (const source of [undefined, { kind: "user" }]) {
      const message = harnessMessage({ type: "user/message", seq: 1,
        data: { role: "user", content: "time-context", ...(source ? { source } : {}) } });
      expect(message).toMatchObject({ role: "user", content: "time-context" });
      expect(message?.name).toBeUndefined();
    }
  });

  it("hides injected context while preserving literal user text and same-turn clarifications", () => {
    const input = "Time sampled while preparing turn 24";
    const history = decodeHarnessHistory([
      record("turn/start", 1736, { turn: 24 }),
      record("user/message", 1739, { role: "user", content: input, source: { kind: "user" } }),
      record("user/message", 1740, { role: "user", content: input, source: { kind: "time-context" } }),
      record("user/message", 1741, { role: "user", content: input, source: { kind: "user" } }),
      record("user/message", 1742, { role: "user", content: "selected model", source: { kind: "model-selection" } }),
    ]);
    expect(history.messages).toEqual([
      { role: "user", content: input, historyId: "dsh:1739" },
      { role: "user", content: input, historyId: "dsh:1741", name: "__native_steered:harness:24:1741" },
    ]);
  });

  it.each(["user", "assistant", "tool"])("does not reinterpret plain %s text as reasoning", role => {
    const message = harnessMessage({ type: role === "user" ? "user/message" : `${role}/message`, seq: 1,
      data: role === "user" ? { role, content: "Plain text" } : { message: { role, content: "Plain text" } } });
    expect(message).toMatchObject({ role, content: "Plain text" });
    expect(message?.presentation?.reasoning).toBeUndefined();
  });

  it("reconciles committed thoughts and tools across injected context without duplicating the live turn", () => {
    const tool = call("tool-1");
    const native = [user(), context("time-context"), context("model-selection", 3),
      { ...thought("dsh:4", "Inspect", "Checking"), toolCalls: [tool] },
      { role: "tool" as const, content: "tool-1 completed", toolCallId: tool.id },
      thought("dsh:7", "Verify", "Done"), user("Next question")];
    const events: AgentEvent[] = [reasoning("attempt:1", "Inspect"), { type: "text_chunk", text: "Checking" },
      { type: "text_done" }, { type: "tool_call", toolCall: tool }, result(tool.id),
      reasoning("attempt:2", "Verify"), { type: "text_chunk", text: "Done" }, { type: "text_done" }];
    expect(project(native, events)).toEqual(native);
  });

  it("inserts the screenshot's four completed operations before the later thought and text", () => {
    const native = [user(), context("time-context"), context("model-selection", 3),
      thought("dsh:1209", "Inspect", "Checking"),
      thought("dsh:1223", "Capture headers", "Retrying"),
      thought("dsh:1237", "Check CORS", "Interfaces confirmed"), user("Next question")];
    const events: AgentEvent[] = [
      reasoning("attempt:76", "Inspect"), { type: "text_chunk", text: "Checking" }, { type: "text_done" },
      { type: "tool_call", toolCall: call("operation-10s") }, result("operation-10s"), { type: "text_done" },
      { type: "tool_call", toolCall: call("operation-6s") }, result("operation-6s"),
      reasoning("attempt:78", "Capture headers"), { type: "text_chunk", text: "Retrying" }, { type: "text_done" },
      { type: "tool_call", toolCall: call("operation-7s") }, result("operation-7s"), { type: "text_done" },
      { type: "tool_call", toolCall: call("operation-0s") }, result("operation-0s"),
      reasoning("attempt:80", "Check CORS"), { type: "text_chunk", text: "Interfaces confirmed" }, { type: "text_done" },
    ];
    expect(transcript(project(native, events))).toEqual([
      "Question", "time-context", "model-selection", "Inspect", "Checking", "operation-10s", "operation-6s",
      "Capture headers", "Retrying", "operation-7s", "operation-0s", "Check CORS", "Interfaces confirmed", "Next question",
    ]);
  });

  it("preserves text and tool-result boundaries when no reasoning is emitted", () => {
    const events: AgentEvent[] = [
      { type: "text_chunk", text: "First" }, { type: "text_done" },
      { type: "tool_call", toolCall: call("tool-1") }, result("tool-1"),
      { type: "text_chunk", text: "Second" }, { type: "text_done" },
      { type: "tool_call", toolCall: call("tool-2") }, result("tool-2"),
      { type: "text_chunk", text: "Final" }, { type: "text_done" },
    ];
    const native = [user(), { role: "assistant" as const, content: "First" },
      { role: "assistant" as const, content: "Second" }, { role: "assistant" as const, content: "Final" }];
    const expected = ["Question", "First", "tool-1", "Second", "tool-2", "Final"];
    expect(transcript(project(native, events))).toEqual(expected);
    expect(transcript(project([], events))).toEqual(expected);
  });

  it("keeps a result before the next text while the native transcript is still catching up", () => {
    const tool = call("tool-1");
    const native = [user(), { role: "assistant" as const, content: "First", toolCalls: [tool] },
      { role: "tool" as const, content: "tool-1 completed", toolCallId: tool.id }];
    const merged = project(native, [{ type: "text_chunk", text: "First" }, { type: "text_done" },
      { type: "tool_call", toolCall: tool }, result(tool.id), { type: "text_chunk", text: "Final" }]);
    expect(transcript(merged)).toEqual(["Question", "First", "tool-1", "tool-1 completed", "Final"]);
    expect(project(merged, [{ type: "text_chunk", text: "First" }, { type: "text_done" },
      { type: "tool_call", toolCall: tool }, result(tool.id), { type: "text_chunk", text: "Final" }])).toEqual(merged);
  });

  it("preserves the native codec's tool ownership when context occurs between steps", () => {
    const records = [
      { type: "event", event: { type: "user/message", seq: 1, data: { ...user(), source: { kind: "user" } } } },
      { type: "event", event: { type: "user/message", seq: 2,
        data: { role: "user", content: "sampled time", source: { kind: "time-context" } } } },
      { type: "event", event: { type: "assistant/message", seq: 3, data: { turn: 1, step: 1,
        message: { role: "assistant", content: [{ type: "reasoning", text: "Inspect" }, { type: "text", text: "First" }] } } } },
      { type: "event", event: { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "tool-1", name: "bash", arguments: {} } } },
      { type: "event", event: { type: "tool/result", seq: 5, data: {
        message: { role: "tool", toolCallId: "tool-1", content: "completed" } } } },
      { type: "event", event: { type: "assistant/message", seq: 6, data: { turn: 1, step: 2,
        message: { role: "assistant", content: [{ type: "text", text: "Final" }] } } } },
    ];
    const history = decodeHarnessHistory(records);
    const merged = project(history.messages, [reasoning("live:1", "Inspect"), { type: "text_chunk", text: "First" },
      { type: "text_done" }, { type: "tool_call", toolCall: call("tool-1") }, result("tool-1"),
      { type: "text_chunk", text: "Final" }, { type: "text_done" }]);
    expect(merged).toEqual(history.messages);
  });
});
