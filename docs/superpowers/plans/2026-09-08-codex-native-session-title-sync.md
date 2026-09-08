# Codex Native Session Title Sync Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize the first non-empty AgentRoam message title into the native Codex thread name so Codex Desktop no longer shows newly created WebApp sessions as `新会话`.

**Architecture:** The broker remains the owner of the one-time `auto_title_pending` transition. Admission returns the title only when that transition succeeds, then the runtime service routes a best-effort rename through the Codex adapter's official `thread/name/set` protocol before starting the turn.

**Tech Stack:** TypeScript, better-sqlite3 transactions, Codex app-server JSON-RPC, Vitest.

## Global Constraints

- Rename only AgentRoam-created sessions whose persisted `auto_title_pending` marker changes from `1` to `0` on the first non-empty input.
- Do not backfill historical native Codex names.
- A native rename failure must not block message execution or roll back AgentRoam's local display title.
- Customer Agent, Claude Code, and OpenCode behavior must remain unchanged.

---

### Task 1: Runtime Rename Capability

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Produces: `AgentRuntimeAdapter.renameSession?(nativeSessionId: string, title: string): Promise<void>`
- Produces: `UnifiedSessionService.rename(id: string, title: string): Promise<void>`

- [x] **Step 1: Add the optional adapter method**

Add `renameSession?` beside the existing session lifecycle methods so runtimes without a rename protocol need no implementation.

- [x] **Step 2: Implement Codex protocol rename**

Implement `CodexRuntimeAdapter.renameSession` with:

```ts
await this.client.request("thread/name/set", {
  threadId: nativeSessionId,
  name: title,
});
```

- [x] **Step 3: Route unified IDs through the service**

Resolve the adapter and native ID. Throw `OPERATION_NOT_SUPPORTED` only when a caller explicitly asks an adapter without rename support; after success invalidate cached discovery/detail state.

- [x] **Step 4: Add the adapter request test**

Assert one call using the native thread ID and the supplied first-message title.

### Task 2: Atomic First-Message Rename Trigger

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `UnifiedSessionService.rename(id: string, title: string): Promise<void>`
- Produces: broker admission result `{ run: BrokerRunRecord; autoTitle: string | null }`

- [x] **Step 1: Return the consumed title from admission**

Capture `RunResult.changes` from the existing conditional `UPDATE native_runtime_session_title ... WHERE auto_title_pending = 1`. Return `input.message.slice(0, 60)` only when one row changed; otherwise return `null`.

- [x] **Step 2: Synchronize Codex before turn execution**

After admission, call `runtime.rename(sessionId, autoTitle)` only for Codex and only when `autoTitle` is non-null. Catch rename errors locally, then continue to `executeRun`.

- [x] **Step 3: Verify one-time behavior**

Extend the new-placeholder broker test to assert the runtime rename call. Assert empty input, later input, and untracked historical placeholders do not add rename calls.

- [x] **Step 4: Verify failure isolation**

Make the fake runtime reject rename, start a run, and assert the run still emits its normal event while the local list title remains the first message.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx tsc --noEmit \
  -p packages/desktop/tsconfig.json
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx tsc --noEmit \
  -p packages/server/tsconfig.json
```

Expected: both focused test files pass and Desktop/Server TypeScript exit successfully. If a command fails, fix the implementation or test and rerun until it passes.
