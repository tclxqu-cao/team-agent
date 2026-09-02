import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../../desktop/renderer/styles/composer.css", import.meta.url),
  "utf8",
);
const chatView = readFileSync(
  new URL("../../../desktop/renderer/components/ChatView.tsx", import.meta.url),
  "utf8",
);
const toolCallCard = readFileSync(
  new URL("../../../desktop/renderer/components/ToolCallCard.tsx", import.meta.url),
  "utf8",
);
const globalCss = readFileSync(
  new URL("../../../desktop/renderer/styles/global.css", import.meta.url),
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

describe("shared composer panel layout", () => {
  it("keeps Electron and Web on one multiline input and action toolbar", () => {
    expect(chatView).toContain('className="composer-text-input web-native-composer-textarea"');
    expect(chatView).toContain('className="web-native-composer-toolbar"');
    expect(chatView).toContain('className="web-native-context-control"');
    expect(chatView).toContain('className="web-native-model-control"');
    expect(chatView).not.toContain("粘贴截图");
    expect(chatView).toContain('window.addEventListener("paste", handlePaste)');
    expect(chatView).toContain('type="file"');
    expect(chatView).toContain("fileInputRef.current?.click()");
    expect(chatView).not.toContain("isBrowserRuntime");
    expect(chatView).toContain('placeholder={isReadOnly ? "原客户端使用中，当前只读" : runtimeReady ? (isRunning ? "输入下一条排队消息" : "提出后续修改要求")');

    expect(css).toContain(".web-native-composer-textarea {");
    expect(css).toContain("min-height: 76px");
    expect(css).toContain(".web-native-composer-toolbar {");
    expect(css).toContain(".web-native-model-control {");
  });

  it("preserves queue-send and stop actions while the agent is running", () => {
    expect(chatView).toContain('aria-label={isRunning ? "排队发送" : "发送"}');
    expect(chatView).toContain('className="web-native-stop-button" aria-label="停止生成"');
  });

  it("uses one geometry token for every control in the shared toolbar", () => {
    expect(css).toContain("--web-composer-control-size: 38px");
    expect(css).toContain("width: var(--web-composer-control-size)");
    expect(css).toContain("height: var(--web-composer-control-size)");
    expect(css).toContain("--web-composer-icon-size: 20px");
    expect(css).toContain(".web-native-send-button::before {");
    expect(css).toContain("inset: 2px");
  });
});

describe("Codex-style Web message history", () => {
  it("uses the shared history modifier and semantic tool-call hooks", () => {
    expect(chatView).toContain('className="chat-view chat-view--codex-history"');
    expect(toolCallCard).toContain('className="tool-call-shell"');
    expect(toolCallCard).toContain('className="tool-call-shell__header"');
    expect(toolCallCard).toContain('className="tool-call-shell__body-content"');
  });

  it("loads the shared document history while keeping Web shell rules scoped", () => {
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-avatar");
    expect(globalCss).toContain(".chat-view--codex-history .tool-call-shell__header");
    expect(globalCss).toContain("width: min(100%, 860px)");
    expect(webCss).toContain('body[data-web-shell="1"] .chat-messages');
    expect(webCss).not.toContain('body[data-web-shell="1"] .chat-message-avatar');
  });

  it("uses the shared workspace tone instead of a contrasting page background", () => {
    expect(globalCss).toContain("--bg-workspace: color-mix(in srgb, var(--bg-surface) 64%, var(--bg-deepest))");
    expect(webCss).toContain("background: var(--bg-workspace)");
  });

  it("spans the header across the chat column while content stays proportional", () => {
    expect(webCss).toMatch(
      /body\[data-web-shell="1"\] \.chat-view \{[\s\S]*max-width: none !important;/,
    );
    expect(webCss).toContain("--web-chat-lane-width: 92%");
    expect(webCss).toContain('body[data-web-shell="1"] .chat-messages,');
    expect(webCss).toContain('body[data-web-shell="1"] .chat-input-area {');
    expect(webCss).toContain("width: var(--web-chat-lane-width)");
    expect(webCss).toContain("--web-chat-lane-width: 100%");
  });
});
