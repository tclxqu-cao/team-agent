import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const codexExecutionTrace = readFileSync(new URL("./CodexExecutionTrace.tsx", import.meta.url), "utf8");
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
const ordinarySend = chatView.slice(
  chatView.indexOf("// ── Normal send flow"),
  chatView.indexOf("// ── Voice command from wake word"),
);
const queueStateProjection = chatView.slice(
  chatView.indexOf("const applySessionQueueState = useCallback"),
  chatView.indexOf("// Close the reasoning-effort menu"),
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

  it("restores thinking when the viewed session has an active queued message", () => {
    expect(queueStateProjection).toContain('state.active?.kind === "message"');
    expect(queueStateProjection).toContain("targetSessionId === viewedSessionId");
    expect(queueStateProjection).toContain("beginAgentRunActivity(targetSessionId);");
    expect(queueStateProjection.indexOf("beginAgentRunActivity(targetSessionId);"))
      .toBeLessThan(queueStateProjection.indexOf("reconcileDurableQueuedMessages(current, state)"));
  });

  it("paints an optimistic ordinary message before starting the run", () => {
    expect(chatView).toContain('import { waitForNextPaint } from "../lib/browser-paint"');
    expect(ordinarySend).toContain("afterUserMessageShown: waitForNextPaint");
    expect(ordinarySend.indexOf("afterUserMessageShown: waitForNextPaint"))
      .toBeLessThan(ordinarySend.indexOf("await startRun("));
    expect(ordinarySend).not.toContain("setRunningSession(id);");
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

  it("clears only the completed context-compaction progress before model streaming", () => {
    expect(chatView).toContain("CONTEXT_COMPACTION_PROGRESS_ID");
    expect(chatView).toContain('if (eventSid && !eventSid.startsWith("runtime:"))');
    expect(chatView).toContain("progress.progressId !== CONTEXT_COMPACTION_PROGRESS_ID");
    expect(chatView).toContain("setRuntimeProgress(remaining, eventSid);");
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

  it("folds adjacent same-action tools in both trace and fallback rendering", () => {
    expect(chatView).toContain("coalesceAdjacentToolCallMessages(hideQueuedGoalMessages(");
    expect(chatView).toContain("groupAdjacentToolCallEntries(toolCallEntries)");
    expect(chatView).not.toContain("renderToolCallsIndividually");
    expect(codexExecutionTrace).toContain("groupAdjacentToolCallEntries(toolEntries)");
    expect(codexExecutionTrace).toContain("<ToolCallGroup");
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
    expect(globalCss).toMatch(/\.reasoning-summary\s*\{[^}]*width: 100%;/s);
    expect(globalCss).not.toMatch(/\.reasoning-summary\s*\{[^}]*width: min\(720px, 100%\);/s);
    expect(globalCss).toContain(".tool-call-shell__preview");
    expect(globalCss.match(/place-items: center start/g)).toHaveLength(6);
    expect(globalCss.match(/padding: 5px 0;/g)).toHaveLength(4);
    expect(globalCss).toContain(".codex-execution-trace__load");
    expect(globalCss).not.toContain(".codex-execution-trace__summary");
    expect(globalCss).toContain("padding: 5px 0 !important");
    expect(globalCss).not.toContain(".codex-execution-trace__body");
    expect(globalCss).toContain(".chat-view--codex-history .codex-execution-trace__timeline");
    expect(globalCss).toMatch(/\.chat-view--codex-history \.codex-execution-trace__commentary\s*\{[^}]*padding: 6px 0 7px;[^}]*color: var\(--chat-history-text\);[^}]*font-size: var\(--chat-bubble-font-size\);[^}]*line-height: var\(--chat-bubble-line-height\);/s);
    expect(globalCss).toContain(".reasoning-summary__label");
    expect(globalCss).toContain(".chat-view--codex-history .tool-call-shell__label");
    expect(globalCss).not.toMatch(/\.reasoning-summary__label\s*\{[^}]*transform:/s);
    expect(globalCss).not.toMatch(/\.chat-view--codex-history \.tool-call-shell__label\s*\{[^}]*transform:/s);
    expect(historyRowsCss).not.toContain("transform: translateY(-1px)");
  });

  it("throttles visible Codex trace refreshes independently from core pagination", () => {
    expect(chatView).toContain("CODEX_TRACE_REFRESH_MIN_INTERVAL_MS = 750");
    expect(chatView).toContain("scheduleCodexTraceRefresh(targetSid)");
    expect(chatView).toContain("refreshSignal={chatMsg.executionTrace.turnId === latestCodexExecutionTurnId");
    expect(chatView).toContain('autoLoad={historyWindowMode === "latest" && chatMsg.executionTrace.turnId === latestCodexExecutionTurnId}');
  });

  it("keeps the workspace close to the sidebar surface across skins", () => {
    expect(globalCss).toContain("--bg-workspace: color-mix(in srgb, var(--bg-surface) 64%, var(--bg-deepest))");
    expect(globalCss).toContain("--chat-assistant-fade-end: var(--chat-history-bg)");
    expect(app).toContain('background: "var(--bg-workspace)"');
    expect(chatView).toContain('background: "var(--bg-workspace)"');
  });

  it("slightly lifts pearl history while keeping other skins on their theme tokens", () => {
    expect(globalCss).toContain("--chat-history-bg: var(--bg-workspace)");
    expect(globalCss).toContain("--chat-history-text: var(--text-primary)");
    expect(globalCss).toMatch(/:root:not\(\[data-skin\]\),\s*\[data-skin="pearl"\]\s*\{[^}]*--chat-history-bg: #fdfdff;[^}]*--chat-history-text: #0b1220;/s);
    expect(globalCss).toContain("color: var(--chat-history-text)");
    expect(app).toContain('className="app-chat-surface"');
    expect(app).toContain('background: "var(--chat-history-bg)"');
    expect(chatView).toContain('color: "var(--chat-history-text)"');
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

  it("stops streaming auto-follow after manual upward scrolling and resumes from the arrow", () => {
    expect(chatView).toContain("autoFollowRef.current.onScroll(distanceFromBottom)");
    expect(chatView).toContain("autoFollowRef.current.requestReturn()");
    expect(chatView).toContain("autoFollowRef.current.shouldFollow(mode)");
    expect(chatView).toContain("autoFollowRef.current.reset()");
    expect(chatView).toContain('messagesEndRef.current?.scrollIntoView({ behavior: "auto" })');
  });

  it("loads older history near the top without flashing a fast-request spinner", () => {
    expect(chatView).toContain("container.scrollTop <= 240");
    expect(chatView).toContain('import { SinglePageHistoryPrefetch } from "../lib/session-history-prefetch"');
    expect(chatView).toContain(".prefetch(targetSid, cursor");
    expect(chatView).toContain("historyPrefetchRef.current!.consume(");
    expect(chatView).toContain("prefetchOlderHistory(targetSid, nextCursor)");
    expect(chatView).toContain("resolveOlderHistoryCursor(cursor, detail, olderMessages.length)");
    expect(chatView).toContain("before: cursor");
    expect(chatView).toContain("scrollTop: container.scrollTop");
    expect(chatView).toContain("container.scrollHeight - anchor.scrollHeight");
    expect(chatView).toContain("const slowLoadingTimer = window.setTimeout");
    expect(chatView).toContain("}, 500)");
    expect(chatView).toContain('position: "absolute"');
    expect(chatView).toContain('transform: "translateX(-50%)"');
    expect(chatView).toContain("点击重试");
  });

  it("shows the initial history loader immediately while an uncached session opens", () => {
    expect(chatView).toContain("CODEX_LATEST_HISTORY_PAGE_SIZE = 1");
    expect(selectedSessionLoad).toContain('historyAgentType(targetSid) === "codex"\n                ? CODEX_LATEST_HISTORY_PAGE_SIZE');
    expect(selectedSessionLoad).toContain("setIsInitialHistoryLoading(true);\n      setShowInitialHistoryLoading(true);");
    expect(selectedSessionLoad).toContain("const cachedMessages = getMessagesForSession(targetSid);");
    expect(selectedSessionLoad).toContain("setMessages(cachedMessages, targetSid);");
    expect(selectedSessionLoad).not.toContain("slowLoadingTimer");
    expect(chatView).toContain("messages.length === 0 && isInitialHistoryLoading && showInitialHistoryLoading");
  });

  it("follows selected native history immediately and limits fallback polling", () => {
    expect(chatView).toContain("shouldFollowNativeHistory(sessionSummary, targetSid, runningSessionId)");
    expect(chatView).toContain("shouldRestoreLocalNativeRun(detail)");
    expect(chatView).toContain("isLocallyRunning || isObservedNativeRun(sessionSummary)");
    expect(chatView).not.toContain('sessionSummary?.occupancy === "owned-externally"\n      && sessionSummary.status === "running"');
    expect(chatView).toContain('const shouldPollFallback = sessionSummary?.agentType === "customer-agent"');
    expect(chatView).toContain('|| sessionSummary?.occupancy === "owned-externally"');
    expect(chatView).toContain('|| sessionSummary?.status === "running";');
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

  it("renders completed assistant JSON through the shared structured message boundary", () => {
    expect(chatView).toContain('import StructuredAgentMessage from "./StructuredAgentMessage"');
    expect(chatView).toContain("<StructuredAgentMessage");
    expect(chatView).toContain("complete={!(isRunning && isLastAssistant)}");
    expect(chatView).toContain("renderText={renderMessageContent}");
    expect(chatView).toContain("suggestionsEnabled={canCompose && pendingImageReads === 0}");
    expect(chatView).toContain("onSuggestionSend={handleSuggestionSend}");
    expect(chatView).toContain("renderContent={renderMessageContent}");
    expect(chatView).toContain("createSuggestionSubmission(command)");
    expect(chatView).toContain("createComposerSubmission({");
    expect(chatView).toContain("if (!submission.clearComposer) return;");
    expect(globalCss).toContain(".structured-agent-message");
    expect(globalCss).toContain(".structured-agent-suggestion:focus-visible");
    expect(globalCss).toContain(".structured-agent-suggestion:disabled");
    expect(globalCss).toContain("background: var(--accent-dim)");
    expect(globalCss).toContain("color: var(--text-primary)");
  });

  it("renders local artifact links with a file icon when an opener is injected", () => {
    expect(chatView).toContain("parseRichInlineTokens(text).map");
    expect(chatView).toContain('token.type === "artifact"');
    expect(chatView).toContain("if (!onOpenArtifact)");
    expect(chatView).toContain('className="chat-message-artifact-link"');
    expect(chatView).toContain("<FileText");
    expect(chatView).toContain("onOpenArtifact(token.path)");
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

  it("keeps user send feedback inside the bubble and copy actions outside", () => {
    const bubbleStart = chatView.indexOf('className={`chat-message-bubble chat-message-bubble--');
    const bubbleEnd = chatView.indexOf("{/* Completed assistant footer remains visible", bubbleStart);
    const sendStatusStart = chatView.indexOf("{isUser && chatMsg.sendState && (", bubbleStart);

    expect(bubbleStart).toBeGreaterThan(-1);
    expect(sendStatusStart).toBeGreaterThan(bubbleStart);
    expect(sendStatusStart).toBeLessThan(bubbleEnd);
    expect(chatView).toContain('className="msg-send-status__dots"');
    expect(chatView).toContain('aria-label={chatMsg.sendState === "pending" ? "正在发送" : "发送失败"}');
    expect(chatView).not.toContain("msg-send-status__spinner");
    expect(chatView).toContain("actionPolicy.showCopy && <button");
    expect(chatView).toContain("copyTextToClipboard(msg.content)");
    expect(chatView).toContain('aria-label="复制内容"');
  });

  it("animates send dots without motion for reduced-motion users", () => {
    expect(globalCss).toContain(".msg-send-status__dots > span");
    expect(globalCss).toContain("@keyframes msgSendDotPulse");
    expect(globalCss).toContain("animation-delay: 0.14s");
    expect(globalCss).toContain("animation-delay: 0.28s");
    expect(globalCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.msg-send-status__dots > span\s*\{[\s\S]*animation: none;/);
  });

  it("clears pending send feedback when the run is acknowledged or starts work", () => {
    expect(chatView).toMatch(/\["run_admitted", "thinking", "text_chunk", "reasoning_summary_delta", "runtime_progress", "tool_call", "todo_update", "done"\]\.includes\(event\.type\)[\s\S]*updatePendingSendState\(eventSid\);/);
  });
});
