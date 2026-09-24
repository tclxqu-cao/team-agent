# Native Queue Admission Single-Flight Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent Broker reconciliation paths from starting and then failing the same promoted native queue item after a Codex interruption.

**Architecture:** `NativeRuntimeBrokerHost` will keep one in-flight queue-admission record per session, including the queue item ID and its shared result Promise. Same-item callers join that Promise; a different-item caller waits for the current admission, rechecks the authoritative active run, and retries only when the session is still free.

**Tech Stack:** TypeScript, Bun, Vitest, native-runtime Broker SQLite state.

## Global Constraints

- At most one `startRun()` call may be in flight for the same session and queue item.
- Concurrent callers for that item must share the same admission result.
- A real admission or runtime error must keep the existing failed-item behavior.
- Different sessions must remain independently runnable.
- A later queue item in the same session must not reuse an earlier item's admission promise.
- Existing ordinary-message and goal ordering must remain unchanged.
- Do not globally suppress `SESSION_ALREADY_RUNNING`.
- Preserve unrelated worktree changes.

---

### Task 1: Reproduce concurrent admission before state ownership is visible

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts:50-145`
- Unit tests: `packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `FakeNativeRuntime.get()` and public `NativeRuntimeBrokerHost.enqueueMessage()` / `getGoals()` methods.
- Produces: deterministic `getBarrier: Promise<void> | null` and `getCalls: number` test controls plus a regression test for same-item admission.

- [x] **Step 1: Add a deterministic detail-read barrier to the fake runtime**

Add fields and gate `get()` before it returns detail:

```ts
getBarrier: Promise<void> | null = null;
getCalls = 0;

get = async (): Promise<UnifiedSessionDetail> => {
  this.getCalls += 1;
  if (this.getBarrier) await this.getBarrier;
  return {
    ...summary(this.occupancy, this.status),
    messages: this.messages,
    events: [],
  };
};
```

- [x] **Step 2: Add a regression test that opens the pre-admission race window**

Start `enqueueMessage()` while `runtime.get()` is blocked, wait until its first read begins, then call `getGoals()` for the same promoted item. Before releasing the barrier assert `runtime.getCalls === 1`; after release assert one runtime input, one active item, and no failed history:

```ts
let releaseGet: () => void = () => undefined;
runtime.getBarrier = new Promise<void>((resolve) => { releaseGet = resolve; });
const queued = host.enqueueMessage(sessionId, {
  sourceMessageId: "single-flight-message",
  content: "start exactly once",
});
await waitFor(() => expect(runtime.getCalls).toBe(1));
const goals = host.getGoals(sessionId);
await new Promise((resolve) => setTimeout(resolve, 10));
expect(runtime.getCalls).toBe(1);
releaseGet();
await queued;
await goals;
expect(runtime.runInputs.map(({ input }) => input)).toEqual(["start exactly once"]);
expect(await host.getGoals(sessionId)).toMatchObject({
  active: expect.objectContaining({ objective: "start exactly once" }),
  queued: [],
  history: [],
});
```

Complete the fake run and assert the final message queue state is `{ active: null, queued: [], history: [] }`; ordinary messages are intentionally not retained in goal history.

- [x] **Step 3: Cover a different item after a genuine admission failure**

Fail the first gated `runtime.get()` call, enqueue a second goal before releasing the gate, and assert the first goal is recorded as failed while the second performs a fresh detail read and becomes the only native run input. Complete the second run and verify both goal outcomes remain in history.

### Task 2: Serialize queue-item admission per session

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts:1137-1145`
- Modify: `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts:1805-1834`
- Unit tests: `packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `SessionGoal`, `BrokerRunStart`, `NativeRuntimeController`, and the existing `startRun()` / `finishGoal()` contracts.
- Produces: private `queueAdmissions: Map<string, { itemId: string; promise: Promise<BrokerRunStart | undefined> }>` and idempotent `startQueueItem()` admission.

- [x] **Step 1: Add the session-scoped admission registry**

Declare the registry next to `activeExecutions`:

```ts
private readonly queueAdmissions = new Map<
  string,
  { itemId: string; promise: Promise<BrokerRunStart | undefined> }
>();
```

- [x] **Step 2: Join same-item admission and wait on different-item admission**

At the start of `startQueueItem()`, keep the authoritative active-run check, return the existing Promise when `itemId` matches, and for a different item await the existing Promise before rechecking and recursively retrying:

```ts
if (this.state.activeRun(item.sessionId)) return undefined;
const existing = this.queueAdmissions.get(item.sessionId);
if (existing) {
  if (existing.itemId === item.id) return existing.promise;
  await existing.promise;
  if (this.state.activeRun(item.sessionId)) return undefined;
  return this.startQueueItem(item, controller);
}
```

- [x] **Step 3: Make one Promise own the existing start and failure transition**

Wrap the current `startRun()` try/catch in one Promise, store it with the queue item ID, and clean it up by Promise identity:

```ts
const admission = (async () => {
  try {
    return await this.startRun(
      item.sessionId,
      item.objective,
      item.messagePayload?.images,
      controller,
      item.id,
      item.messagePayload?.agentIds,
      item.messagePayload?.agentName,
    );
  } catch (error) {
    logGlobal("error", "native-broker", "goal queue run failed", error, {
      sessionId: item.sessionId,
      goalId: item.id,
    });
    const state = this.state.finishGoal(
      item.sessionId,
      item.id,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    if (state.active) void this.startQueueItem(state.active, controller);
    return undefined;
  }
})();
this.queueAdmissions.set(item.sessionId, { itemId: item.id, promise: admission });
const clearAdmission = () => {
  if (this.queueAdmissions.get(item.sessionId)?.promise === admission) {
    this.queueAdmissions.delete(item.sessionId);
  }
};
void admission.then(clearAdmission, clearAdmission);
return admission;
```

Keep genuine errors visible to the existing failure path. Do not special-case the `SESSION_ALREADY_RUNNING` code.

- [x] **Step 4: Review the resulting diff against the design constraints**

Confirm that all queue start paths still converge on `startQueueItem()`, admission is isolated by session, different item IDs never share a result, and no renderer or direct `startRun()` behavior changed.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts`
Expected: PASS

Run: `bun run --cwd packages/native-runtime build`
Expected: PASS

Run: `git diff --check`
Expected: PASS

If a test fails, fix the implementation or test and rerun the relevant command until it passes. Report the commands and results in the final response.
