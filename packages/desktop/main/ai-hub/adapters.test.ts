import { describe, expect, it } from "vitest";
import { ENTER_DISPATCH_SCRIPT, buildAdapterScript, buildFocusInputScript } from "./adapters";
import { runInNewContext } from "node:vm";

// 脚本语法校验：new Function 不执行代码，只解析；IIFE 是表达式，包一层 return 即可
function assertParses(script: string): void {
  expect(() => new Function(`return (${script})`)).not.toThrow();
}

describe("buildAdapterScript", () => {
  it("每个适配器包含对应输入框选择器", () => {
    expect(buildAdapterScript("deepseek", "hi")).toContain("#chat-input");
    expect(buildAdapterScript("chatgpt", "hi")).toContain("#prompt-textarea");
    expect(buildAdapterScript("gemini", "hi")).toContain("rich-textarea");
    expect(buildAdapterScript("grok", "hi")).toContain("textarea[aria-label]");
  });

  it("generic 与未知适配器走最大输入框启发式（无显式选择器）", () => {
    for (const adapter of [undefined, "generic" as const]) {
      const script = buildAdapterScript(adapter, "hi");
      expect(script).not.toContain("INPUT_SELECTORS");
      expect(script).toContain("bestArea");
      assertParses(script);
    }
  });

  it("文本以 JSON 安全嵌入（引号 / 换行 / 尖括号）", () => {
    const tricky = 'say "hi"\nline2\t</script><b> bold </b> \\ backslash';
    const script = buildAdapterScript("deepseek", tricky);
    expect(script).toContain(JSON.stringify(tricky));
    assertParses(script);
  });

  it("有发送按钮的适配器注入按钮选择器，deepseek 仅派发 Enter", () => {
    expect(buildAdapterScript("chatgpt", "hi")).toContain("send-button");
    expect(buildAdapterScript("deepseek", "hi")).toContain("KeyboardEvent");
    expect(buildAdapterScript("deepseek", "hi")).not.toContain("SEND_SELECTORS = [\"");
  });

  it("deepseek 显式选择器 + Enter 兜底，脚本可解析", () => {
    const script = buildAdapterScript("deepseek", "hi");
    expect(script).toContain("INPUT_SELECTORS");
    expect(script).toContain("keydown");
    assertParses(script);
  });

  it("chatgpt 脚本含 native setter 与 insertText 双路径", () => {
    const script = buildAdapterScript("chatgpt", "hi");
    expect(script).toContain("HTMLTextAreaElement");
    expect(script).toContain("execCommand(\"insertText\"");
  });
});

describe("ENTER_DISPATCH_SCRIPT", () => {
  it("向 activeElement 派发 Enter keydown/keyup", () => {
    expect(ENTER_DISPATCH_SCRIPT).toContain("document.activeElement");
    expect(ENTER_DISPATCH_SCRIPT).toContain("keydown");
    expect(ENTER_DISPATCH_SCRIPT).toContain("keyup");
    expect(ENTER_DISPATCH_SCRIPT).toContain("Enter");
    assertParses(ENTER_DISPATCH_SCRIPT);
  });
});

describe("image composer focus", () => {
  it("focuses the site input before native image paste without changing its draft", () => {
    let focused = false;
    const input = { value: "existing draft", getBoundingClientRect: () => ({ width: 400, height: 80 }), focus: () => { focused = true; } };
    const result = runInNewContext(buildFocusInputScript("chatgpt"), {
      document: { querySelector: (selector: string) => selector === "#prompt-textarea" ? input : null },
      getComputedStyle: () => ({ visibility: "visible" }),
    });
    expect(result).toBe(true);
    expect(focused).toBe(true);
    expect(input.value).toBe("existing draft");
  });

  it("rejects missing composers instead of pasting into an unrelated focused element", () => {
    expect(() => runInNewContext(buildFocusInputScript("chatgpt"), {
      document: { querySelector: () => null },
    })).toThrow("input-not-found");
  });
});
