# Session Deletion and Visibility Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every safely removable AgentRoam session a delete action that either deletes Customer Agent data or persistently hides native runtime history from AgentRoam.

**Architecture:** The existing shared renderer keeps one `deleteSession(id)` command. Customer Agent adapters continue deleting from their session store, while native adapters route the command through the durable native runtime broker, which records unified IDs in a SQLite tombstone table and filters them from discovery. The renderer updates its session collections and local index cache only after the command succeeds.

**Tech Stack:** TypeScript, React 18, Electron IPC, Next.js route handlers, better-sqlite3, Vitest.

## Global Constraints

- Customer Agent sessions are permanently deleted; Codex, Claude Code, and OpenCode transcript files are never modified.
- A native visibility tombstone must survive renderer refreshes and broker restarts.
- A session running under AgentRoam control cannot be deleted; an externally owned native session may be hidden.
- Deletion is idempotent and there is no restore UI in this scope.
- Preserve unrelated worktree changes and do not refactor unrelated session behavior.

---

### Task 1: Durable Native Session Hiding

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: unified native session IDs and the broker's existing SQLite state.
- Produces: `NativeRuntimeBrokerClient.delete(id: string): Promise<void>` and `BrokerRuntimeAdapter.delete(nativeSessionId: string): Promise<void>`.

- [x] **Step 1: Add durable hidden-session state**

Add a `native_runtime_hidden_session(session_id TEXT PRIMARY KEY, hidden_at INTEGER NOT NULL)` table and state methods:

```ts
hideSession(sessionId: string): void
isSessionHidden(sessionId: string): boolean
filterHiddenSessions(sessions: UnifiedSessionSummary[]): UnifiedSessionSummary[]
```

`hideSession` must reject `activeRun(sessionId)` with `RuntimeSessionError(..., "SESSION_OCCUPIED")`, insert idempotently, and delete a matching persisted pending session.

- [x] **Step 2: Route delete through broker host and client**

Add host and socket protocol behavior:

```ts
async delete(sessionId: string): Promise<void> {
  this.state.hideSession(sessionId);
  this.pendingCreations.delete(sessionId);
  this.runtime.invalidate(sessionId);
}
```

Filter both `list()` and `refresh()` before returning summaries. Project native summaries as `canDelete: active === null` so externally owned sessions remain eligible while AgentRoam-owned runs do not.

- [x] **Step 3: Expose deletion through native adapter facade**

Add `NativeRuntimeBrokerClient.delete(id)` using the `delete` broker method. Add `BrokerRuntimeAdapter.delete(nativeSessionId)` and re-encode it with `encodeUnifiedSessionId(this.agentType, nativeSessionId)`.

- [x] **Step 4: Add broker persistence and safety tests**

Cover: a hidden discovered session disappears from `list()` and `refresh()`, remains hidden after constructing a replacement host over the same directory, deletion is idempotent, a pending session is removed, and an active AgentRoam run returns `SESSION_OCCUPIED` without hiding the session.

### Task 2: Unified Desktop and Server Delete Routing

**Files:**
- Modify: `packages/desktop/main/agent-runtime/customer-agent-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/app/api/sessions/route.ts`
- Modify: `packages/server/app/api/sessions/[id]/route.ts`
- Unit tests: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Unit tests: `packages/server/lib/native-runtime-service.test.ts`
- Unit tests: `packages/server/app/api/native-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeAdapter.delete?(nativeSessionId: string): Promise<void>` and broker client deletion from Task 1.
- Produces: `NativeRuntimePort.delete(id: string): Promise<void>` and `NativeRuntimeService.delete(id: string): Promise<void>`.

- [x] **Step 1: Make deletability reflect active ownership**

Return `canDelete: !owned` from `CustomerAgentRuntimeAdapter.toSummary()`. In `UnifiedSessionService.delete(id)`, reject IDs in `activeSessionIds`, require an adapter delete implementation, then delegate regardless of agent type and invalidate discovery/detail caches.

- [x] **Step 2: Add the Web application service operation**

Extend `NativeRuntimePort` with:

```ts
delete(id: string): Promise<void>;
```

Implement `NativeRuntimeService.delete(id)` by deleting the pending projection and delegating to the runtime port. Extend test fakes and verify delegation plus pending-session removal.

- [x] **Step 3: Enable the native DELETE route**

Replace the native 405 branch in `DELETE /api/sessions/:id` with `getNativeRuntimeService().delete(params.id)`. Map runtime errors with `runtimeErrorStatus`; return `{ status: "deleted" }` on success.

- [x] **Step 4: Update focused routing tests**

Replace the existing rejection expectations with successful native deletion assertions. Add a `SESSION_OCCUPIED` route case returning HTTP 409, and retain a CA deletion regression.

### Task 3: Shared Renderer Deletion UX and State Cleanup

**Files:**
- Create: `packages/desktop/renderer/lib/session-deletion.ts`
- Create: `packages/desktop/renderer/lib/session-deletion.test.ts`
- Modify: `packages/desktop/renderer/App.tsx`
- Unit tests: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: shared `Session` summaries and `window.agentApi.deleteSession(id)`.
- Produces: `sessionDeletionConfirmation(session)` and `removeSessionFromCollections(state, sessionId)` pure helpers.

- [x] **Step 1: Add pure confirmation and collection helpers**

Create helpers with browser-safe structural types:

```ts
export function sessionDeletionConfirmation(session: { agentType: string; title: string }): string
export function removeSessionFromCollections<T extends { id: string; parentSessionId?: string }>(
  sessionsByProject: Record<string, T[]>,
  childSessionsByParent: Record<string, T[]>,
  otherLocalSessions: T[],
  sessionId: string,
): { sessionsByProject: Record<string, T[]>; childSessionsByParent: Record<string, T[]>; otherLocalSessions: T[]; removedIds: string[] }
```

The helper removes the target plus direct children when deleting a parent, removes an individual child from its parent list, and preserves untouched array/object identities where practical.

- [x] **Step 2: Add helper unit tests**

Verify CA confirmation states permanent deletion; native confirmation states only AgentRoam visibility changes; parent deletion returns parent and child IDs; child deletion preserves siblings; unrelated collections remain unchanged.

- [x] **Step 3: Wire confirmation and immediate renderer cleanup**

Change `handleDeleteSession` to accept the session summary. Call `window.confirm(sessionDeletionConfirmation(session))`, then await the API. On success, apply the pure helper to the three renderer collections, clear selection/todos when `selectedSessionId` is among `removedIds`, remove those IDs from the persisted project session index, show the existing success notice, and refresh the session's owning project in the background.

- [x] **Step 4: Expose the action for all eligible rendered rows**

Keep the existing `session.canDelete` condition for parent and child rows, pass the full session to the handler, and add the same action to global search rows. Ensure action clicks do not select the row.

- [x] **Step 5: Update structural UI tests**

Assert the shared renderer calls the confirmation helper, passes the full session from every delete button, and renders the delete action in project, child, and search result paths.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/main/agent-runtime/unified-session-service.test.ts packages/server/lib/native-runtime-service.test.ts packages/server/app/api/native-runtime.test.ts packages/desktop/renderer/lib/session-deletion.test.ts packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
bun run --cwd packages/webapp typecheck
bunx tsc -p packages/desktop/tsconfig.json --noEmit
bunx tsc -p packages/server/tsconfig.json --noEmit
git diff --check
```

Expected: all tests and type checks pass with no diff whitespace errors.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
