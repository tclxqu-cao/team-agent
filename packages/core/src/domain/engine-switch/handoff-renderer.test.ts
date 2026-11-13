import { describe, expect, it } from "vitest";
import type { Message } from "@agent/core";
import { renderContextHandoff } from "./handoff-renderer.js";

function user(text: string, index: number): Message {
  return { role: "user", content: text, historyId: `seq-${index}` };
}
function assistant(text: string, index: number): Message {
  return { role: "assistant", content: text, historyId: `seq-${index}` };
}
function toolCall(index: number, name: string, args: Record<string, unknown>, result: string): Message[] {
  const callId = `call-${index}`;
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name, arguments: args }],
      historyId: `seq-${index}`,
    },
    { role: "tool", content: result, toolCallId: callId, name, historyId: `seq-${index}` },
  ];
}

describe("renderContextHandoff", () => {
  it("renders historical context with a non-instruction header", () => {
    const rendered = renderContextHandoff(
      [user("修复登录 bug", 0), assistant("已修复 auth.ts", 1)],
      "codex 会话 s1",
      "claude-code",
    );
    expect(rendered.summaryText).toContain("引擎切换上下文交接");
    expect(rendered.summaryText).toContain("codex 会话 s1");
    expect(rendered.summaryText).toContain("claude-code");
    expect(rendered.summaryText).toContain("不是新的指令");
    expect(rendered.summaryText).toContain("修复登录 bug");
    expect(rendered.summaryText).toContain("已修复 auth.ts");
    expect(rendered.omittedHistoryIds).toEqual([]);
  });

  it("projects tool calls as read-only historical facts, not replays", () => {
    const rendered = renderContextHandoff(
      [
        ...toolCall(2, "bash", { command: "npm test" }, "3 passed, 1 failed: auth.spec"),
        user("继续", 3),
      ],
      "codex 会话 s1",
      "opencode",
    );
    expect(rendered.summaryText).toContain("[历史工具调用 · bash]");
    expect(rendered.summaryText).toContain("[历史工具结果 · bash]");
    expect(rendered.summaryText).toContain("npm test");
    // Plain (non-error) results carry no failure marker.
    expect(rendered.summaryText).not.toContain("（执行失败）");
    expect(rendered.summaryText).toContain("只读记录");
  });

  it("marks failed tool results", () => {
    const failing: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "bash", arguments: {} }],
        historyId: "seq-0",
      },
      { role: "tool", content: "boom", toolCallId: "c1", name: "bash", isError: true, historyId: "seq-0" },
    ];
    const rendered = renderContextHandoff(failing, "codex 会话 s1", "claude-code");
    expect(rendered.summaryText).toContain("（执行失败）");
  });

  it("omits old items when the budget is tight and lists their ids", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(user(`历史消息 ${i} — ${"x".repeat(80)}`, i));
    }
    const rendered = renderContextHandoff(messages, "codex 会话 s1", "opencode", {
      budgetTokens: 400,
      messageMaxChars: 400,
    });
    expect(rendered.omittedHistoryIds.length).toBeGreaterThan(0);
    expect(rendered.omittedHistoryIds.length).toBeLessThan(50);
    // Newest user message always wins a slot.
    expect(rendered.summaryText).toContain("历史消息 49");
    // Preserve the original user constraints as well as recent work.
    expect(rendered.summaryText).toContain("历史消息 0");
    expect(rendered.summaryText).toContain("omitted");
  });

  it("keeps the rendered payload inside the budget and caps the listed omitted ids", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 200; i++) {
      messages.push(user(`历史消息 ${i} — ${"y".repeat(200)}`, i));
    }
    const rendered = renderContextHandoff(messages, "codex 会话 s1", "opencode", {
      budgetTokens: 2_000,
      messageMaxChars: 400,
    });
    // Budget is enforced in rendered text (tokens ≈ bytes/4), leaving headroom for the header.
    expect(Buffer.byteLength(rendered.summaryText, "utf8")).toBeLessThanOrEqual(2_000 * 4 + 2_000);
    // Only the newest 20 ids are enumerated; older ones are summarized as a count.
    expect(rendered.omittedHistoryIds.length).toBeGreaterThan(20);
    expect(rendered.summaryText).toContain("older omitted items are not listed");
    expect(rendered.summaryText).toContain("历史消息 199");
  });

  it("returns an empty handoff for empty history without error", () => {
    const rendered = renderContextHandoff([], "codex 会话 s1", "opencode");
    expect(rendered.summaryText).toBe("");
    expect(rendered.omittedHistoryIds).toEqual([]);
  });

  it("drops system messages", () => {
    const messages: Message[] = [
      { role: "system", content: "内部系统提示", historyId: "seq-0" },
      user("你好", 1),
    ];
    const rendered = renderContextHandoff(messages, "codex 会话 s1", "opencode");
    expect(rendered.summaryText).not.toContain("内部系统提示");
    expect(rendered.summaryText).toContain("你好");
  });

  it("preserves original order, full long text, and image-only messages", () => {
    const text = "需求".repeat(1_000) + "TAIL_CONSTRAINT";
    const image = "data:image/png;base64,aGVsbG8=";
    const rendered = renderContextHandoff([
      user(text, 0), assistant("first reply", 1), user("follow up", 2), assistant("last reply", 3),
      { role: "user", content: "", images: [image], historyId: "image" },
    ], "A", "B", { historyFile: "/full/history.json" });
    expect(rendered.summaryText).toContain("TAIL_CONSTRAINT");
    expect(rendered.summaryText.indexOf("follow up")).toBeLessThan(rendered.summaryText.indexOf("last reply"));
    expect(rendered.includedHistoryIds).toContain("image");
    expect(rendered.images).toEqual([image]);
  });

  it("omits oversized items whole and names the full-history recovery file", () => {
    const rendered = renderContextHandoff([user("x".repeat(40_000) + "TAIL", 0), user("latest", 1)], "A", "B",
      { budgetTokens: 1_024, historyFile: "/full/history.json" });
    expect(rendered.omittedHistoryIds).toEqual(["seq-0"]);
    expect(rendered.summaryText).not.toContain("xxxx");
    expect(rendered.summaryText).toContain("/full/history.json");
    expect(rendered.tokenEstimate).toBeLessThanOrEqual(1_024);
  });
});
