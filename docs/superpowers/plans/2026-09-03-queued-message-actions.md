# 排队消息操作 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每条排队消息增加尾部图标化的引导、复制、原地编辑和删除操作，并移除冗余标题行。

**Architecture:** `ChatView` 用本地状态管理当前编辑 ID、编辑草稿和短暂复制反馈；实际消息内容继续由 `useAgentStore` 的 `updateMessage`/`setMessages` 更新。所有队列操作在执行前重新读取 store 并确认 `isQueued`，避免修改已被自动消费的消息。

**Tech Stack:** React 18、Zustand、Lucide React、Vitest、Vite WebApp

## Global Constraints

- 只操作 `isQueued` 消息，不改变消息顺序、Agent、图片或其他元数据。
- 顶部“排队消息（N）”整行删除。
- 行尾操作全部使用 Lucide 图标，并提供 `title` 与 `aria-label`。
- 编辑通过回车或勾选保存，`Esc` 取消，空白内容不保存。

---

### Task 1: 排队消息交互与样式

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:1,420,1518,3010`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `updateMessage(id, updater, sessionId?)`、`setMessages(messages, sessionId?)`、`copyTextToClipboard(text)`。
- Produces: `handleCopyQueuedMessage`、`beginQueuedMessageEdit`、`saveQueuedMessageEdit`、`deleteQueuedMessage` 和紧凑行尾图标栏。

- [x] **Step 1: 增加编辑与复制反馈状态**

在 `ChatView` 内增加 `editingQueuedId`、`queuedEditDraft`、`copiedQueuedId`，并在目标消息离开队列时清理编辑态。

- [x] **Step 2: 实现队列操作处理器**

```ts
const saveQueuedMessageEdit = (id: string) => {
  const content = queuedEditDraft.trim();
  const queued = useAgentStore.getState().messages.find((message) => message.id === id && message.isQueued);
  if (!queued || !content) return;
  updateMessage(id, (message) => ({ ...message, content }), viewSessionId || undefined);
};
```

复制调用 `copyTextToClipboard` 并展示短暂勾选；删除使用当前 store 列表过滤目标 ID 后调用 `setMessages`。

- [x] **Step 3: 替换排队栏结构与样式**

删除标题节点和手绘 SVG。普通态展示消息摘要与四个图标；编辑态展示输入框，编辑按钮替换为保存勾选。添加 `.queued-message-list`、`.queued-message-row`、`.queued-message-actions`、`.queued-message-action`、`.queued-message-edit-input`，确保窄屏下正文收缩而图标不换行。

### Task 2: 回归测试

**Files:**
- Modify: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`

**Interfaces:**
- Consumes: `ChatView.tsx` 和 `global.css` 源码。
- Produces: 排队操作契约的静态回归测试。

- [x] **Step 1: 覆盖操作与标题移除**

```ts
expect(chatView).toContain('aria-label="复制排队消息"');
expect(chatView).toContain('aria-label="编辑排队消息"');
expect(chatView).toContain('aria-label="删除排队消息"');
expect(chatView).not.toContain('排队消息（{queuedMsgs.length}）');
```

- [x] **Step 2: 覆盖编辑键盘与响应式样式**

断言回车保存、`Escape` 取消、仅更新 `isQueued` 消息，以及行尾图标组 `flex-shrink: 0`。

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/components/ChatComposerStyle.test.ts packages/webapp/src/presentation/browser-composer.test.ts`

Expected: PASS
