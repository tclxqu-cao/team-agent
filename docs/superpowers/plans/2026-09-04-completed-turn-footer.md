# Completed Turn Footer Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible completed-turn footer whose authoritative total duration survives reloads and process restarts.

**Architecture:** Carry optional `durationMs` on successful terminal events and persist it as `MessagePresentation.completionDurationMs`. Customer Agent sessions use the existing message presentation JSON; native sessions use a compact broker table and strict ordered content matching during history projection. The shared renderer classifies final responses and renders platform-specific actions.

**Tech Stack:** TypeScript, React, Zustand, SQLite/better-sqlite3, Vitest, Electron, Next.js, Vite.

## Global Constraints

- Render `已完成 · 总耗时 N 秒` only for final successful assistant responses; legacy rows without duration render `已完成`.
- Copy is always visible on Desktop and WebApp; speech remains Desktop-only.
- Never infer duration from renderer timestamps, browser storage, or native message timestamps.
- Failed, aborted, ambiguous, and invalid-duration cases must not fabricate completion duration.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Shared Completion Contract and Policy

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/core/src/domain/agent/entities.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/lib/message-actions.ts`
- Unit tests: `packages/desktop/renderer/lib/message-actions.test.ts`

**Interfaces:**
- Produces: `MessagePresentation.completionDurationMs?: number`
- Produces: successful `AgentEvent` field `durationMs?: number`
- Produces: `completedAssistantMessagePatch(messages, durationMs)` for immutable live-message annotation.

- [x] **Step 1: Extend shared contracts**

```ts
export interface MessagePresentation {
  rawContent?: string;
  attachments?: MessageAttachment[];
  reasoning?: ReasoningSummarySection[];
  completionDurationMs?: number;
}

| { type: "done"; finalText: string; usage?: TokenUsage; durationMs?: number }
```

- [x] **Step 2: Add validation and formatting helpers to message-actions**

```ts
export function validCompletionDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formatCompletionDuration(value: unknown): string | undefined {
  const durationMs = validCompletionDurationMs(value);
  return durationMs === undefined ? undefined : `${Math.round(durationMs / 1000)} 秒`;
}
```

- [x] **Step 3: Add a store helper that annotates the latest final text message**

Update the latest non-compaction assistant with non-empty text and no tool calls by merging `presentation.completionDurationMs`. Do not add a message when no eligible assistant exists.

- [x] **Step 4: Test final-message policy, invalid values, rounding, and immutable annotation**

```ts
expect(formatCompletionDuration(34_499)).toBe("34 秒");
expect(formatCompletionDuration(Number.NaN)).toBeUndefined();
```

### Task 2: Customer Agent Duration Persistence

**Files:**
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/desktop/main/agent-host.ts`
- Unit tests: `packages/server/app/api/agent-host.test.ts`
- Unit tests: `packages/desktop/main/agent-host-run-state.test.ts`

**Interfaces:**
- Consumes: `AgentEvent.done.durationMs`
- Consumes: `MessagePresentation.completionDurationMs`
- Produces: persisted assistant messages and emitted done events with the same authoritative duration.

- [x] **Step 1: Capture a monotonic start at run admission**

```ts
const startedAt = performance.now();
```

- [x] **Step 2: Enrich successful done events once**

```ts
const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
const completedEvent = { ...event, durationMs };
```

Persist the final assistant with `presentation: { completionDurationMs: durationMs }`, store the enriched event, and emit that same event. Do not annotate in-band error or thrown-error paths.

- [x] **Step 3: Preserve completion metadata during server event-to-message reprojection**

When `projectMessagesFromEvents()` handles `done`, attach valid `event.durationMs` to the final projected assistant message so the post-run `replaceMessages()` call cannot erase it.

- [x] **Step 4: Test persistence and error behavior**

Verify the assistant message and emitted/stored done event share the duration, store reconstruction retains it, and failures omit it.

### Task 3: Native Broker Completion Persistence and Projection

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `BrokerRunRecord.createdAt`, successful `AgentEvent.done.finalText`
- Produces: durable `native_runtime_turn_completion` rows and projected `MessagePresentation.completionDurationMs`.

- [x] **Step 1: Add the compact SQLite table and row type**

```sql
CREATE TABLE IF NOT EXISTS native_runtime_turn_completion (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  final_text TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
)
```

- [x] **Step 2: Make successful terminalization atomic and idempotent**

At one injected `now()` timestamp, calculate `Math.max(0, terminalAt - run.createdAt)`, enrich the stored event, terminalize the run, and `INSERT OR IGNORE` the compact record in the append transaction. Error terminalization does not insert a completion row.

- [x] **Step 3: Strictly project completion rows onto native history**

Load rows by `(completed_at, run_id)` and find an ordered unique mapping of exact adapter-visible user input and final assistant text. Attach duration only to uniquely mapped final text messages. If zero or multiple ordered mappings exist for affected duplicate turns, omit their durations.

- [x] **Step 4: Remove completion rows when native sessions are hidden**

Delete by `session_id` inside the existing hide transaction. Ten-minute run/event pruning must leave completion rows intact.

- [x] **Step 5: Test reconstruction, pruning, matching, ambiguity, and failure paths**

Use the broker's injected clock to assert exact durations. Recreate the broker on the same temporary directory and confirm the projection remains. Include identical external turns and require duration omission when the mapping is ambiguous.

### Task 4: Shared Completed Footer

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/webapp/src/presentation/web.css`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`
- Unit tests: `packages/desktop/renderer/lib/message-actions.test.ts`

**Interfaces:**
- Consumes: `MessagePresentation.completionDurationMs`
- Consumes: `formatCompletionDuration()` and `isFinalAssistantResponse()`
- Produces: `.msg-completion-footer` with status, duration, copy, and optional Desktop speech.

- [x] **Step 1: Apply live done duration before clearing run state**

```ts
case "done":
  annotateLatestAssistantCompletion(event.durationMs, eventSid);
```

- [x] **Step 2: Render the final response footer**

Use Lucide `Check` plus `已完成`; add `· 总耗时 ${formatted}` when valid. Render copy for all final responses. Render speech only when `!isWebShell()` and the bridge function exists.

- [x] **Step 3: Make the completed footer permanently visible**

Scope the current hover-opacity CSS to non-completion action rows. Give the completed footer stable height, compact spacing, muted status text, and responsive wrapping without overlap.

- [x] **Step 4: Preserve user-message actions and goal markers**

Keep existing action rendering for user copy and goal markers outside the completed status footer.

- [x] **Step 5: Add structural and CSS regression tests**

Assert the completion copy and duration text, WebApp speech exclusion, Desktop speech inclusion, permanent opacity, and unaffected intermediate rows.

### Task 5: Integration Verification

**Files:**
- Modify only implementation or focused test files needed to fix failures.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: a passing cross-layer completed-turn workflow.

- [x] **Step 1: Run focused tests once development is complete**

```bash
bunx vitest run packages/desktop/renderer/lib/message-actions.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/server/app/api/agent-host.test.ts packages/desktop/main/agent-host-run-state.test.ts
```

- [x] **Step 2: Run affected type checks and builds**

```bash
bun run --cwd packages/core build
bun run --cwd packages/webapp typecheck
bun run --cwd packages/desktop build
```

- [x] **Step 3: Run whitespace validation**

```bash
git diff --check
```

- [x] **Step 4: Visually verify with the required browser workflow**

Build and serve the WebApp, then use `ego-browser` at desktop and mobile widths to verify a new completed turn and the persisted footer after reload.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/lib/message-actions.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/server/app/api/agent-host.test.ts packages/desktop/main/agent-host-run-state.test.ts
```

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
