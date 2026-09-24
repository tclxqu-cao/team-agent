# Codex Steering And User Interruption Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make queued Codex messages steerable into the active turn, keep accepted steering messages visible in chat history, and treat a user-requested Codex stop as a normal cancellation instead of a failed send.

**Architecture:** Extend `CodexRuntimeAdapter` with the same optional `steer()` contract already used by the broker, backed by Codex app-server `turn/steer`. Track the exact locally interrupted turn so only its interrupted terminal event becomes `done`; unrelated interruptions remain protocol errors. Enable the existing shared queue action for Codex through the renderer capability table.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, React renderer capability helpers, Vitest

## Global Constraints

- Keep durable queued messages until app-server accepts steering.
- Do not change queue ordering, editing, copying, deletion, or automatic draining.
- Do not change Claude Code, OpenCode, or Customer Agent behavior.
- Preserve unexpected interruption errors and failed-send draft recovery.
- Use Node 22 for verification and introduce no new dependency.

---

### Task 1: Codex Mid-Turn Steering

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `activeTurnIds: Map<string, string>` and `UnifiedSessionService.steer?(nativeSessionId, input): Promise<boolean>`
- Produces: `CodexRuntimeAdapter.steer(nativeSessionId: string, input: string): Promise<boolean>`

- [x] **Step 1: Add the Codex steering method**

Read the active turn id, reject blank input or an idle session with `false`, and otherwise send the exact app-server request:

```ts
await this.client.request("turn/steer", {
  threadId: nativeSessionId,
  expectedTurnId: turnId,
  input: [{ type: "text", text: input, text_elements: [] }],
});
```

Return `true` only after the request resolves. Let protocol rejection propagate so the broker retains the durable queue item.

- [x] **Step 2: Add focused steering tests**

Cover the active-turn request payload, idle/blank `false` behavior without a request, and a rejected steer that leaves the active run open for a later terminal event.

### Task 2: User-Requested Codex Cancellation

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: active thread/turn notification state and `abort(nativeSessionId: string): Promise<void>`
- Produces: a turn-id-scoped local interruption marker and normal `{ type: "done", finalText }` cancellation terminal event

- [x] **Step 1: Track the exact locally interrupted turn**

Set a thread-to-turn marker before issuing `turn/interrupt`. Remove it when that interrupt request rejects, on every matching terminal path, and in run cleanup so it cannot suppress a later external interruption.

- [x] **Step 2: Normalize only the matching interrupted terminal**

When `turn/completed` reports `status: "interrupted"`, emit `done` with `lastCodexAgentText(turn.items)` only when the marker matches that exact turn. Keep the current `NATIVE_PROTOCOL_ERROR` for an unmarked interrupted completion or standalone interruption notification.

- [x] **Step 3: Add cancellation boundary tests**

Prove that a successful local abort followed by interrupted completion emits one normal `done` and no error, while unexpected interruption and rejected interrupt requests still emit the existing protocol error.

- [x] **Step 4: Keep Codex terminal state authoritative**

Do not let the broker's generic three-second abort fallback append `Native turn was interrupted before the runtime confirmed completion.` for Codex. Codex remains active until its adapter supplies the actual terminal event, so a follow-up can remain durably queued instead of racing a still-stopping adapter. Preserve the existing fallback for other native runtimes and add a broker regression test for both boundaries.

- [x] **Step 5: Bound accepted Codex interruption settling**

After app-server accepts `turn/interrupt`, start a turn-scoped three-second confirmation timer in the adapter. If no terminal event arrives, emit normal `done`, release the run, and ignore any late terminal event for that old turn without affecting a newer turn.

### Task 3: Shared Renderer Capability And Stop Settling

**Files:**
- Modify: `packages/desktop/renderer/lib/runtime-capabilities.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/lib/runtime-capabilities.test.ts`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `supportsMidTurnSteering(agentType)` in the shared queued-message renderer
- Produces: `true` for `"codex"` while preserving existing runtime values

- [x] **Step 1: Enable Codex steering**

Add `"codex"` to the runtimes that return `true`; leave OpenCode disabled.

- [x] **Step 2: Update the capability regression test**

Assert that Customer Agent, Claude Code, and Codex support steering, while OpenCode and `undefined` do not.

- [x] **Step 3: Keep Codex locally running until its terminal event**

After requesting a Codex stop, invalidate stale history loads but do not optimistically clear `runningSessionId`. This keeps immediate follow-up submissions on the durable queue path, where the existing queue row can expose the steer action, until `done`, `error`, or `turn_aborted` authoritatively ends the run. Preserve immediate local clearing for every non-Codex runtime.

- [x] **Step 4: Update the abort-state regression test**

