# Queued Message Active Feedback Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a server-promoted queued message visibly pending and show thinking activity while its successor run is active.

**Architecture:** Extend the durable queue projection so an active message owns `sendState: "pending"`. In `ChatView`, adopt the active message snapshot as viewed-session thinking state while preserving existing event-driven terminal cleanup.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Bun

## Global Constraints

- Only active queue items with `kind === "message"` affect chat pending and thinking state.
- Keep activity scoped to the currently viewed session.
- Do not change server queue ordering, admission, execution, persistence, or message content.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Active Message Projection

**Files:**
- Modify: `packages/desktop/renderer/lib/queued-message-order.ts:84`
- Unit tests: `packages/desktop/renderer/lib/queued-message-order.test.ts:104`

**Interfaces:**
- Consumes: `reconcileDurableQueuedMessages(messages, state)` and `state.active.kind`.
- Produces: an active user message with `isQueued: false` and `sendState: "pending"`.

- [x] **Step 1: Update focused queue projection expectations**

Add assertions that active messages receive `sendState: "pending"` while queued messages do not.

- [x] **Step 2: Implement active pending projection**

Add `sendState: "pending"` to the active message object built by `reconcileDurableQueuedMessages`; leave queued-item projection unchanged.

### Task 2: Viewed Session Thinking Recovery

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:750`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts:46`

**Interfaces:**
- Consumes: `SessionGoalState.active`, `selectedSessionIdRef`, `sessionIdRef`, and the existing agent activity refs/setters.
- Produces: viewed-session `thinking` activity and a fresh `thinkingStartedAt` when an active durable message is observed.

- [x] **Step 1: Add a focused activity contract test**

Assert that `applySessionQueueState` recognizes `state.active?.kind === "message"`, scopes the update to the viewed session, and starts thinking before reconciling messages.

- [x] **Step 2: Adopt active message activity in ChatView**

Inside `applySessionQueueState`, when the target is the viewed session and the active item is a message, set `thinkingSessionIdRef`, `agentActivityRef`, `thinkingStartedAt`, and `agentActivity` to the same values used by `beginAgentRunActivity`.

- [x] **Step 3: Preserve terminal cleanup**

Keep the existing `done`, `error`, and `turn_aborted` handlers unchanged so they remain responsible for clearing running and activity state.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/queued-message-order.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp build`

Expected: PASS

If a test or build fails, fix the implementation or test and rerun the failing command until it passes. Report the commands and results in the final response.
