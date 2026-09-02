# Native Runtime Reasoning Summary And Progress Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show public Codex reasoning summaries and safe Claude/Codex runtime progress in Web and Desktop native sessions without exposing raw chain-of-thought.

**Architecture:** Extend the shared `AgentEvent` and `MessagePresentation` contracts with normalized reasoning-summary and progress data. Runtime adapters own native protocol allowlists, the broker replays normalized events and projects summaries, and the renderer reduces replaceable progress separately from durable messages.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Claude Agent SDK, Codex app-server JSON-RPC, SQLite broker, Next.js SSE, Electron IPC.

## Global Constraints

- Never map Claude `thinking` blocks, streaming `thinking_delta`, or Codex `item/reasoning/textDelta` into shared events or UI.
- Codex reasoning summaries persist through native history; runtime progress remains transient conversation state.
- Repeated progress with the same `progressId` replaces the previous value and does not append DOM/message rows.
- Preserve the existing broker run-id plus sequence deduplication, approval lifecycle, and occupancy behavior.
- Do not refactor unrelated message, session, permission, or broker behavior.

---

### Task 1: Shared Event And Presentation Contracts

**Files:**
- Modify: `packages/core/src/domain/agent/entities.ts`
- Modify: `packages/core/src/domain/agent/index.ts`
- Create: `packages/core/src/domain/agent/native-runtime-events.ts`
- Create: `packages/core/src/domain/agent/native-runtime-events.test.ts`
- Modify: `packages/core/src/domain/model/entities.ts`

**Interfaces:**
- Consumes: existing `AgentEvent`, `MessagePresentation`, and model `Message` contracts.
- Produces: `ReasoningSummarySection`, `RuntimeProgress`, `reasoning_summary_delta`, `runtime_progress`, `mergeReasoningSummaryDelta()`, and `reduceRuntimeProgress()`.

- [x] **Step 1: Extend the shared event union**

Add these exported shapes and include them in `AgentEventType` and `AgentEvent`:

```ts
export interface ReasoningSummarySection {
  itemId: string;
  sectionIndex: number;
  text: string;
}

export interface RuntimeProgress {
  progressId: string;
  phase: "thinking" | "tool" | "retry" | "status";
  label: string;
  detail?: string;
  toolCallId?: string;
  elapsedSeconds?: number;
  current?: number;
  total?: number;
}

| { type: "reasoning_summary_delta"; itemId: string; sectionIndex: number; delta: string }
| ({ type: "runtime_progress" } & RuntimeProgress)
```

- [x] **Step 2: Extend display-only message presentation**

Add `reasoning?: ReasoningSummarySection[]` to `MessagePresentation`. Import the type from the agent domain as a type-only import so no runtime cycle is introduced.

- [x] **Step 3: Implement pure merge and reduction helpers**

```ts
export function mergeReasoningSummaryDelta(
  sections: ReasoningSummarySection[] | undefined,
  event: Extract<AgentEvent, { type: "reasoning_summary_delta" }>,
): ReasoningSummarySection[];

export function reduceRuntimeProgress(
  events: AgentEvent[],
): RuntimeProgress[];
```

The summary helper concatenates by `itemId + sectionIndex` and returns sections sorted by section index without mutating the input. The progress reducer replaces by `progressId` and clears all progress on `done`, `turn_aborted`, or `error`.

- [x] **Step 4: Add focused helper tests and exports**

Cover append, out-of-order section sorting, immutable input, progress replacement, independent progress ids, and terminal clearing. Export helpers/types from `packages/core/src/domain/agent/index.ts` and the package root path already used by `@agent/core`.

### Task 2: Native Runtime Protocol Mapping

**Files:**
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: normalized events from Task 1 and native SDK/app-server message shapes.
- Produces: safe normalized event streams and Codex native-history reasoning presentation.

- [x] **Step 1: Map Claude public progress messages**

Extend `claudeSdkMessageToEvents()` with allowlisted branches:

```ts
thinking_tokens -> {
  type: "runtime_progress",
  progressId: "claude:thinking",
  phase: "thinking",
  label: "正在思考",
  current: estimated_tokens,
  detail: `${estimated_tokens.toLocaleString()} tokens`,
}

tool_progress -> {
  type: "runtime_progress",
  progressId: `claude:tool:${tool_use_id}`,
  phase: "tool",
  label: public tool label,
  toolCallId: tool_use_id,
  elapsedSeconds: elapsed_time_seconds,
}
```

Map retry and public informational/status messages only when their documented public text/count fields are valid. Keep unknown messages ignored.

- [x] **Step 2: Prove Claude private thinking remains blocked**

Add tests where assistant content contains `thinking`, stream delta contains `thinking_delta`, and system messages lack public text. Assert no summary or text event is emitted. Add positive tests for thinking tokens, tool elapsed time, retry counts, and public informational status.

- [x] **Step 3: Map Codex public reasoning summaries**

In `handleNotification()` map:

```ts
"item/reasoning/summaryTextDelta" -> {
  type: "reasoning_summary_delta",
  itemId: params.itemId,
  sectionIndex: params.summaryIndex,
  delta: params.delta,
}
```

Accept `summaryPartAdded` as an empty boundary event only with valid ids/indexes. Explicitly return without an event for `item/reasoning/textDelta`.

