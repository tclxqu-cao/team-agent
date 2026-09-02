import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const toolCallCard = readFileSync(new URL("./ToolCallCard.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
const pendingIndicator = chatView.slice(
  chatView.indexOf("{/* Thinking indicator (no assistant reply yet) */}"),
  chatView.indexOf("{error && ("),
);

describe("shared Codex-style message history", () => {
  it("applies one presentation path to every runtime", () => {
    expect(chatView).toContain('className="chat-view chat-view--codex-history"');
    expect(chatView).toContain('className="chat-message-activity"');
    expect(chatView).not.toContain('className={webShell ? "chat-view');
    expect(chatView).not.toContain('className={isNativeRuntime ? "chat-view');
  });

  it("does not show an avatar before the first assistant reply", () => {
    expect(pendingIndicator).toContain("<AgentActivityIndicator");
    expect(pendingIndicator).toContain('agentActivity !== "tools"');
    expect(pendingIndicator).not.toContain("chat-message-avatar");
    expect(pendingIndicator).not.toContain("Robot avatar");
  });

  it("keeps tool execution status inside the tool row", () => {
    expect(chatView).toMatch(/showThinking = isRunning\s+&& isLastAssistant\s+&& agentActivity !== "tools"\s+&& !globalRuntimeProgress/);
    expect(toolCallCard).toContain("const actionLabel = phrase.done");
    expect(toolCallCard).toContain("!isDone && <StatusIcon");
  });

  it("shows one left-aligned thinking status when native progress is available", () => {
    expect(chatView).toContain("&& !globalRuntimeProgress;");
    expect(chatView).toContain("{isRunning && globalRuntimeProgress && (");
    expect(globalCss).toContain(".chat-view--codex-history .runtime-progress-row:not(.runtime-progress-row--compact)");
    expect(globalCss).toContain("width: min(100%, 860px)");
    expect(globalCss).toContain("margin-left: auto");
    expect(globalCss).toContain("margin-right: auto");
  });

  it("keeps stable hooks for expandable tool details", () => {
    expect(toolCallCard).toContain('className="tool-call-shell"');
    expect(toolCallCard).toContain('className="tool-call-shell__header"');
    expect(toolCallCard).toContain('className="tool-call-shell__body-content"');
    expect(toolCallCard).toContain("{expanded && (");
    expect(toolCallCard).toContain("Collapsed bodies stay unmounted");
  });

  it("folds adjacent repeated tool actions behind a right-facing disclosure", () => {
    expect(chatView).toContain("coalesceAdjacentToolCallMessages(messages)");
    expect(chatView).toContain("groupAdjacentToolCallEntries(toolCallEntries)");
    expect(chatView).toContain("<ToolCallGroup");
    expect(toolCallCard).toContain('className="tool-call-group__summary"');
    expect(toolCallCard).toContain("aria-expanded={expanded}");
    expect(toolCallCard).toContain('className="tool-call-group__items"');
    expect(toolCallCard).toContain("{expanded && (");
    expect(toolCallCard).toContain('d="m9 18 6-6-6-6"');
    expect(globalCss).toContain('.tool-call-group__summary[aria-expanded="true"] .tool-call-group__chevron');
    expect(globalCss).toContain("transform: rotate(90deg)");
    expect(globalCss).toContain("padding-left: 24px");
  });

  it("uses an icon-only chevron for long-message disclosure", () => {
    const disclosure = chatView.indexOf('className="chat-message-disclosure"');
    const body = chatView.indexOf('className={isLong ? "chat-message-long-content__body" : undefined}');
    expect(disclosure).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(disclosure);
    expect(chatView).toContain('className="chat-message-disclosure"');
    expect(chatView).toContain("aria-expanded={isExpanded}");
    expect(chatView).toContain("aria-label={disclosureLabel}");
    expect(chatView).toContain('d="m9 18 6-6-6-6"');
    expect(chatView).not.toContain('{isExpanded ? "收起" : `展开全文');
    expect(globalCss).toContain(".chat-message-disclosure[aria-expanded=\"true\"] svg");
    expect(globalCss).toContain("transform: rotate(90deg)");
    expect(globalCss).toContain(".chat-message-long-content__body");
    expect(globalCss).toContain("padding-right: 28px");
    expect(globalCss).toContain("position: absolute");
    expect(globalCss).toContain("top: 0");
    expect(globalCss).toContain("right: 0");
  });

  it("owns the shared document lane, bubbles, and compact tool rows", () => {
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-group");
    expect(globalCss).toContain("width: min(100%, 860px)");
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-avatar");
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-content--assistant");
    expect(globalCss).toContain("max-width: min(78%, 680px) !important");
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-bubble--assistant.message-card");
    expect(globalCss).toContain(".chat-view--codex-history .tool-call-shell__header");
    expect(globalCss).toContain("min-height: 32px");
    expect(globalCss).toContain("background: transparent !important");
  });

  it("keeps the workspace close to the sidebar surface across skins", () => {
    expect(globalCss).toContain("--bg-workspace: color-mix(in srgb, var(--bg-surface) 64%, var(--bg-deepest))");
    expect(globalCss).toContain("--chat-assistant-fade-end: var(--bg-workspace)");
    expect(app).toContain('background: "var(--bg-workspace)"');
    expect(chatView).toContain('background: "var(--bg-workspace)"');
  });

  it("shows the history scrollbar only while messages are moving", () => {
    expect(chatView).toContain('ref={messagesScrollRef} className="chat-messages" onScroll={handleHistoryScroll}');
    expect(chatView).toContain('container.classList.add("is-scrolling")');
    expect(chatView).toContain('container.classList.remove("is-scrolling")');
    expect(chatView).toContain("}, 700)");
    expect(globalCss).toContain(".chat-messages::-webkit-scrollbar-thumb");
    expect(globalCss).toContain("scrollbar-color: transparent transparent");
    expect(globalCss).toContain(".chat-messages.is-scrolling::-webkit-scrollbar-thumb");
  });

  it("loads older history near the top without flashing a fast-request spinner", () => {
    expect(chatView).toContain("container.scrollTop <= 240");
    expect(chatView).toContain("before: cursor");
    expect(chatView).toContain("scrollTop: container.scrollTop");
    expect(chatView).toContain("container.scrollHeight - anchor.scrollHeight");
    expect(chatView).toContain("const slowLoadingTimer = window.setTimeout");
    expect(chatView).toContain("}, 500)");
    expect(chatView).toContain('position: "absolute"');
    expect(chatView).toContain('transform: "translateX(-50%)"');
    expect(chatView).toContain("点击重试");
  });

  it("follows selected native history immediately and limits fallback polling", () => {
    expect(chatView).toContain("&& runningSessionId !== targetSid");
    expect(chatView).not.toContain('sessionSummary?.occupancy === "owned-externally"\n      && sessionSummary.status === "running"');
    expect(chatView).toContain('const shouldPollFallback = sessionSummary?.occupancy === "owned-externally"');
    expect(chatView).toContain("if (shouldPollFallback) startPolling()");
    expect(chatView).toContain("window.setInterval(refresh, 2_000)");
  });

  it("renders normalized Codex attachments and keeps raw source collapsed", () => {
    expect(chatView).toContain('className="chat-message-attachments"');
    expect(chatView).toContain('className="chat-message-attachment-image"');
    expect(chatView).toContain('className="chat-message-attachment-unavailable"');
    expect(chatView).toContain("图片已失效");
    expect(chatView).toContain('className="chat-message-raw-content"');
    expect(chatView).toContain("<summary>查看原始内容</summary>");
    expect(globalCss).toContain(".chat-message-raw-content pre");
    expect(globalCss).toContain("max-height: 220px");
    expect(globalCss).toContain("overflow: auto");
  });

  it("renders safe Markdown links as clickable Chinese text", () => {
    expect(chatView).toContain('className="chat-message-link"');
    expect(chatView).toContain("href={token.href}");
    expect(chatView).toContain('target="_blank"');
    expect(chatView).toContain('rel="noopener noreferrer"');
    expect(globalCss).toContain(".chat-message-link:hover");
    expect(globalCss).toContain(".chat-message-link:focus-visible");
  });

  it("renders local artifact links with a file icon in the Web shell", () => {
    expect(chatView).toContain('token.type === "artifact"');
    expect(chatView).toContain("if (!isWebShell())");
    expect(chatView).toContain('className="chat-message-artifact-link"');
    expect(chatView).toContain("<FileText");
    expect(chatView).toContain("postWebArtifactOpen(token.path)");
    expect(chatView).toContain("打开交付物");
    expect(globalCss).toContain(".chat-message-artifact-link svg");
    expect(globalCss).toContain("overflow-wrap: anywhere");
  });

  it("limits message actions to user copy and completed assistant responses", () => {
    expect(chatView).toContain("messageActionPolicy(renderedMessages, i, isRunning)");
    expect(chatView).toContain("(actionPolicy.showCopy || actionPolicy.showSpeak)");
    expect(chatView).toContain('actionPolicy.showSpeak && typeof window.agentApi?.ttsSpeak');
    expect(chatView).toContain("actionPolicy.showCopy && <button");
    expect(chatView).toContain("copyTextToClipboard(msg.content)");
    expect(chatView).toContain('aria-label="复制内容"');
    expect(chatView).toContain('chat-message-group--intermediate');
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-group--intermediate");
    expect(globalCss).toContain("margin-bottom: 0 !important");
    expect(globalCss).toContain(".chat-message-content .msg-actions");
    expect(globalCss).toContain(".chat-message-content:hover .msg-actions");
    expect(globalCss).toContain(".chat-message-content:focus-within .msg-actions");
  });
});
