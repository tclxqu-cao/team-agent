import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./browser-composer.css", import.meta.url), "utf8");
const chatView = readFileSync(
  new URL("../../../desktop/renderer/components/ChatView.tsx", import.meta.url),
  "utf8",
);
const toolCallCard = readFileSync(
  new URL("../../../desktop/renderer/components/ToolCallCard.tsx", import.meta.url),
  "utf8",
);
const webCss = readFileSync(new URL("./web.css", import.meta.url), "utf8");

const addMenuStart = css.indexOf(".web-native-add-menu {");
const addMenuCss = css.slice(
  addMenuStart,
  css.indexOf(".web-native-send-button {", addMenuStart),
);

describe("browser composer add menu theme", () => {
  it("uses semantic skin tokens instead of fixed light colors", () => {
    expect(addMenuCss).toContain("border: 1px solid var(--border-default)");
    expect(addMenuCss).toContain("background: var(--bg-elevated)");
    expect(addMenuCss).toContain("box-shadow: var(--shadow-md)");
    expect(addMenuCss).toContain("color: var(--text-primary)");
    expect(addMenuCss).toContain("background: var(--control-hover)");
    expect(addMenuCss).toContain("background: var(--control-active)");

    expect(addMenuCss).not.toContain("background: #fff");
    expect(addMenuCss).not.toContain("color: #111827");
    expect(addMenuCss).not.toContain("rgba(17,24,39");
  });
});

describe("browser composer panel layout", () => {
  it("keeps the Web composer as a multiline input over one complete action toolbar", () => {
    expect(chatView).toContain('className="composer-text-input web-native-composer-textarea"');
    expect(chatView).toContain('className="web-native-composer-toolbar"');
    expect(chatView).toContain('className="web-native-context-control"');
    expect(chatView).toContain('className="web-native-model-control"');
    expect(chatView).toContain('placeholder={isConfigured ? (isRunning ? "输入下一条排队消息" : "提出后续修改要求")');

    expect(css).toContain(".web-native-composer-textarea {");
    expect(css).toContain("min-height: 76px");
    expect(css).toContain(".web-native-composer-toolbar {");
    expect(css).toContain(".web-native-model-control {");
  });

  it("preserves queue-send and stop actions while the agent is running", () => {
    expect(chatView).toContain('aria-label={isRunning ? "排队发送" : "发送"}');
    expect(chatView).toContain('className="web-native-stop-button" aria-label="停止生成"');
  });

  it("uses one geometry token for every control in the Web toolbar", () => {
    expect(css).toContain("--web-composer-control-size: 38px");
    expect(css).toContain("width: var(--web-composer-control-size)");
    expect(css).toContain("height: var(--web-composer-control-size)");
    expect(css).toContain("--web-composer-icon-size: 20px");
    expect(css).toContain(".web-native-send-button::before {");
    expect(css).toContain("inset: 2px");
  });
});

describe("Codex-style Web message history", () => {
  it("exposes semantic tool-call hooks without changing the desktop structure", () => {
    expect(toolCallCard).toContain('className="tool-call-shell"');
    expect(toolCallCard).toContain('className="tool-call-shell__header"');
    expect(toolCallCard).toContain('className="tool-call-shell__body-content"');
  });

  it("flattens assistant output and tool calls only inside the Web shell", () => {
    expect(webCss).toContain('body[data-web-shell="1"] .chat-message-avatar');
    expect(webCss).toContain('body[data-web-shell="1"] .chat-message-bubble--assistant {');
    expect(webCss).toContain('body[data-web-shell="1"] .chat-message-bubble--assistant.message-card');
    expect(webCss).toContain('body[data-web-shell="1"] .tool-call-shell__header');
    expect(webCss).toContain("width: min(100%, 860px)");
  });
});
