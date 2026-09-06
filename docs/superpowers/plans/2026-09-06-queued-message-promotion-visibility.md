# 普通排队消息自动接力可见性 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通排队消息在 Broker 严格串行提升后立即离开排队列表并进入消息区，且 transcript 对账后不重复。

**Architecture:** Broker 继续独占排队项的提升和启动。renderer 的纯投影函数接收完整 `SessionGoalState`，把 active 普通消息转为非排队用户消息，把 queued 普通消息保留为排队消息，并用稳定来源 ID 或最新用户边界与 transcript 对齐。

**Tech Stack:** TypeScript、React、Zustand、Vitest

## Global Constraints

- 当前 run 产生终态且 adapter 清理完成前，下一条普通消息必须保持 queued。
- renderer 不得调用持久 active 项的启动接口，Broker 是唯一调度者。
- active 普通消息不显示在目标队列，也不继续显示在排队列表。
- transcript 到达后，同一条用户消息只能保留一份。
- 不修改 Broker FIFO、目标优先级、原生运行时协议、停止语义或目标模式展示。

---

### Task 1: 完整状态的普通消息投影

**Files:**
- Modify: `packages/desktop/renderer/lib/queued-message-order.ts:10-94`
- Unit tests: `packages/desktop/renderer/lib/queued-message-order.test.ts`

**Interfaces:**
- Consumes: `MixedQueueStateLike<T extends DurableQueueItemLike>`、当前 `DurableQueuedMessageLike[]`。
- Produces: `reconcileDurableQueuedMessages<T>(messages: T[], state: MixedQueueStateLike<DurableQueueItemLike>): T[]`。

- [x] **Step 1: 保持消息最小接口**

继续使用 `DurableQueuedMessageLike` 的 `id`、`role`、`content`、`isQueued` 和 `queueItemId` 字段，不把 Broker 内部 run 标记扩散为必需契约。

- [x] **Step 2: 投影 active 和 queued 普通消息**

```ts
const activeItem = state.active?.kind === "message" ? state.active : null;
const queuedItems = state.queued.filter((item) => item.kind === "message");
```

先保留所有非排队历史。active 项优先按 `sourceMessageId` 或 `queueItemId` 复用本地消息；若页面刚刷新，则只按最新的 `role=user` 且正文相同的 transcript 用户边界对齐。只有都未命中时才创建新的非排队用户消息。queued 项继续生成 `isQueued: true` 消息。

- [x] **Step 3: 覆盖投影边界测试**

增加以下断言：queued 消息保持排队；提升为 active 后复用 `sourceMessageId`、附件和时间戳并设置 `isQueued: false`；已有原生 transcript 用户消息时不追加重复项；active 消息结束后仍作为普通历史保留。

### Task 2: ChatView 接入完整 Broker 状态

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:655-666,1304-1312,1436-1447`
- Unit tests: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `reconcileDurableQueuedMessages(messages, state)`。
- Produces: 所有初始加载、实时队列更新和历史刷新路径一致的 active/queued 消息展示。

- [x] **Step 1: 更新三个队列对账入口**

```ts
reconcileDurableQueuedMessages(currentMessages, state)
```

`applySessionQueueState`、初始详情恢复和最新历史刷新都传入完整 `SessionGoalState`，不再只传 `queuedSessionMessages(state)`。

- [x] **Step 2: 保持调度调用不变**

确认 `ChatView` 没有为 `queueItemId` 对应的 active 消息调用 `startRun()`；`scheduleQueuedMessageAfterTerminal` 仍仅处理旧版纯本地队列，持久队列由 Broker 自动启动。

- [x] **Step 3: 更新静态契约测试**

断言 `ChatView` 将完整 `state` 或 `detail.goalState` 交给投影函数，同时保留 `message.isQueued && !message.queueItemId` 的本地队列启动保护。

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/queued-message-order.test.ts packages/desktop/renderer/lib/session-history.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

Run: `bunx tsc --noEmit -p packages/desktop/tsconfig.json && bun run --cwd packages/webapp typecheck && git diff --check`

Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
