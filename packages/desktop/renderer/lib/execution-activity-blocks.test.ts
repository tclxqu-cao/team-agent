import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { executionActivityRows, executionSummaryPreview, latestExecutionSummary } from "./execution-activity-blocks";

const tool = (id: string, name = "shell"): ChatMessage => ({ id, role: "assistant", content: "", timestamp: 1,
  toolCalls: [{ id, name, arguments: {}, result: "" }] });
const thought = (id: string, text: string): ChatMessage => ({ id, role: "assistant", content: "", timestamp: 1,
  presentation: { reasoning: [{ sectionIndex: 0, text }] } });
const comment = (id: string, content: string): ChatMessage => ({ id, role: "assistant", content, timestamp: 1,
  presentation: { agentMessagePhase: "commentary" } });

describe("execution activity blocks", () => {
  it("folds mixed operations together and uses only the newest thinking summary", () => {
    const messages = [thought("old", "Previous summary"), tool("read", "read"), tool("cmd"),
      thought("last", "**Awaiting search interface verification**"), tool("edit", "edit")];
    const rows = executionActivityRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "activity", id: "read", summary: "Awaiting search interface verification" });
    if (rows[0].kind === "activity") expect(rows[0].toolCalls.map(call => call.id)).toEqual(["read", "cmd", "edit"]);
    expect(messages[1].toolCalls).toHaveLength(1);
  });

  it("keeps paragraphs in place and starts a fresh block after each one", () => {
    const rows = executionActivityRows([comment("p1", "先核对配置。"), tool("one"), thought("r1", "核对配置入口"),
      tool("two", "Read"), comment("p2", "再检查测试单。"), tool("three")]);
    expect(rows.map(row => row.kind)).toEqual(["commentary", "activity", "commentary", "activity"]);
    expect(rows[1]).toMatchObject({ id: "one", summary: "核对配置入口" });
    expect(rows[3]).toMatchObject({ id: "three", summary: "运行了命令" });
  });

  it("does not repeat visible commentary when historical thinking is unavailable", () => {
    const text = "我把这两项字段删掉，并清理文档和示例中的相关说明。";
    const messages = [comment("paragraph", text), tool("command"), tool("patch", "apply_patch")];
    expect(executionActivityRows(messages)).toEqual([
      { kind: "commentary", id: "paragraph", content: text },
      expect.objectContaining({ kind: "activity", summary: "运行了命令、修改了文件" }),
    ]);
    expect(latestExecutionSummary(messages)).toBeUndefined();
  });

  it("retains the latest persisted thought before its commentary and following operations", () => {
    const thinking = { ...thought("thinking", "ignored"), presentation: { reasoning: [
      { sectionIndex: 0, text: "**Editing document v0.6**" },
      { sectionIndex: 1, text: "**Removing classification tags**" },
    ] } };
    const rows = executionActivityRows([thinking, comment("paragraph", "节点里的审核人字段也删除。"), tool("patch", "apply_patch")]);
    expect(rows[1]).toMatchObject({ kind: "activity", summary: "Removing classification tags" });
  });

  it("does not carry a thought across a completed block or a native input boundary", () => {
    const scoped = (message: ChatMessage, segmentIndex: number): ChatMessage => ({ ...message,
      presentation: { ...message.presentation, executionTrace: { turnId: "turn", segmentIndex } } });
    const rows = executionActivityRows([scoped(thought("thinking", "First task"), 0), scoped(tool("first"), 0),
      scoped(comment("paragraph", "第二个任务。"), 1), scoped(tool("second", "Read"), 1)]);
    expect(rows.at(-1)).toMatchObject({ id: "second", summary: "读取了文件" });
  });

  it("keeps interactive and native segment boundaries", () => {
    const scoped = (id: string, segmentIndex: number): ChatMessage => ({ ...tool(id),
      presentation: { executionTrace: { turnId: "turn", segmentIndex } } });
    const rows = executionActivityRows([scoped("one", 0), scoped("two", 1),
      { id: "user", role: "user", content: "继续", timestamp: 1 }, tool("three")]);
    expect(rows.map(row => row.id)).toEqual(["one", "two", "three"]);
  });

  it("does not create empty rows for thinking-only history or invent a summary", () => {
    expect(executionActivityRows([thought("only", "Thinking")])).toEqual([]);
    expect(executionActivityRows([tool("one")])[0]).toMatchObject({ summary: "运行了命令" });
  });

  it("uses the newest section and cleans summary markup", () => {
    expect(executionSummaryPreview("Keeping default text renderer\n\nChecking runtime compatibility\n\nChecking mobile SSR response"))
      .toBe("Checking mobile SSR response");
    expect(executionSummaryPreview("## Earlier\nDetails\n\n**Latest heading**\nMore details")).toBe("Latest heading");
    expect(latestExecutionSummary([{ ...thought("sections", "ignored"), presentation: { reasoning: [
      { sectionIndex: 2, text: "### Last section `preview`" }, { sectionIndex: 0, text: "First" },
    ] } }])).toBe("Last section preview");
  });
});
