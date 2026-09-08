# Codex Session Consistency And Streaming Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one ordered, lossless, duplicate-free Codex timeline for WebApp-created, externally viewed Desktop, and forked sessions while preserving core-first pagination and lazy tool results.

**Architecture:** Treat adapter-native `core` and `trace` responses as complete progressive snapshots and use the Broker projection only for `legacy-full`. Reconcile snapshot and SSE data with stable native identities and run-local monotonic cursors; keep historical trace and tool bodies lazy.

**Tech Stack:** TypeScript, React 18, Zustand, Next.js route handlers, EventSource/SSE, Vitest, Codex app-server native pagination.

## Global Constraints

- Codex first paint requests only the latest `core` page.
- Historical trace loads only for one selected turn; the latest running turn may auto-load.
- Tool-result bodies load only when an individual tool row is expanded.
- Duplicate identity is native ID based, never global text based.
- SSE sequence is monotonic only within one `runId`.
- Fork is non-idempotent and must be invoked exactly once per recovery.
- Existing Claude Code, OpenCode, and Customer Agent behavior must remain unchanged.

---

### Task 1: Progressive Broker Projection Boundary

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `UnifiedSessionDetail.history.delivery` and `NativeRuntimeState.applyDetail(detail, options)`.
- Produces: progressive details without retained-run projection; unchanged legacy recovery behavior.

- [ ] **Step 1: Gate retained projection by delivery mode**

Use the delivery contract at the native pagination boundary:

```ts
const progressiveDelivery = native.history?.delivery === "core"
  || native.history?.delivery === "trace";
return this.state.applyDetail(native, {
  mergeProjection: !progressiveDelivery && native.history?.newerCursor == null,
});
```

- [ ] **Step 2: Add bounded-response regressions**

Create a running retained projection containing text, a tool call, and a 256
KiB result. Assert both progressive modes return only the adapter messages,
`events` is empty, and the serialized fixture is below 16 KiB.

- [ ] **Step 3: Preserve legacy recovery coverage**

Keep the existing `legacy-full` and fallback tests proving an active retained
run remains visible when native progressive paging is unavailable.

### Task 2: Separate Snapshot Revision From Consumed SSE Cursor

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Unit tests: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Unit tests: `packages/server/app/api/agent/stream/route.test.ts`

**Interfaces:**
- Consumes: progressive delivery metadata plus `{ runId?: string; sequence: number }` from native SSE events.
- Produces: the greatest dispatched sequence for the current run and a correct replay/reconnect URL.

- [ ] **Step 1: Do not mark progressive snapshot events as consumed**

In `getSession`, inspect `session.history.delivery`. For `core` and `trace`, do
not copy `snapshotRevision` into the consumed-event cursor. When the session is
running, keep an existing consumed cursor or open the current run from zero:

```ts
const progressive = session.history?.delivery === "core" || session.history?.delivery === "trace";
const cursor = progressive
  ? this.nativeStreamCursors.get(id) ?? { runId: session.snapshotRunId, sequence: 0 }
  : this.rememberProjectedSnapshot(id, session.snapshotRevision, session.snapshotRunId);
void this.openStream(id, cursor).catch(() => undefined);
```

- [ ] **Step 2: Advance only after accepting SSE delivery**

Before filtering or dispatching a native event, compare it to the current
cursor. Drop an event only when its `runId` matches and its sequence is not
greater. Accept sequence one for a different run, dispatch it, and only then
record it as consumed.

- [ ] **Step 3: Test progressive replay and reconnects**

Return a running `core` response at snapshot sequence 7 with no events and
assert the first stream uses `afterRunId=<run>&afterSequence=0`. Dispatch
sequences through 7, reconnect, and assert the new stream resumes after 7.
Also assert a new run at sequence 1 is delivered and the server route replays
from zero when the query cursor belongs to another run.

### Task 3: Ordered Snapshot And Live Trace Reconciliation

**Files:**
- Modify: `packages/desktop/renderer/lib/codex-execution-trace.ts`
- Unit tests: `packages/desktop/renderer/lib/codex-execution-trace.test.ts`
- Unit tests: `packages/desktop/renderer/lib/session-history.test.ts`

**Interfaces:**
- Consumes: rollout-ordered history messages and SSE-ordered live messages.
- Produces: `mergeCodexExecutionMessages(history, live): ChatMessage[]` with one logical item per native identity.

