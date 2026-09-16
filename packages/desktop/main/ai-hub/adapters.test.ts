import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_EXTRACT_SCRIPT, CONTINUE_BUTTON_SCRIPT, ENTER_DISPATCH_SCRIPT, SEND_TARGET_SCRIPT, buildAdapterScript, buildContinueProbeScript, buildFillInputScript, buildFocusInputScript, buildSubmissionProbeScript } from "./adapters";
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

  it("所有站点在稳定选择器失效时按输入框几何位置定位右侧发送按钮", () => {
    expect(buildAdapterScript("chatgpt", "hi")).toContain("send-button");
    expect(buildAdapterScript("deepseek", "hi")).toContain("KeyboardEvent");
    expect(buildAdapterScript("deepseek", "hi")).toContain("findNearbyButton");
    expect(buildAdapterScript("deepseek", "hi")).toContain("inputRect.width * 0.55");
    expect(buildAdapterScript("deepseek", "hi")).not.toContain(".b13855df");
    expect(buildAdapterScript("deepseek", "hi")).not.toContain(".d00ed9c9");
  });

  it("deepseek 显式选择器 + Enter 兜底，脚本可解析", () => {
    const script = buildAdapterScript("deepseek", "hi");
    expect(script).toContain("INPUT_SELECTORS");
    expect(script).toContain("keydown");
    assertParses(script);
  });

  it("explicit site selectors remain usable in a clipped background view", () => {
    const script = buildFillInputScript("deepseek", "hi");
    expect(script).toContain('getComputedStyle(el).display !== "none"');
    expect(script).not.toContain("el && visible(el)");
  });

  it("chatgpt 脚本含 native setter 与 insertText 双路径", () => {
    const script = buildAdapterScript("chatgpt", "hi");
    expect(script).toContain("HTMLTextAreaElement");
    expect(script).toContain("execCommand(\"insertText\"");
  });
});

describe("CDP send scripts", () => {
  it("fills and focuses without guessing a send button", () => {
    const script = buildFillInputScript("deepseek", "hello");
    expect(script).toContain("#chat-input");
    expect(script).toContain(JSON.stringify("hello"));
    expect(script).not.toContain("findNearbyButton");
    expect(script).not.toContain("KeyboardEvent");
    expect(script).toContain("inputLength: TEXT.length");
    assertParses(script);
  });

  it("confirms submission by navigation or a new user message", () => {
    const script = buildSubmissionProbeScript({ url: "https://chat.deepseek.com/", userCount: 2, outputCount: 3, inputLength: 10 });
    expect(script).toContain("location.href");
    expect(script).not.toContain(".d00ed9c9");
    expect(script).toContain("startedFromHome");
    expect(script).toContain("userCount > 2");
    expect(script).toContain("outputCount > 3");
    expect(script).toContain("粘贴原文至输入框");
    expect(script).toContain("composerSubmitted");
    expect(script).toContain("attachmentPending");
    expect(script).toContain("!attachmentPending");
    assertParses(script);
  });

  it("finds a semantic send control without hashed classes", () => {
    expect(SEND_TARGET_SCRIPT).toContain("ds-button--primary.ds-button--filled.ds-button--circle");
    expect(SEND_TARGET_SCRIPT).toContain("button[type='submit']");
    expect(SEND_TARGET_SCRIPT).not.toMatch(/_[0-9a-f]{6,}/);
    assertParses(SEND_TARGET_SCRIPT);
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

describe("CONVERSATION_EXTRACT_SCRIPT", () => {
  it("collects all DeepSeek markdown blocks so the final answer follows reasoning", () => {
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain('annotation[encoding="application/x-tex"]');
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain('annotation.closest(".katex, math, mjx-container")');
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain('document.createTextNode("$" + source + "$")');
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("const text = deepSeekText(el)");
    expect(CONVERSATION_EXTRACT_SCRIPT).not.toContain(".d00ed9c9");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("tool-protocol");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("JSON.parse(candidate.text)");
    expect(CONVERSATION_EXTRACT_SCRIPT.indexOf('const ds = document.querySelectorAll(".ds-markdown")'))
      .toBeLessThan(CONVERSATION_EXTRACT_SCRIPT.indexOf("const toolCallCandidates"));
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("textareaCount");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("hasSourceAttachment");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("bodyPreview");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("visibility");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("viewport");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("const LIMIT_CHARS = 100000");
    expect(CONVERSATION_EXTRACT_SCRIPT).not.toContain("const LIMIT_CHARS = 6000");
    assertParses(CONVERSATION_EXTRACT_SCRIPT);
  });
});

describe("CONTINUE_BUTTON_SCRIPT", () => {
  it("只按精确文案匹配可见按钮，不依赖 hash class", () => {
    for (const script of [CONTINUE_BUTTON_SCRIPT, buildContinueProbeScript()]) {
      expect(script).toContain("继续生成");
      expect(script).not.toMatch(/_[0-9a-f]{6,}/);
      assertParses(script);
    }
    expect(CONTINUE_BUTTON_SCRIPT).toContain("button.click()");
    expect(buildContinueProbeScript()).toContain("pendingContinue");
    expect(CONVERSATION_EXTRACT_SCRIPT).toContain("pendingContinue");
  });

  it("点击脚本命中「继续生成」按钮并返回 clicked", () => {
    const clicks: string[] = [];
    const continueButton = {
      innerText: " 继续生成 ",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 80, height: 32 }),
      click: () => clicks.push("continue"),
    };
    const otherButton = { innerText: "开启新对话", getAttribute: () => null, getBoundingClientRect: () => ({ width: 80, height: 32 }), click: () => clicks.push("new-chat") };
    const scope = {
      document: { querySelectorAll: () => [otherButton, continueButton] },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    };
    expect(runInNewContext(CONTINUE_BUTTON_SCRIPT, scope)).toEqual({ clicked: true });
    expect(clicks).toEqual(["continue"]);
  });

  it("探测脚本忽略无关按钮，未命中时 pendingContinue 为 false", () => {
    const scope = {
      document: { querySelectorAll: () => [{ innerText: "继续写一篇", getAttribute: () => null, getBoundingClientRect: () => ({ width: 80, height: 32 }) }] },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    };
    expect(runInNewContext(buildContinueProbeScript(), scope)).toEqual({ pendingContinue: false });
  });

  it("忽略 disabled 和 aria-disabled 的继续按钮", () => {
    const button = (extra: Record<string, unknown>) => ({
      innerText: "继续生成",
      getAttribute: (name: string) => name === "aria-disabled" ? extra.ariaDisabled ?? null : null,
      getBoundingClientRect: () => ({ width: 80, height: 32 }),
      click: vi.fn(),
      ...extra,
    });
    for (const candidate of [button({ disabled: true }), button({ ariaDisabled: "true" })]) {
      const scope = {
        document: { querySelectorAll: () => [candidate] },
        getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      };
      expect(runInNewContext(buildContinueProbeScript(), scope)).toEqual({ pendingContinue: false });
      expect(runInNewContext(CONTINUE_BUTTON_SCRIPT, scope)).toEqual({ clicked: false });
      expect(candidate.click).not.toHaveBeenCalled();
    }
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