Assert that the Codex branch retains local running state while the non-Codex branch still clears it, and that selected-session loads remain generation-invalidated before either branch changes presentation state.

### Task 4: Reconcile Delayed Codex Cancellation

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `thread/read { threadId, includeTurns: true }`, the locally interrupted turn id, and the active run event queue
- Produces: 30-second authoritative reconciliation, one repeated interrupt for an active turn, and recoverable `CANCEL_CONFIRMATION_TIMEOUT` at 60 seconds

- [x] **Step 1: Replace the direct timeout with a two-stage confirmation state**

Track the exact turn id and timer stage for each interrupted thread. Schedule reconciliation 30 seconds after an accepted `turn/interrupt`; clear the state only when the matching turn reaches a terminal state, the initial interrupt is rejected, or run cleanup executes.

- [x] **Step 2: Reconcile the turn and retry one interrupt**

At 30 seconds request:

```ts
const response = await this.client.request<{ thread: CodexThread }>("thread/read", {
  threadId,
  includeTurns: true,
});
```

If the exact turn is terminal, settle from that state. If it remains active, send one more `turn/interrupt` for the same id. Keep a matching live notification authoritative during the request and schedule the final deadline only while the same turn remains pending.

- [x] **Step 3: Emit a recoverable timeout at 60 seconds**

When the exact interruption is still pending at the final deadline, emit:

```ts
{
  type: "error",
  code: "CANCEL_CONFIRMATION_TIMEOUT",
  message: "停止确认超时；Codex 可能仍在结束当前任务。请重试停止或释放会话。",
}
```

Close the local queue so broker ownership is released. Do not synthesize `done`; native history remains authoritative for content that arrives later.

- [x] **Step 4: Keep timeout errors out of failed-send recovery**

In `ChatView`, exclude `CANCEL_CONFIRMATION_TIMEOUT` from the native error branch that writes the previous input back to the session draft, and do not mark the submitted user message as `failed`. Continue rendering the timeout message so the user can retry stop or release the session.

- [x] **Step 5: Add focused timer and renderer tests**

Use fake timers to prove terminal delivery before 30 seconds wins, active reconciliation sends exactly one second interrupt, a terminal event during reconciliation wins, and 60 seconds emits the dedicated timeout. Extend the ChatView source regression to prove that timeout code bypasses both draft restoration and failed-send marking.

- [x] **Step 6: Pause queue draining while native cancellation remains unconfirmed**

When the broker records `CANCEL_CONFIRMATION_TIMEOUT`, retain queued messages without automatically starting the next item. On a later enqueue/start attempt, read the native session summary: keep the queue paused while its status is `running`, or clear the pause and resume normal admission once Codex reports a terminal/idle state. Explicit release clears the pause through the existing release boundary.

### Task 5: Preserve Accepted Steering Messages In Chat History

**Files:**
- Modify: `packages/desktop/renderer/lib/queued-message-order.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/lib/queued-message-order.test.ts`

**Interfaces:**
- Consumes: the optimistic user message identified by `sourceMessageId` after `steerSessionMessage(...)` resolves successfully
- Produces: `markDurableMessageSteered<T>(messages: T[], messageId: string): T[]`, which clears queue-only state and marks the accepted message as visible steering history

- [x] **Step 1: Add the pure accepted-steering state transition**

Extend `DurableQueuedMessageLike` with `isSteered?: boolean`, then add:

```ts
export function markDurableMessageSteered<T extends DurableQueuedMessageLike>(
  messages: T[],
  messageId: string,
): T[] {
  return messages.map((message) => message.id === messageId
    ? {
        ...message,
        isQueued: false,
        isSteered: true,
        queueItemId: undefined,
        sendState: undefined,
      }
    : message);
}
```

- [x] **Step 2: Apply the transition before queue reconciliation**

After `steerSessionMessage(...)` resolves, update the source message with `markDurableMessageSteered([message], message.id)[0]` before passing the authoritative returned queue state to `applySessionQueueState(...)`. A rejected steer must leave the original queued message unchanged.

- [x] **Step 3: Add the visibility regression**

Test that an accepted durable queued message becomes `isQueued: false`, `isSteered: true`, clears `queueItemId` and `sendState`, remains in `reconcileDurableQueuedMessages(...)` when the returned queue is empty, and preserves unrelated messages by reference.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts packages/desktop/renderer/lib/runtime-capabilities.test.ts packages/desktop/renderer/lib/queued-message-order.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/native-runtime build
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec -- tsc -p packages/desktop/tsconfig.json --noEmit
git diff --check
```

Expected: all focused tests, the native-runtime build, Desktop type checking, and diff validation pass.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