- [ ] **Step 1: Define stable execution identities**

Add a helper that returns the commentary ID, reasoning item/section keys, and
tool-call IDs carried by each execution message. Do not use content as the
identity except for the existing no-item-ID commentary prefix compatibility.

```ts
function executionKeys(message: ChatMessage): string[] {
  return [
    ...(message.presentation?.agentMessagePhase === "commentary" ? [`agent:${message.id}`] : []),
    ...(message.presentation?.reasoning ?? []).map((item) => `reasoning:${item.itemId}:${item.sectionIndex}`),
    ...(message.toolCalls ?? []).map((tool) => `tool:${tool.id}`),
  ];
}
```

- [ ] **Step 2: Merge content without moving anchored items**

Use shared identities as anchors between the two ordered lists. Overlay longer
commentary, reasoning sections, and tool result metadata onto the anchored
message. Insert unmatched history in persisted order and unmatched live items
in live order around those anchors. With no anchors, return history followed by
live.

- [ ] **Step 3: Add ordering and duplicate regressions**

Cover `live commentary -> live tool`, followed by a snapshot containing only
the tool, and assert the merged order remains commentary then tool. Cover a
snapshot call/result plus the repeated live call/result and assert one tool
with one result. Cover two identical texts with different item IDs and assert
both remain.

### Task 4: Core Refresh, Pagination, And Flow Contracts

**Files:**
- Unit tests: `packages/desktop/renderer/lib/session-history.test.ts`
- Unit tests: `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`
- Unit tests: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`
- Unit tests: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Unit tests: `packages/server/app/api/native-runtime.test.ts`

**Interfaces:**
- Consumes: progressive core refresh, latest-turn trace refresh, native run admission, and fork recovery.
- Produces: executable contract evidence for all three user flows.

- [ ] **Step 1: Verify core refresh retains live trace once**

Create current messages with a live trace and refresh them with a core page for
the same turn. Assert the trace locator revision updates, `liveMessages` stays
attached once, and no tool appears as a top-level duplicate.

- [ ] **Step 2: Verify old-page and first-paint boundaries**

Assert mounting an untouched historical trace issues no request, older-page
prepend preserves the current tail, and `core` responses contain no execution
events or tool-result body.

- [ ] **Step 3: Verify WebApp create and fork streaming reuse**

For native creation/run admission, assert SSE opens at the returned snapshot
cursor and dispatches progressive events. For occupied recovery, retain the
existing contract that one fork ID is selected and retries send to that ID
without another fork call.

- [ ] **Step 4: Verify external Desktop observation**

Assert a selected externally owned running Codex session subscribes to history
changes, refreshes only the core tail, and auto-loads only the latest turn trace.

### Task 5: Production Verification

**Files:**
- Verify: `packages/server/.next/`
- Verify: `packages/webapp/dist/`

**Interfaces:**
- Consumes: the completed source changes and managed `:3000` launchd service.
- Produces: production build, stable service, protocol metrics, and browser acceptance evidence.

- [ ] **Step 1: Run focused Node 22 tests and type checks**

Run the affected Vitest files, Desktop/WebApp/Server TypeScript checks, and
`git diff --check`. Fix product failures; report environment-only failures
separately and rerun them outside the restrictive sandbox when available.

- [ ] **Step 2: Build WebApp and Server**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/webapp build
PATH=/opt/homebrew/opt/node@22/bin:$PATH CODEBUDDY_SAFE_DELETE_ENABLED=0 bun run --cwd packages/server build
```

- [ ] **Step 3: Restart and health-check `:3000`**

Use the managed launchd job, verify `/web`, `/api/agent/runtime-health`, and
`/api/sessions` return 200, then confirm one stable PID across three samples.

- [ ] **Step 4: Run ego-browser acceptance**

Create a new Codex session and observe multiple streamed item types; refresh
during execution; observe a Desktop-started session; create one occupied-session
fork and observe its automatic send. For every case record ordered DOM rows,
duplicate native identities, lost expected events, core/trace request counts,
response bytes, and absence of eager tool-result requests.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec vitest run \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/renderer/lib/codex-execution-trace.test.ts \
  packages/desktop/renderer/lib/session-history.test.ts \
  packages/desktop/renderer/components/CodexExecutionTrace.test.tsx \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/server/app/api/agent/stream/route.test.ts \
  packages/server/app/api/native-runtime.test.ts
```

Expected: all product assertions pass.
