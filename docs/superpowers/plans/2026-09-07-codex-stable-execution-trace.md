# Codex Stable Execution Trace Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Codex core messages visually stable and avoid loading any reasoning/tool history until the user expands one turn's compact execution disclosure.

**Architecture:** Codex core messages carry a native turn locator and become a display timeline where each user turn owns one synthetic execution-trace message. Opening history performs only the core request. Expanding one disclosure requests `view=trace&turnId=...` for the current revision, hydrates only that native turn, and renders its reasoning/tools inside the disclosure. Page-wide trace remains compatible but is no longer called automatically.

**Tech Stack:** React 18, TypeScript, Vitest, existing `ReasoningSummary`, `ToolCallCard`, and `ToolCallGroup` components.

## Global Constraints

- Apply grouping only when `history.delivery` is `core`.
- Keep normal assistant text outside the execution disclosure.
- Keep the disclosure collapsed by default and do not request trace until expansion.
- Preserve tool-result lazy loading, file preview, runtime progress, and native subagent rendering.
- Do not change Claude Code, OpenCode, or Customer Agent history behavior.

---

### Task 1: Per-Turn Trace Protocol

**Files:**
- Modify: `packages/core/src/domain/session/entities.ts`
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/server/app/api/sessions/[id]/route.ts`
- Modify: `packages/server/app/api/native-runtime.test.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: `SessionHistoryQuery { view: "trace", revision, turnId }`.
- Produces: core user messages with `presentation.executionTrace.turnId` and one-turn execution-only trace responses.

- [x] **Step 1: Add the turn locator contract**

Add `turnId?: string` to `SessionHistoryQuery` and `executionTrace?: { turnId: string }` to `MessagePresentation`.

- [x] **Step 2: Mark Codex core user messages**

During summary conversion, attach the owning native turn ID to each real user message. Keep revision computation based on the same role/content skeleton.

- [x] **Step 3: Serve one-turn traces**

For `view=trace&turnId=...`, validate the supplied revision, reject unknown turns, call `hydrateTurnRange(turnId, turnId)`, convert that turn with existing reasoning/argument bounds and lazy result locators, and return only reasoning/tool carrier messages. Preserve existing page-wide trace behavior when `turnId` is absent.

- [x] **Step 4: Forward the query across Desktop and Web**

Serialize `turnId` through preload types, renderer globals, Web HTTP gateway, and the session route.

- [x] **Step 5: Cover protocol behavior**

Test core turn locators, one-turn hydration excluding adjacent turns, duplicate user/final text omission, stale revision rejection, and Web/Desktop query forwarding.

### Task 2: Codex History Display Projection

**Files:**
- Create: `packages/desktop/renderer/lib/codex-execution-trace.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Unit tests: `packages/desktop/renderer/lib/codex-execution-trace.test.ts`

**Interfaces:**
- Consumes: restored core `ChatMessage[]` and `history.revision`.
- Produces: `groupCodexExecutionTrace(messages, revision)` and `restoreCodexExecutionTrace(detail)`.

- [x] **Step 1: Add the display-only execution trace type**

```ts
interface CodexExecutionTrace {
  turnId: string;
  revision: string;
}
```

- [x] **Step 2: Group each Codex turn**

```ts
groupCodexExecutionTrace(messages, revision)
```

Insert a stable synthetic assistant message directly after each user message carrying `presentation.executionTrace.turnId`. Derive its ID from the native turn ID so a revision refresh updates the locator without remounting the row; the component clears any loaded detail when the revision changes.

- [x] **Step 3: Apply grouping during history restoration**

Call the grouping function only for `delivery=core`. Add `restoreCodexExecutionTrace(detail)` to restore tool results and return execution-only `ChatMessage[]` without inserting another synthetic row. Exclude synthetic execution messages from core assistant reconciliation.

- [x] **Step 4: Cover projection behavior**

Test stable core disclosure identity, plain-result stability, execution-only restoration, and unchanged non-Codex/legacy history.

### Task 3: Lazy Execution Disclosure

**Files:**
- Create: `packages/desktop/renderer/components/CodexExecutionTrace.tsx`
- Create: `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `ChatMessage.executionTrace`, a one-turn trace loader, runtime progress, native subagents, workspace path, and lazy tool-result callback.
- Produces: one fixed-height collapsed row and an on-demand detailed execution timeline.

