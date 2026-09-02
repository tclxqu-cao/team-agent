import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const webMain = readFileSync(
  new URL("../../../webapp/src/main.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../styles/composer.css", import.meta.url), "utf8");

describe("shared Electron and Web composer", () => {
  it("renders one multiline structure without a runtime branch", () => {
    expect(chatView).toContain('className="composer-text-input web-native-composer-textarea"');
    expect(chatView).toContain('className="web-native-composer-toolbar"');
    expect(chatView).not.toContain("isBrowserRuntime");
    expect(chatView).not.toContain("React.RefObject<HTMLInputElement>");
  });

  it("keeps the composer area open to the message canvas", () => {
    const start = chatView.indexOf('className="chat-input-area"');
    const end = chatView.indexOf("{isReadOnly && (", start);
    const inputArea = chatView.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(inputArea).not.toContain("borderTop");
  });

  it("keeps model switching without a redundant dropdown chevron", () => {
    const start = chatView.indexOf('className="web-native-model-control"');
    const end = chatView.indexOf("{isRunning ? (", start);
    const modelControl = chatView.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(modelControl).toContain('aria-label="当前模型"');
    expect(modelControl).toContain("switchActiveProfile(event.target.value)");
    expect(modelControl).not.toContain("<svg");
  });

  it("keeps the model chooser compact and the reasoning trigger icon-only", () => {
    expect(css).toContain("max-width: 180px");
    expect(css).toContain("flex: 1 1 120px");
    expect(css).toContain("font: 500 15px/normal var(--font-body)");
    expect(chatView).not.toContain("web-native-effort-bars");
    expect(css).not.toContain(".web-native-effort-bars");
  });

  it("preserves every composer capability in the shared toolbar", () => {
    expect(chatView).toContain("附件 / 图片");
    expect(chatView).toContain("语音输入");
    expect(chatView).not.toContain("粘贴截图");
    expect(chatView).toContain('window.addEventListener("paste", handlePaste)');
    expect(chatView).toContain('type="file"');
    expect(chatView).toContain("fileInputRef.current?.click()");
    expect(chatView).toContain('className="web-native-context-control"');
    expect(chatView).toContain('className="web-native-model-control"');
    expect(chatView).toContain('className="web-native-stop-button"');
    expect(chatView).toContain('aria-label={isRunning ? "排队发送" : "发送"}');
  });

  it("uses the existing shield as the three-mode Customer Agent permission control", () => {
    expect(chatView).toContain("web-native-permission-button");
    expect(chatView).toContain('aria-label="会话权限模式"');
    expect(chatView).toContain("请求批准");
    expect(chatView).toContain("帮我批准");
    expect(chatView).toContain("完全访问权限");
    expect(chatView).toContain("isNativeRuntime ? (");
    expect(css).toContain(".web-native-permission-menu");
    expect(css).not.toMatch(/\.web-native-runtime-status\s*\{\s*display:\s*none/);
  });

  it("loads one stylesheet in Electron and Web", () => {
    expect(desktopMain).toContain('import "./styles/composer.css"');
    expect(webMain).toContain('import "@desktop/renderer/styles/composer.css"');
    expect(css).toContain(".chat-view--codex-history .composer-input-row");
    expect(css).toContain(".web-native-composer-textarea");
    expect(css).toContain(".web-native-composer-toolbar");
    expect(css).toContain(".web-native-context-control");
    expect(css).toContain(".web-native-model-control");
    expect(css).toContain(".web-native-effort-button");
    expect(css).toContain(".web-native-send-button::before");
  });
});