- [x] **Step 4: Restore Codex summary history without raw content**

When `codexTurnsToMessages()` sees a `reasoning` item, map each nonempty string in `item.summary` to `MessagePresentation.reasoning`. Ignore `item.content`. Emit one assistant presentation message per reasoning item so ordering relative to tools and assistant text remains intact.

- [x] **Step 5: Add Codex mapping and history tests**

Cover delta, section boundary, malformed fields, raw text rejection, summary-only history restoration, and a reasoning/tool/final-text ordering fixture.

### Task 3: Broker Projection And Reconnect State

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `mergeReasoningSummaryDelta()` and `reduceRuntimeProgress()` from Task 1.
- Produces: live detail snapshots containing projected summary messages plus replayable normalized progress events.

- [x] **Step 1: Project reasoning deltas into live messages**

Extend `mergeProjectionMessages()` so a `reasoning_summary_delta` creates or updates a run-scoped assistant message with `presentation.reasoning`. Use stable identity derived from the native `itemId`, preserve event order relative to tools/text, and merge through the shared helper.

- [x] **Step 2: Keep progress in events, not messages**

Do not create projection messages for `runtime_progress`. Keep the stored broker event and sequence unchanged so snapshots/SSE/Desktop replay work. Verify terminal events remain authoritative and no progress branch alters locks or approvals.

- [x] **Step 3: Add broker recovery tests**

Assert reconnect detail contains merged reasoning exactly once, retains the latest progress events for renderer reduction, clears reducer output on terminal events, and preserves existing approval/occupancy behavior.

### Task 4: Renderer State And Components

**Files:**
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Create: `packages/desktop/renderer/components/ReasoningSummary.tsx`
- Create: `packages/desktop/renderer/components/RuntimeProgressRow.tsx`
- Create: `packages/desktop/renderer/lib/native-runtime-progress.ts`
- Create: `packages/desktop/renderer/lib/native-runtime-progress.test.ts`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: normalized stream fields and `MessagePresentation.reasoning` from Tasks 1-3.
- Produces: per-session replaceable progress state, collapsible reasoning UI, and tool-associated elapsed status.

- [x] **Step 1: Add session-scoped progress state**

Store `runtimeProgressBySession: Record<string, RuntimeProgress[]>` with `applyRuntimeProgress(event, sessionId)` and `clearRuntimeProgress(sessionId)`. Replace by `progressId`; do not add a `ChatMessage`.

- [x] **Step 2: Add reasoning delta handling**

On `reasoning_summary_delta`, update or create a stable assistant message whose `presentation.reasoning` is merged by the shared helper. Apply the existing broker sequence dedupe before this branch.

- [x] **Step 3: Add normalized progress handling**

On `runtime_progress`, update session progress and set activity to thinking/tools from `phase`. On `done`, `turn_aborted`, and non-preserved `error`, clear it. During history restore, reduce `detail.events` so a refreshed active run immediately shows the latest state.

- [x] **Step 4: Render the reasoning summary component**

`ReasoningSummary` renders an unframed disclosure labeled `思考摘要`, expanded while streaming and collapsed for restored/completed messages. It sorts sections, joins their safe Markdown output, supports keyboard disclosure, and renders nothing for empty sections.

- [x] **Step 5: Render global and tool progress**

`RuntimeProgressRow` uses one stable-height row with spinner, label, detail, and a throttled `aria-live="polite"` string. `ChatView` passes matching `toolCallId` progress into `ToolCallCard`; unmatched latest progress uses the global row. Extend the tool-call presentation props with optional progress label and elapsed seconds.

- [x] **Step 6: Add reducer and source-contract tests**

Test replacement without message-count growth, tool association, terminal clearing, restored collapse state, reasoning dedupe, and accessible labels. Preserve the existing compact tool-row grouping behavior.

### Task 5: Transport Compatibility And Production Release

**Files:**
- Modify only if type coverage requires it: `packages/desktop/renderer/stores/agentStore.ts`
- Verify: `packages/server/app/api/agent/stream/route.ts`
- Verify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes: normalized `AgentEvent` variants.
- Produces: unchanged JSON event envelopes over Web SSE and Electron IPC.

- [x] **Step 1: Verify transport pass-through**

Confirm SSE still serializes `{ ...event, _nativeRunId, _nativeSequence }` and Electron forwards the same event object. Add route or IPC tests only if existing structural coverage does not exercise arbitrary union variants.

- [x] **Step 2: Run type checks and production builds**

Run core/desktop/webapp/server type checks and builds using the repository scripts. Fix implementation errors without changing the approved event boundary.

- [x] **Step 3: Release to port 3000**

Follow `customer-agent-webapp-release`: record current PID/job, move `.next` to a timestamped rollback directory, build the server with safe-delete disabled using Node 22 when Bun ABI loading conflicts, instantiate `better-sqlite3` from `packages/core` to verify ABI 127, and `launchctl kickstart -k` the existing job.

- [x] **Step 4: Verify the running service**

Confirm port 3000 listens, `/web`, `/api/agent/runtime-health`, and `/api/sessions` return 200, the launchd job retains keepalive, and three PID samples remain stable.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/domain/agent/native-runtime-events.test.ts \
  packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/lib/native-runtime-progress.test.ts
```

Expected: all focused tests pass. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
