import { describe, expect, it } from "vitest";
import { scheduledMessageContent } from "./scheduled-message";

const envelope = (body: string) => `<heartbeat>\n<automation_id>codex</automation_id>\n<current_time_iso>2026-10-12T13:16:58.148Z</current_time_iso>\n<instructions>\n${body}\n</instructions>\n</heartbeat>`;
describe("scheduled message display", () => {
  it("shows only instructions and preserves their paragraphs and literal markup", () => {
    const body = '继续当前任务。\n\n检查 <status> 和 /tmp/plan.md，保留 &lt;example&gt;。';
    expect(scheduledMessageContent(envelope(body))).toBe(body);
  });
  it("accepts CRLF and metadata after instructions", () => {
    expect(scheduledMessageContent(envelope("执行任务").replaceAll("\n", "\r\n"))).toBe("执行任务");
    expect(scheduledMessageContent('<heartbeat><instructions>执行</instructions><automation_id>job</automation_id></heartbeat>')).toBe("执行");
  });
  it("leaves ordinary text, code examples, unknown envelopes and truncated messages unchanged", () => {
    for (const text of ["正常消息", `示例：${envelope("任务")}`, `\`\`\`xml\n${envelope("任务")}\n\`\`\``, envelope("任务").slice(0,-12), '<heartbeat><instructions>任务</instructions></heartbeat>', envelope("任务").replace('<automation_id>', '<unknown>')]) {
      expect(scheduledMessageContent(text)).toBeNull();
    }
  });
});
