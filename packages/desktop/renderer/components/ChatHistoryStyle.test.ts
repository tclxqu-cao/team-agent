import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const toolCallCard = readFileSync(new URL("./ToolCallCard.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
const webCss = readFileSync(new URL("../../../webapp/src/presentation/web.css", import.meta.url), "utf8");
const pendingIndicator = chatView.slice(
  chatView.indexOf("{/* Keep every otherwise-empty running state visible and consistent. */}"),
  chatView.indexOf("{(sessionLoadError || error) && ("),
);
const selectedSessionLoad = chatView.slice(
  chatView.indexOf("const loadGeneration = ++sessionLoadGenerationRef.current;"),
  chatView.indexOf("const refreshLatestHistory = useCallback"),
);
const selectedSessionLoadDependencies = selectedSessionLoad.slice(selectedSessionLoad.lastIndexOf("}, ["));
const abortHandler = chatView.slice(
  chatView.indexOf("const handleAbort = () => {"),
  chatView.indexOf("const handleSteer = async"),
);
const startRun = chatView.slice(
  chatView.indexOf("async function startRun("),
  chatView.indexOf("const handleSend = async"),
);

describe("shared Codex-style message history", () => {
  it("applies one presentation path to every runtime", () => {
    expect(chatView).toContain('className="chat-view chat-view--codex-history"');
    expect(chatView).toContain('className="chat-message-activity"');
    expect(chatView).not.toContain('className={webShell ? "chat-view');
    expect(chatView).not.toContain('className={isNativeRuntime ? "chat-view');
  });

  it("uses the shared brain indicator for every otherwise-empty running state", () => {
    expect(pendingIndicator).toContain("<AgentActivityIndicator");
    expect(pendingIndicator).toContain("{showThinkingFallback && (");
    expect(pendingIndicator).not.toContain("chat-message-avatar");
    expect(pendingIndicator).not.toContain("Robot avatar");
    expect(chatView).toContain("const showThinkingFallback = isRunning");
    expect(chatView).toContain("&& !hasStreamingReasoning");
    expect(chatView).toContain("&& !hasVisibleRunningTool;");
    expect(chatView).toContain("messages.length === 0 && !isRunning");
  });

  it("starts every run with a fresh thinking timer before exposing the running state", () => {
    expect(chatView).toContain("const beginAgentRunActivity = useCallback((targetSessionId: string) => {");
    expect(startRun).toContain("beginAgentRunActivity(targetSessionId);");
    expect(startRun.indexOf("beginAgentRunActivity(targetSessionId);"))
      .toBeLessThan(startRun.indexOf("setRunningSession(targetSessionId);"));
  });

  it("keeps tool execution status inside the tool row", () => {
    expect(chatView).toContain("!areToolCallsComplete(message.toolCalls)");
    expect(toolCallCard).toContain("const actionLabel = toolActivityLabel(first.name) ?? phrase.done");
    expect(toolCallCard).toContain("!isDone && <StatusIcon");
  });

  it("shows one left-aligned thinking status when native progress is available", () => {
    expect(chatView).toContain("&& !globalRuntimeProgress");
    expect(chatView).toContain("{isRunning && globalRuntimeProgress && (");
    expect(chatView).toContain("<RuntimeProgressRow progress={globalRuntimeProgress} startedAt={thinkingStartedAt} />");
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
    expect(globalCss).toContain(".tool-call-shell__disclosure:focus-visible");
    expect(globalCss).not.toContain(".tool-call-shell__disclosure:hover");
  });

  it("folds adjacent repeated tool actions behind a right-facing disclosure", () => {
    expect(chatView).toContain("coalesceAdjacentToolCallMessages(hideQueuedGoalMessages(");
    expect(chatView).toContain("groupAdjacentToolCallEntries(toolCallEntries)");
    expect(chatView).toContain("<ToolCallGroup");
    expect(toolCallCard).toContain('className="tool-call-group__summary"');
    expect(toolCallCard).toContain("aria-expanded={expanded}");
    expect(toolCallCard).toContain('className="tool-call-group__items"');
    expect(toolCallCard).toContain("{expanded && (");
    expect(toolCallCard).toContain('<ChevronRight className="tool-call-group__chevron"');
    expect(toolCallCard).toContain("<ToolActionIcon name={first.name}");
    expect(globalCss).toContain('.tool-call-group__summary[aria-expanded="true"] .tool-call-group__chevron');
    expect(globalCss).toContain("transform: rotate(90deg)");
    expect(globalCss).toContain("padding-left: 0");
    expect(globalCss).toContain("border-left: 0");
  });

  it("renders long assistant messages in full without truncation disclosure", () => {
    expect(chatView).not.toContain("COLLAPSE_THRESHOLD");
    expect(chatView).not.toContain("expandedMessages");
    expect(chatView).not.toContain('className="chat-message-disclosure"');
    expect(chatView).not.toContain("chat-message-long-content");
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

  it("aligns icon-led reasoning and tool rows without a timeline", () => {
    const historyRowsCss = globalCss.slice(
      globalCss.indexOf(".chat-view--codex-history .agent-activity-indicator"),
      globalCss.indexOf(".query-navigation-rail"),
    );

    expect(chatView).not.toContain("isExecutionTraceMessage");
    expect(chatView).not.toContain("chat-message-group--trace");
    expect(chatView).toContain('streaming={isRunning && isLastAssistant && agentActivity === "thinking"}');
    expect(chatView).toContain("messages.filter((message) => !message.isQueued)");
    expect(globalCss).not.toContain(".chat-message-group--trace::before");
    expect(globalCss).not.toContain(".chat-message-group--trace::after");
    expect(globalCss).toContain(".chat-view--codex-history .agent-activity-indicator");
    expect(globalCss).toContain(".reasoning-summary__preview");
    expect(globalCss).toContain(".tool-call-shell__preview");
    expect(globalCss.match(/place-items: center start/g)).toHaveLength(5);
    expect(globalCss.match(/padding: 5px 0;/g)).toHaveLength(3);
    expect(globalCss).toContain("padding: 5px 0 !important");
    expect(globalCss).toContain(".reasoning-summary__label");
    expect(globalCss).toContain(".chat-view--codex-history .tool-call-shell__label");
    expect(globalCss).not.toMatch(/\.reasoning-summary__label\s*\{[^}]*transform:/s);
    expect(globalCss).not.toMatch(/\.chat-view--codex-history \.tool-call-shell__label\s*\{[^}]*transform:/s);
    expect(historyRowsCss).not.toContain("transform: translateY(-1px)");
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
    expect(chatView).toContain('import { SinglePageHistoryPrefetch } from "../lib/session-history-prefetch"');
    expect(chatView).toContain(".prefetch(targetSid, cursor");
    expect(chatView).toContain("historyPrefetchRef.current!.consume(");
    expect(chatView).toContain("prefetchOlderHistory(targetSid, nextCursor)");
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
    expect(chatView).toContain("shouldFollowNativeHistory(sessionSummary, targetSid, runningSessionId)");
    expect(chatView).toContain("shouldRestoreLocalNativeRun(detail)");
    expect(chatView).toContain("isLocallyRunning || isObservedNativeRun(sessionSummary)");
    expect(chatView).not.toContain('sessionSummary?.occupancy === "owned-externally"\n      && sessionSummary.status === "running"');
    expect(chatView).toContain('const shouldPollFallback = sessionSummary?.occupancy === "owned-externally"');
    expect(chatView).toContain("if (shouldPollFallback) startPolling()");
    expect(chatView).toContain("window.setInterval(refresh, 2_000)");
  });

  it("does not let a stale running snapshot restore the stop button after abort", () => {
    expect(selectedSessionLoadDependencies).toContain("selectedSessionId");
    expect(selectedSessionLoadDependencies).not.toContain("runningSessionId");
    expect(abortHandler).toContain("sessionLoadGenerationRef.current += 1;");
    expect(abortHandler.indexOf("sessionLoadGenerationRef.current += 1;"))
      .toBeLessThan(abortHandler.indexOf("setRunningSession(null);"));
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

  it("opens every usable message image in the shared lightbox", () => {
    expect(chatView).toContain('import MessageImageLightbox, { type MessageImagePreview } from "./MessageImageLightbox"');
    expect(chatView).toContain("setPreviewedMessageImage({ src, alt:");
    expect(chatView).toContain("setPreviewedMessageImage({ src: attachment.dataUrl!, alt:");
    expect(chatView).toContain("<MessageImageLightbox");
    expect(chatView).not.toContain('window.open(src, "_blank")');
    expect(chatView).not.toContain('window.open(attachment.dataUrl, "_blank")');
    expect(globalCss).toContain(".chat-message-image-button:focus-visible");
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
    expect(chatView).toContain("parseRichInlineTokens(text).map");
    expect(chatView).toContain('token.type === "artifact"');
    expect(chatView).toContain("if (!isWebShell())");
    expect(chatView).toContain('className="chat-message-artifact-link"');
    expect(chatView).toContain("<FileText");
    expect(chatView).toContain("postWebArtifactOpen(token.path)");
    expect(chatView).toContain("renderInlineLabel(token.label");
    expect(chatView).toContain("打开交付物");
    expect(globalCss).toContain(".chat-message-artifact-link svg");
    expect(globalCss).toContain("overflow-wrap: anywhere");
  });

  it("limits message actions to user copy and completed assistant responses", () => {
    expect(chatView).toContain("messageActionPolicy(renderedMessages, i, isRunning)");
    expect(chatView).toContain("actionPolicy.showCompletion && (");
    expect(chatView).toContain('className="msg-completion-footer"');
    expect(chatView).toContain("已完成");
    expect(chatView).toContain("总耗时 {completionDuration}");
    expect(chatView).toContain('!isWebShell() && actionPolicy.showSpeak && typeof window.agentApi?.ttsSpeak');
    expect(chatView).toContain("actionPolicy.showCopy && <button");
    expect(chatView).toContain("copyTextToClipboard(msg.content)");
    expect(chatView).toContain('aria-label="复制内容"');
    expect(chatView).toContain('aria-label="目标消息"');
    expect(chatView).toContain('chat-message-group--intermediate');
    expect(globalCss).toContain(".chat-view--codex-history .chat-message-group--intermediate");
    expect(globalCss).toContain("margin-bottom: 0 !important");
    expect(globalCss).toContain(".msg-completion-footer");
    expect(globalCss).toContain("min-height: 32px");
    expect(webCss).toContain('body[data-web-shell="1"] .msg-completion-footer');
    expect(globalCss).toContain(".chat-message-content .msg-actions");
    expect(globalCss).toContain(".chat-message-content:hover .msg-actions");
    expect(globalCss).toContain(".chat-message-content:focus-within .msg-actions");
  });
});
