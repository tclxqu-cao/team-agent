# Claude Subagent Live Follow Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Claude Code background subagents alive and render their public work live inside the originating `Agent` card in Desktop and Web.

**Architecture:** Extend the shared event protocol with a display-safe `NativeSubagentActivity` projection. The Claude adapter owns SDK task lifecycle and transcript normalization, broker/SSE forward full replacement events, and the renderer stores them by parent tool-call ID for nested rendering and history recovery.

**Tech Stack:** TypeScript, Claude Agent SDK, React 18, Zustand, Vitest, Electron, Next.js, Vite.

## Global Constraints

- Never expose Claude raw thinking or `thinking_delta` content.
- Do not create top-level AgentRoam sessions for Claude child transcripts.
- Preserve existing Customer Agent `dispatch_agent` behavior and controls.
- Ignore ambient/housekeeping SDK tasks in inline activity.
- Work with the existing dirty files and do not revert unrelated edits.

---

### Task 1: Shared Native Subagent Contract

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/core/src/domain/agent/entities.ts`
- Modify: `packages/core/src/domain/model/index.ts`
- Unit tests: `packages/core/src/domain/agent/native-runtime-events.test.ts`

**Interfaces:**
- Consumes: existing `Message`, `ToolCall`, and `AgentEvent` types.
- Produces: `NativeSubagentActivity` and `{ type: "native_subagent_update"; activity }`.

- [ ] **Step 1: Add the activity projection**

```ts
export interface NativeSubagentActivity {
  taskId: string;
  parentToolCallId: string;
  agentName?: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  isBackgrounded?: boolean;
  spawnDepth?: number;
  summary?: string;
  lastToolName?: string;
  elapsedSeconds?: number;
  toolUses?: number;
  messages: Message[];
}
```

- [ ] **Step 2: Add and export the replacement event**

```ts
| { type: "native_subagent_update"; activity: NativeSubagentActivity }
```

- [ ] **Step 3: Extend the native-event contract test**

Assert that a complete public activity payload is assignable and serializable without raw thinking fields.

### Task 2: Claude SDK Lifecycle And Live Projection

**Files:**
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: Claude `task_started`, `task_progress`, `task_updated`, `task_notification`, child assistant/user messages, and `parent_tool_use_id`.
- Produces: idempotent `native_subagent_update` events.

- [ ] **Step 1: Enable the SDK output needed by the projection**

```ts
includePartialMessages: true,
forwardSubagentText: true,
agentProgressSummaries: true,
```

- [ ] **Step 2: Implement a run-scoped projection reducer**

Add a focused `ClaudeSubagentTracker` with:

```ts
consume(message: SDKMessage): AgentEvent[];
hasActiveBackgroundTasks(): boolean;
stopActive(): AgentEvent[];
```

It registers only non-ambient local-agent tasks, appends public child text/tool calls/results, updates usage/status, and returns a full activity replacement after every visible mutation.

- [ ] **Step 3: Keep the SDK iterator alive after the main result**

Retain the main result, continue consuming while `hasActiveBackgroundTasks()` is true, and emit the final main `done` only after all tracked background tasks settle. If the iterator ends with active tasks, emit `NATIVE_PROTOCOL_ERROR`; on abort, emit stopped projections before cleanup.

- [ ] **Step 4: Keep parent and child frames separate**

Update `claudeSdkMessageToEvents()` so assistant/user/partial frames with `parent_tool_use_id` are consumed only by the tracker and never flattened into the parent timeline. Continue dropping every thinking block and delta.

- [ ] **Step 5: Add lifecycle tests**

Cover delayed notification after main result, active-task premature EOF, task progress summary, child tool result correlation, concurrent parent tool IDs, ambient task exclusion, and thinking rejection.

### Task 3: Claude Subagent History Recovery

**Files:**
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Unit tests: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `listSubagents()`, `getSubagentMessages()`, and `agent-<id>.meta.json`.
- Produces: recovered `native_subagent_update` events on `UnifiedSessionDetail.events`.

- [ ] **Step 1: Load child metadata and transcripts**

For the current parent session, validate metadata JSON, read `toolUseId`, `description`, and `agentType`, normalize child messages through the same public-history functions, and skip malformed children independently.

- [ ] **Step 2: Attach only visible-page children**

Build the current history page first, collect its `Agent` tool-call IDs, and recover only matching activities. Completed transcripts use their final public text as summary; non-terminal persisted transcripts restore as `stopped` unless broker replay later replaces them with `running`.

- [ ] **Step 3: Test recovery**

Use temporary Claude project directories to cover valid metadata, malformed metadata, missing transcript, raw thinking exclusion, and tool-result restoration.

### Task 4: Renderer Store And Agent Card

**Files:**
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `native_subagent_update` activity replacements from history and SSE.
- Produces: a compact, expandable nested activity UI for native Claude `Agent` calls.

- [ ] **Step 1: Store activities by session and parent tool-call ID**

Add `nativeSubagentsBySession`, `applyNativeSubagentActivity()`, `setNativeSubagentActivities()`, and cleanup alongside existing runtime progress. Replacement by key must be idempotent.

- [ ] **Step 2: Restore and stream activity in ChatView**

Reduce `detail.events` into the initial activity map, handle `native_subagent_update` in `handleEvent`, and pass the matching activity to `ToolCallCard`.

- [ ] **Step 3: Render native Agent lifecycle**

Special-case `toolCall.name === "Agent" && activity`. Keep the card running even after the launch tool result, auto-expand when public child messages arrive, render progress/summary plus nested text and tool calls, and omit `dispatch_agent`'s “查看子会话” control.

- [ ] **Step 4: Add focused UI tests and styles**

Assert lifecycle labels, auto-expand behavior, nested tool results, no raw thinking text, no top-level child-session button, and stable empty-running layout.

### Task 5: Broker And Web Transport Verification

**Files:**
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`
- Unit tests: `packages/server/app/api/agent/stream/route.test.ts`
- Unit tests: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: the existing generic `AgentEvent` broker/SSE serialization.
- Produces: verified replay and Web delivery of complete native subagent activities.

- [ ] **Step 1: Add replay and transport fixtures**

Use a `native_subagent_update` payload with nested messages and assert broker snapshot, SSE JSON, and gateway callback preserve it unchanged.

- [ ] **Step 2: Keep transport code unchanged unless a test exposes filtering**

If the generic event path already preserves the payload, add tests only. If a whitelist drops the event, add only the missing discriminator handling.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/domain/agent/native-runtime-events.test.ts \
  packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/stores/agentStore.test.ts \
  packages/desktop/renderer/components/ToolCallCard.test.tsx \
  packages/server/app/api/agent/stream/route.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts
bunx tsc --noEmit -p packages/core/tsconfig.json
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bunx tsc --noEmit -p packages/webapp/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
bun run --cwd packages/webapp build
bun run --cwd packages/desktop build
```

Expected: all focused tests, type checks, and builds pass. Fix implementation or tests and rerun failures until green.
