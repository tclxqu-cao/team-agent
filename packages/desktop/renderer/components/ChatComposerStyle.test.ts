import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const webMain = readFileSync(
  new URL("../../../webapp/src/main.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../styles/composer.css", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

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
    const start = chatView.indexOf("web-native-model-control");
    const end = chatView.indexOf("{isLocallyRunning ? (", start);
    const modelControl = chatView.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(modelControl).toContain('aria-label="当前模型"');
    expect(modelControl).toContain("switchActiveProfile(event.target.value)");
    // Native runtimes get a brand icon + agent name beside the picker, never a chevron icon.
    expect(modelControl).toContain("<AgentBrandIcon");
    expect(modelControl).toContain("web-native-model-agent-name");
    expect(modelControl).not.toContain("ChevronDown");
  });

  it("keeps the model chooser compact and the reasoning trigger icon-only", () => {
    expect(css).toContain("max-width: 180px");
    expect(css).toContain("flex: 1 1 120px");
    expect(css).toContain("font: 500 15px/normal var(--font-body)");
    expect(css).toContain(".web-native-model-agent");
    expect(css).not.toContain("web-native-effort-bars");
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
    expect(chatView).toContain("web-native-model-control");
    expect(chatView).toContain('className="web-native-stop-button"');
    expect(chatView).toContain('aria-label={shouldQueueMessage ? "排队发送" : "发送"}');
  });

  it("groups queued messages and keeps drag, copy, edit, delete, and steer icon actions", () => {
    const start = chatView.indexOf("{/* Queued messages — shown above input when agent is running */}");
    const end = chatView.indexOf("{/* Input box */}", start);
    const queue = chatView.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(queue).not.toContain("排队消息（{queuedMsgs.length}）");
    expect(queue).toContain("<GripVertical");
    expect(queue).toContain("<CornerUpRight");
    expect(queue).toContain("<Copy");
    expect(queue).toContain("<Pencil");
    expect(queue).toContain("<Trash2");
    expect(queue).toContain('aria-label="复制排队消息"');
    expect(queue).toContain('"编辑排队消息"');
    expect(queue).toContain('aria-label="删除排队消息"');
    expect(queue).toContain('aria-label="拖动调整排队顺序"');
    expect(queue).toContain("reorderQueuedMessage(draggedQueuedMessageId, msg.id)");
    expect(queue).not.toContain("<svg");
    expect(globalCss).toMatch(/\.queued-message-list\s*\{[\s\S]*?gap:\s*0;/);
    expect(globalCss).toMatch(/\.queued-message-list\s*\{[\s\S]*?border:\s*1px solid var\(--border-subtle\);/);
    expect(globalCss).toMatch(/\.queued-message-list\s*\{[\s\S]*?margin-bottom:\s*0;/);
    expect(globalCss).toMatch(/\.queued-message-list\s*\{[\s\S]*?border-bottom:\s*0;/);
    expect(globalCss).toContain(".queued-message-list + .composer-anchor .composer-shell");
    expect(globalCss).toMatch(/\.queued-message-row\s*\{[\s\S]*?border:\s*0;/);
  });

  it("moves accepted submissions into the queue and restores only failed persistence", () => {
    const start = chatView.indexOf("// ── Queue message if agent is running");
    const end = chatView.indexOf("// ── Normal send flow", start);
    const queueBranch = chatView.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(queueBranch).toContain("clearSessionDraft(queuedSessionId)");
    expect(queueBranch).toContain("imageDraftCoordinator.clear(queuedSessionId)");
    expect(queueBranch).toContain("writeSessionDraft(queuedSessionId, finalMsg)");
    expect(queueBranch).toContain("imageDraftCoordinator.save(queuedSessionId, imagesToSend ?? [])");
    expect(queueBranch).toContain("(selectedSessionIdRef.current || sessionIdRef.current) === queuedSessionId");
    expect(queueBranch.indexOf("clearSubmittedComposer()"))
      .toBeLessThan(queueBranch.indexOf("enqueueSessionMessage(queuedSessionId"));
  });

  it("drains queued chat after goal-managed or refresh-recovered runs finish", () => {
    const drainStart = chatView.indexOf("const scheduleQueuedMessageAfterTerminal");
    const drainEnd = chatView.indexOf("const handleEvent", drainStart);
    const drain = chatView.slice(drainStart, drainEnd);

    expect(chatView).toContain("scheduleQueuedMessageAfterTerminal(eventSid)");
    expect(chatView).toContain("managedRunSessionsRef.current.has(eventSid)");
    expect(chatView).toContain("await window.agentApi?.getSessionGoals(targetSessionId)");
    expect(chatView).toContain("if (state?.active)");
    expect(chatView).toContain("void startRun(nextQueued, targetSessionId)");
    expect(chatView).toContain("message.isQueued && !message.queueItemId");
    expect(chatView).toContain("enqueueSessionMessage");
    expect(chatView).toContain("sessionSummary?.messageQueueVersion === 1");
    expect(chatView).toContain("reconcileDurableQueuedMessages(current, state)");
    expect(chatView).toContain("reconcileDurableQueuedMessages(baseMessages, detail.goalState)");
    expect(chatView).toContain("reconcileDurableQueuedMessages(mergedHistory, detail.goalState)");
    expect(chatView).not.toContain("reconcileDurableQueuedMessages(current, queuedSessionMessages(state))");
    expect(chatView).not.toContain("state.active?.sourceMessageId === sourceMessageId");
    expect(chatView).toContain('event.messagePhase === "commentary"');
    expect(chatView).toContain("applyCodexExecutionEvent(event.turnId");
    expect(chatView).toContain("steerSessionMessage(targetSessionId, msg.queueItemId)");
    expect(drain).toMatch(
      /if \(state\?\.active\) \{[\s\S]*?abortRef\.current = false;[\s\S]*?setError\(null\);[\s\S]*?if \(abortRef\.current\) return;/,
    );
  });

  it("keeps waiting goals out of chat history until they become active", () => {
    expect(chatView).toContain("hideQueuedGoalMessages(");
    expect(chatView).toContain("goalState.queued,");
    expect(chatView).toContain("const queuedGoal = goalState.queued.find");
    expect(chatView).toContain("message.id !== queuedGoal.sourceMessageId");
    expect(chatView).toContain("let optimisticSessionId: string | null = null");
    expect(chatView).toContain("getMessagesForSession(optimisticSessionId)");
    expect(chatView).toContain("message.id !== sourceMessageId");
    expect(chatView).toContain("setMessages(");
  });

  it("edits only queued content in place and supports keyboard save or cancel", () => {
    expect(chatView).toContain("item.isQueued ? { ...item, content } : item");
    expect(chatView).toContain('event.key === "Enter" && !event.nativeEvent.isComposing');
    expect(chatView).toContain('event.key === "Escape"');
    expect(chatView).toContain("currentMessages.filter((item) => item.id !== msgId)");
    expect(chatView).toContain("copyTextToClipboard(message.content)");
    expect(globalCss).toContain(".queued-message-actions");
    expect(globalCss).toContain("flex-shrink: 0");
    expect(globalCss).toContain(".queued-message-edit-input");
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
