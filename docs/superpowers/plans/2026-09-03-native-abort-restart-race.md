# Native Abort Restart Race Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an immediate post-interrupt Codex send wait for local adapter cleanup instead of being misclassified as external ownership.

**Architecture:** `NativeRuntimeBrokerHost` will track the actual execution promise for each session independently from the durable run terminal state. A new send waits only when the durable run is terminal but the old execution is still settling; genuine duplicate sends still fail through the existing durable admission lock.

**Tech Stack:** TypeScript, async iterables, Vitest, SQLite-backed native runtime broker

## Global Constraints

- Preserve the existing strict external Codex writer-lock policy and app-server PID exclusion.
- Preserve immediate `SESSION_OCCUPIED` rejection while a durable broker run is active.
- Do not change renderer retry behavior or native runtime protocol error codes.
- Keep all unrelated dirty-worktree changes intact.

---

### Task 1: Broker Execution Lifecycle Tracking

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `NativeRuntimeBrokerState.activeRun(sessionId): BrokerRunRecord | null` and `NativeRuntimeBrokerHost.executeRun(run, images): Promise<void>`
- Produces: a private `Map<string, Promise<void>>` keyed by unified session ID and a tracked execution cleanup boundary used by `startRun`

- [x] **Step 1: Inspect the existing admission and terminal ordering**

Read: `NativeRuntimeBrokerHost.startRun`, `NativeRuntimeBrokerHost.executeRun`, and `NativeRuntimeBrokerState.appendEvent`.

Confirm: terminal events finalize the durable run before the adapter async generator completes its `finally` block.

- [x] **Step 2: Track each execution promise by session**

Replace the fire-and-forget call with promise tracking whose cleanup checks identity:

```ts
const execution = this.executeRun(run, images);
this.activeExecutions.set(sessionId, execution);
void execution.finally(() => {
  if (this.activeExecutions.get(sessionId) === execution) {
    this.activeExecutions.delete(sessionId);
  }
});
```

- [x] **Step 3: Wait only for terminal-run cleanup overlap**

At the beginning of `startRun`, preserve normal duplicate rejection, but await a tracked execution when the durable run has already reached terminal state:

```ts
const settlingExecution = this.activeExecutions.get(sessionId);
if (settlingExecution && !this.state.activeRun(sessionId)) {
  await settlingExecution;
}
```

Then run the existing native occupancy preflight and durable admission unchanged.

- [x] **Step 4: Add the interrupt/restart race regression**

Add a controllable fake runtime that yields an interrupted terminal error, pauses in generator cleanup, and rejects overlapping adapter starts. Assert the second `startRun` remains pending until cleanup is released, then succeeds and retains `owned-by-customer-agent` rather than `owned-externally`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