- [x] **Step 1: Render idle, loading, loaded, and error summaries**

```tsx
<button aria-expanded={expanded}>
  {loading ? "执行过程加载中" : messages ? `执行过程 · ${itemCount} 项` : "执行过程"}
</button>
```

- [x] **Step 2: Load only on first expansion**

On the first closed-to-open transition, request the current session with `{ view: "trace", revision, turnId }`. Deduplicate the promise by session/revision/turn and retain successful details while the disclosure remains mounted. Render an inline retry state on failure.

- [x] **Step 3: Reuse existing detailed renderers**

Render reasoning with `ReasoningSummary`; render grouped and individual tools with `ToolCallGroup` and `ToolCallCard`, preserving lazy results and previews.

- [x] **Step 4: Stop automatic page trace loading**

Change `loadProgressiveSessionHistoryPage` so Codex commits the core page and returns. In `ChatView`, provide the per-turn loader and render synthetic execution messages before ordinary assistant rendering.

- [x] **Step 5: Add restrained stable styling**

Use one compact row, existing neutral/accent tokens, a rotating loader only while the selected turn is loading, and no layout-changing default expansion.

- [x] **Step 6: Cover component states**

Test that mount makes no request, first expansion loads once, repeated expansion reuses the result, failure retries, loaded item count is shown, and disclosure labels are accessible.

### Task 4: Live Execution Projection

**Files:**
- Modify: `packages/core/src/domain/agent/entities.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/lib/codex-execution-trace.ts`
- Modify: `packages/desktop/renderer/lib/codex-execution-trace.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/CodexExecutionTrace.tsx`
- Modify: `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`

**Interfaces:**
- Consumes: Codex `reasoning_summary_delta`, `tool_call`, and `tool_result` SSE events carrying `turnId`.
- Produces: `applyCodexLiveExecutionEvent(messages, turnId, event)` and a per-turn `executionTrace.liveMessages` projection rendered inside the disclosure.

- [x] **Step 1: Attach the native turn ID to live execution events**

Add optional `turnId` metadata to execution-related `AgentEvent` variants and populate it from the Codex notification or active turn map.

- [x] **Step 2: Project live items into the owning disclosure**

Implement `applyCodexLiveExecutionEvent()` so the first event inserts a stable trace row after the latest active user message, subsequent events update the same row, and repeated tool IDs or reasoning sections are merged without duplication.

- [x] **Step 3: Route Codex live events away from top-level tool cards**

In `ChatView`, use the live trace projection only when the event belongs to Codex and carries a `turnId`; retain the existing top-level path for every other runtime and legacy event.

- [x] **Step 4: Merge live data with lazy history state**

Keep disclosure expansion stable when a revision refresh preserves the same `turnId`, render `liveMessages` immediately without a history request, and merge later snapshot data by reasoning item/tool ID.

- [x] **Step 5: Cover real-time, refresh, fallback, and deduplication behavior**

Test turn ID propagation, live call/result updates, stable trace placement across a core refresh, snapshot/live deduplication, and unchanged legacy top-level rendering contracts.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec vitest run packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts packages/server/app/api/native-runtime.test.ts packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts packages/desktop/renderer/lib/codex-execution-trace.test.ts packages/desktop/renderer/lib/session-history.test.ts packages/desktop/renderer/components/CodexExecutionTrace.test.tsx packages/desktop/renderer/components/ToolCallCard.test.tsx packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
