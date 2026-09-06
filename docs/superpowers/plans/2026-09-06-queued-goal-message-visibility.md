# 排队目标消息可见性 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让等待中的目标只显示在目标队列，并在真正开始执行后才显示为会话用户消息。

**Architecture:** 在 renderer 的队列投影模块增加纯函数，按排队目标的 `sourceMessageId` 过滤会话消息；`ChatView` 在工具消息归并前应用该投影。目标数据仍保留在逐会话 store，提升为活动目标时自然重新显示；删除或入队失败则显式清理对应乐观消息。

**Tech Stack:** React 18、TypeScript、Zustand、Vitest

## Global Constraints

- 目标继续串行执行，不修改 Broker 排序、自动接力或原生运行时协议。
- 活动目标和历史目标消息保持可见，只有 `goalState.queued` 对应的消息被隐藏。
- 普通排队消息继续使用 `isQueued` 与现有排队栏，不受目标过滤影响。
- 所有消息清理必须显式传入目标会话 ID，保持后台会话隔离。

---

### Task 1: 等待目标消息投影

**Files:**
- Modify: `packages/desktop/renderer/lib/queued-message-order.ts:1-104`
- Unit tests: `packages/desktop/renderer/lib/queued-message-order.test.ts`

**Interfaces:**
- Consumes: 会话消息 `T extends { id: string }[]` 与排队目标 `{ sourceMessageId?: string }[]`。
- Produces: `hideQueuedGoalMessages<T>(messages, queuedGoals): T[]`，仅过滤 ID 命中的等待目标消息。

- [x] **Step 1: 实现纯投影函数**

```ts
export function hideQueuedGoalMessages<T extends { id: string }>(
  messages: T[],
  queuedGoals: Array<{ sourceMessageId?: string }>,
): T[] {
  const queuedMessageIds = new Set(
    queuedGoals.flatMap((goal) => goal.sourceMessageId ? [goal.sourceMessageId] : []),
  );
  if (queuedMessageIds.size === 0) return messages;
  return messages.filter((message) => !queuedMessageIds.has(message.id));
}
```

- [x] **Step 2: 添加投影单元测试**

验证排队目标消息被隐藏、活动或历史消息因未传入排队集合而保留、缺少 `sourceMessageId` 时返回原数组，以及普通消息不受影响。

### Task 2: ChatView 展示与失败清理

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:332-485,635-662,2398-2407,2678-2719`
- Unit tests: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`

**Interfaces:**
- Consumes: `hideQueuedGoalMessages(messages, goalState.queued)`、`getMessagesForSession(sessionId)`、`setMessages(messages, sessionId)`。
- Produces: 只含可见历史和活动目标的 `renderedMessages`，以及成功删除排队目标或目标入队失败后的逐会话消息清理。

- [x] **Step 1: 在消息归并前过滤等待目标**

将 `renderedMessages` 的计算移动到 `goalState` 声明之后，并先调用：

```ts
hideQueuedGoalMessages(
  messages.filter((message) => !message.isQueued),
  goalState.queued,
)
```

再交给 `coalesceAdjacentToolCallMessages`，确保状态指示和消息操作策略也不把隐藏目标当作已执行消息。

- [x] **Step 2: 删除排队目标后清理隐藏消息**

取消前保存目标快照。接口成功且该目标原先位于 `goalState.queued` 时，按 `sourceMessageId` 从 `getMessagesForSession(viewSessionId)` 过滤，并通过 `setMessages(next, viewSessionId)` 回写。活动目标停止时不清理消息。

- [x] **Step 3: 目标入队失败时回滚乐观消息**

在 `showUserMessage` 回调中记录实际目标会话 ID；`enqueueSessionGoal` 或建会话后续流程失败时，按 `sourceMessageId` 从该会话清理刚创建的消息，同时保留现有错误提示。

- [x] **Step 4: 添加 ChatView 契约回归**

断言 `ChatView` 导入并在 `renderedMessages` 前使用 `hideQueuedGoalMessages`，删除仅清理排队目标的 `sourceMessageId`，失败路径按显式会话 ID 调用 `setMessages`。

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/queued-message-order.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

Then run: `bunx tsc --noEmit -p packages/desktop/tsconfig.json && bunx tsc --noEmit -p packages/webapp/tsconfig.json`

Expected: both type checks PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
